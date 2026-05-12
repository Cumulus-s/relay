// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { decryptString, encryptString, sha256 } from './crypto.js';
import { detectSecretKeys } from './secrets.js';
import { hasScopes, issueToken, issueWorkspaceTokens } from './tokens.js';
import type {
  PublicRecord,
  RecordType,
  SearchHit,
  StoredRecord,
  TokenIssue,
  TokenRecord,
  TokenScope,
  WorkspaceManifest,
} from './types.js';

interface CreateWorkspaceInput {
  ownerAgentId: string;
  humanOwnerEmail?: string | null;
  relaySignupId?: string | null;
}

interface WriteRecordInput {
  type: RecordType;
  key?: string;
  title?: string;
  content?: string | null;
  json?: unknown;
  tags?: string[];
  vector?: number[];
  metadata?: Record<string, unknown>;
  secrets?: Record<string, string>;
  recordIsSecret?: boolean;
}

interface UpsertRecordInput extends Partial<WriteRecordInput> {
  id: string;
}

interface SearchInput {
  query?: string;
  vector?: number[];
  type?: RecordType;
  limit?: number;
}

interface Operation {
  op: 'record_upsert' | 'record_delete';
  record?: StoredRecord;
  id?: string;
  at: string;
}

const ALL_DATA_SCOPES: TokenScope[] = [
  'records:read',
  'records:write',
  'search:read',
  'events:write',
  'kv:read',
  'kv:write',
  'secrets:write',
];

function nowIso(): string {
  return new Date().toISOString();
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('invalid id');
  }
  return id;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path, { flags: 'a' });
    stream.on('error', reject);
    stream.end(`${JSON.stringify(value)}\n`, () => resolve());
  });
}

function publicRecord(record: StoredRecord): PublicRecord {
  return {
    id: record.id,
    dbId: record.dbId,
    type: record.type,
    ...(record.key ? { key: record.key } : {}),
    ...(record.title ? { title: record.title } : {}),
    content: record.secret.contentEncrypted ? '[secret]' : record.content ?? null,
    ...(record.json !== undefined ? { json: record.json } : {}),
    tags: record.tags,
    ...(record.vector ? { vector: record.vector } : {}),
    metadata: record.metadata,
    secret: record.secret,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
  };
}

function normalizeVector(vector: unknown): number[] | undefined {
  if (vector === undefined) return undefined;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('vector must be a non-empty number array');
  }
  const normalized = vector.map((value) => Number(value));
  if (normalized.some((value) => !Number.isFinite(value))) {
    throw new Error('vector must contain finite numbers');
  }
  return normalized;
}

export class CumulusDbEngine {
  constructor(
    private readonly dataDir: string,
    private readonly masterKey: Buffer,
  ) {}

  private workspaceDir(dbId: string): string {
    return join(this.dataDir, 'databases', safeId(dbId));
  }

  private manifestPath(dbId: string): string {
    return join(this.workspaceDir(dbId), 'manifest.json');
  }

  private tokensPath(dbId: string): string {
    return join(this.workspaceDir(dbId), 'tokens.json');
  }

  private walPath(dbId: string): string {
    return join(this.workspaceDir(dbId), 'wal.jsonl');
  }

  private segmentPath(dbId: string, segment: string): string {
    return join(this.workspaceDir(dbId), 'segments', segment);
  }

  private auditPath(dbId: string): string {
    return join(this.workspaceDir(dbId), 'audit.jsonl');
  }

  async ensureRoot(): Promise<void> {
    await mkdir(join(this.dataDir, 'databases'), { recursive: true });
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<{
    manifest: WorkspaceManifest;
    dataToken: TokenIssue;
    adminToken: TokenIssue;
  }> {
    await this.ensureRoot();
    const id = `db_${randomUUID().replace(/-/g, '')}`;
    const createdAt = nowIso();
    const activeSegment = 'segment-000001.jsonl';
    const manifest: WorkspaceManifest = {
      id,
      ownerAgentId: input.ownerAgentId,
      humanOwnerEmail: input.humanOwnerEmail ?? null,
      relaySignupId: input.relaySignupId ?? null,
      createdAt,
      updatedAt: createdAt,
      recordCount: 0,
      deletedCount: 0,
      lastCompactedAt: null,
      activeSegment,
    };
    const tokens = issueWorkspaceTokens();

    await mkdir(join(this.workspaceDir(id), 'segments'), { recursive: true });
    await mkdir(join(this.workspaceDir(id), 'backups'), { recursive: true });
    await atomicWrite(this.manifestPath(id), `${JSON.stringify(manifest, null, 2)}\n`);
    await atomicWrite(this.tokensPath(id), `${JSON.stringify(tokens.records, null, 2)}\n`);
    await atomicWrite(this.walPath(id), '');
    await atomicWrite(this.segmentPath(id, activeSegment), '');
    await appendJsonLine(this.auditPath(id), { action: 'workspace_create', at: createdAt });

    return { manifest, dataToken: tokens.data, adminToken: tokens.admin };
  }

  async listWorkspaces(): Promise<WorkspaceManifest[]> {
    await this.ensureRoot();
    const { readdir } = await import('node:fs/promises');
    const dbRoot = join(this.dataDir, 'databases');
    const entries = await readdir(dbRoot, { withFileTypes: true });
    const manifests: WorkspaceManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      manifests.push(await this.getManifest(entry.name));
    }
    return manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getManifest(dbId: string): Promise<WorkspaceManifest> {
    return readJson<WorkspaceManifest>(this.manifestPath(dbId), null as never);
  }

  async authenticate(dbId: string, token: string, required: TokenScope[]): Promise<TokenRecord> {
    const tokens = await this.readTokens(dbId);
    const hash = sha256(token);
    const match = tokens.find((item) => item.tokenHash === hash && !item.revokedAt);
    if (!match || !hasScopes(match, required)) {
      throw new Error('unauthorized');
    }
    match.lastUsedAt = nowIso();
    await this.writeTokens(dbId, tokens);
    return match;
  }

  async readTokens(dbId: string): Promise<TokenRecord[]> {
    return readJson<TokenRecord[]>(this.tokensPath(dbId), []);
  }

  private async writeTokens(dbId: string, tokens: TokenRecord[]): Promise<void> {
    await atomicWrite(this.tokensPath(dbId), `${JSON.stringify(tokens, null, 2)}\n`);
  }

  async createToken(dbId: string, label: string, scopes: TokenScope[]): Promise<TokenIssue> {
    const tokens = await this.readTokens(dbId);
    const issued = issueToken(label, scopes.length ? scopes : ALL_DATA_SCOPES, 'cdb_data');
    tokens.push(issued.record);
    await this.writeTokens(dbId, tokens);
    await appendJsonLine(this.auditPath(dbId), { action: 'token_create', tokenId: issued.record.id, at: nowIso() });
    return issued.issue;
  }

  async rotateToken(dbId: string, tokenId: string): Promise<TokenIssue> {
    const tokens = await this.readTokens(dbId);
    const current = tokens.find((token) => token.id === tokenId && !token.revokedAt);
    if (!current) throw new Error('token not found');
    current.revokedAt = nowIso();
    const issued = issueToken(current.label, current.scopes, current.scopes.includes('database:admin') ? 'cdb_admin' : 'cdb_data');
    tokens.push(issued.record);
    await this.writeTokens(dbId, tokens);
    await appendJsonLine(this.auditPath(dbId), { action: 'token_rotate', oldTokenId: tokenId, newTokenId: issued.record.id, at: nowIso() });
    return issued.issue;
  }

  async revokeToken(dbId: string, tokenId: string): Promise<void> {
    const tokens = await this.readTokens(dbId);
    const current = tokens.find((token) => token.id === tokenId);
    if (!current) throw new Error('token not found');
    current.revokedAt = current.revokedAt ?? nowIso();
    await this.writeTokens(dbId, tokens);
    await appendJsonLine(this.auditPath(dbId), { action: 'token_revoke', tokenId, at: current.revokedAt });
  }

  async writeRecord(dbId: string, input: WriteRecordInput): Promise<PublicRecord> {
    const manifest = await this.getManifest(dbId);
    const createdAt = nowIso();
    const record = this.buildStoredRecord(dbId, {
      id: randomUUID(),
      ...input,
    }, createdAt, createdAt);
    await this.appendOperation(dbId, { op: 'record_upsert', record, at: createdAt });
    await appendJsonLine(this.segmentPath(dbId, manifest.activeSegment), record);
    await this.updateManifest(dbId, (draft) => {
      draft.recordCount += 1;
      draft.updatedAt = createdAt;
    });
    return publicRecord(record);
  }

  async updateRecord(dbId: string, input: UpsertRecordInput): Promise<PublicRecord> {
    const current = await this.getStoredRecord(dbId, input.id);
    if (!current) throw new Error('record not found');
    const updatedAt = nowIso();
    const merged: WriteRecordInput & { id: string } = {
      id: current.id,
      type: input.type ?? current.type,
      key: input.key ?? current.key,
      title: input.title ?? current.title,
      content: input.content ?? (current.secret.contentEncrypted ? undefined : current.content),
      json: input.json ?? current.json,
      tags: input.tags ?? current.tags,
      vector: input.vector ?? current.vector,
      metadata: { ...current.metadata, ...(input.metadata ?? {}) },
      secrets: input.secrets,
      recordIsSecret: input.recordIsSecret ?? current.secret.recordIsSecret,
    };
    const record = this.buildStoredRecord(dbId, merged, current.createdAt, updatedAt);
    await this.appendOperation(dbId, { op: 'record_upsert', record, at: updatedAt });
    await appendJsonLine(this.segmentPath(dbId, (await this.getManifest(dbId)).activeSegment), record);
    await this.updateManifest(dbId, (draft) => {
      draft.updatedAt = updatedAt;
    });
    return publicRecord(record);
  }

  private buildStoredRecord(
    dbId: string,
    input: WriteRecordInput & { id: string },
    createdAt: string,
    updatedAt: string,
  ): StoredRecord {
    const tags = [...new Set((input.tags ?? []).map((tag) => String(tag).trim()).filter(Boolean))];
    const secretValues = input.secrets ?? {};
    const secretScan = detectSecretKeys({
      ...secretValues,
      ...(input.json && typeof input.json === 'object' && !Array.isArray(input.json)
        ? (input.json as Record<string, unknown>)
        : {}),
      ...(input.key ? { [input.key]: input.content ?? '' } : {}),
    });
    const recordIsSecret = Boolean(input.recordIsSecret);
    const content = input.content ?? null;
    const secretFieldsEnc = Object.fromEntries(
      Object.entries(secretValues).map(([key, value]) => [
        key,
        encryptString(String(value), this.masterKey),
      ]),
    );

    return {
      id: input.id,
      dbId,
      type: input.type,
      ...(input.key ? { key: input.key } : {}),
      ...(input.title ? { title: input.title } : {}),
      content: recordIsSecret && content !== null ? null : content,
      ...(recordIsSecret && content !== null
        ? { contentEnc: encryptString(content, this.masterKey) }
        : {}),
      ...(input.json !== undefined ? { json: input.json } : {}),
      tags,
      ...(input.vector ? { vector: normalizeVector(input.vector) } : {}),
      metadata: input.metadata ?? {},
      secret: {
        recordIsSecret,
        ...(recordIsSecret ? { contentEncrypted: true } : {}),
        fields: Object.keys(secretFieldsEnc),
        likelySecretKeys: secretScan.likelySecretKeys,
        detectorWarnings: secretScan.warnings,
      },
      secretFieldsEnc,
      createdAt,
      updatedAt,
    };
  }

  async deleteRecord(dbId: string, recordId: string): Promise<void> {
    const current = await this.getStoredRecord(dbId, recordId);
    if (!current) throw new Error('record not found');
    const at = nowIso();
    await this.appendOperation(dbId, {
      op: 'record_delete',
      id: recordId,
      at,
    });
    await this.updateManifest(dbId, (draft) => {
      draft.deletedCount += 1;
      draft.updatedAt = at;
    });
  }

  async getRecord(dbId: string, recordId: string): Promise<PublicRecord | null> {
    const record = await this.getStoredRecord(dbId, recordId);
    return record ? publicRecord(record) : null;
  }

  async getStoredRecord(dbId: string, recordId: string): Promise<StoredRecord | null> {
    const records = await this.loadRecords(dbId);
    return records.get(recordId) ?? null;
  }

  async listRecords(dbId: string): Promise<PublicRecord[]> {
    const records = await this.loadRecords(dbId);
    return [...records.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(publicRecord);
  }

  async putKeyValue(dbId: string, key: string, value: unknown, metadata: Record<string, unknown> = {}): Promise<PublicRecord> {
    const existing = [...(await this.loadRecords(dbId)).values()].find((record) => record.type === 'kv' && record.key === key);
    if (existing) {
      return this.updateRecord(dbId, { id: existing.id, type: 'kv', key, json: value, metadata });
    }
    return this.writeRecord(dbId, { type: 'kv', key, json: value, metadata });
  }

  async getKeyValue(dbId: string, key: string): Promise<PublicRecord | null> {
    const records = await this.loadRecords(dbId);
    const record = [...records.values()].find((item) => item.type === 'kv' && item.key === key);
    return record ? publicRecord(record) : null;
  }

  async appendEvent(dbId: string, input: Omit<WriteRecordInput, 'type'>): Promise<PublicRecord> {
    return this.writeRecord(dbId, { ...input, type: 'event' });
  }

  async revealSecret(dbId: string, recordId: string, field?: string): Promise<{ value: string; field: string }> {
    const record = await this.getStoredRecord(dbId, recordId);
    if (!record) throw new Error('record not found');
    if (field) {
      const payload = record.secretFieldsEnc[field];
      if (!payload) throw new Error('secret field not found');
      await appendJsonLine(this.auditPath(dbId), { action: 'secret_reveal', recordId, field, at: nowIso() });
      return { field, value: decryptString(payload, this.masterKey) };
    }
    if (!record.contentEnc) throw new Error('secret content not found');
    await appendJsonLine(this.auditPath(dbId), { action: 'secret_reveal', recordId, field: 'content', at: nowIso() });
    return { field: 'content', value: decryptString(record.contentEnc, this.masterKey) };
  }

  async search(dbId: string, input: SearchInput): Promise<SearchHit[]> {
    const { searchRecords } = await import('./search.js');
    return searchRecords([...(await this.loadRecords(dbId)).values()], input).map((hit) => ({
      ...hit,
      record: publicRecord(hit.record),
    }));
  }

  async compact(dbId: string): Promise<{ segment: string; records: number }> {
    const records = [...(await this.loadRecords(dbId)).values()];
    const at = nowIso();
    const segment = `compact-${at.replace(/[:.]/g, '-')}.jsonl`;
    await atomicWrite(
      this.segmentPath(dbId, segment),
      records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
    );
    await atomicWrite(
      this.walPath(dbId),
      records.map((record) => JSON.stringify({ op: 'record_upsert', record, at })).join('\n') +
        (records.length ? '\n' : ''),
    );
    await this.updateManifest(dbId, (draft) => {
      draft.lastCompactedAt = at;
      draft.activeSegment = segment;
      draft.recordCount = records.length;
      draft.updatedAt = at;
    });
    await appendJsonLine(this.auditPath(dbId), { action: 'compact', segment, records: records.length, at });
    return { segment, records: records.length };
  }

  async backup(dbId: string): Promise<{ path: string; records: number }> {
    const manifest = await this.getManifest(dbId);
    const records = await this.listRecords(dbId);
    const tokens = await this.readTokens(dbId);
    const at = nowIso();
    const path = join(this.workspaceDir(dbId), 'backups', `snapshot-${at.replace(/[:.]/g, '-')}.json`);
    await atomicWrite(path, `${JSON.stringify({ manifest, records, tokens, createdAt: at }, null, 2)}\n`);
    await appendJsonLine(this.auditPath(dbId), { action: 'backup', path, records: records.length, at });
    return { path, records: records.length };
  }

  async destroyAllForTests(): Promise<void> {
    await rm(this.dataDir, { recursive: true, force: true });
  }

  private async appendOperation(dbId: string, op: Operation): Promise<void> {
    await appendJsonLine(this.walPath(dbId), op);
  }

  private async loadRecords(dbId: string): Promise<Map<string, StoredRecord>> {
    const wal = await readFile(this.walPath(dbId), 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    const records = new Map<string, StoredRecord>();
    for (const line of wal.split('\n')) {
      if (!line.trim()) continue;
      const op = JSON.parse(line) as Operation;
      if (op.op === 'record_upsert' && op.record) {
        records.set(op.record.id, op.record);
      }
      if (op.op === 'record_delete' && op.id) {
        records.delete(op.id);
      }
    }
    return records;
  }

  private async updateManifest(dbId: string, mutate: (draft: WorkspaceManifest) => void): Promise<void> {
    const manifest = await this.getManifest(dbId);
    mutate(manifest);
    await atomicWrite(this.manifestPath(dbId), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
