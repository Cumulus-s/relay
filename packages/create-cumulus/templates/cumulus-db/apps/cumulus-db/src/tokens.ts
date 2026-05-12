// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { sha256 } from './crypto.js';
import type { TokenIssue, TokenRecord, TokenScope } from './types.js';

const DATA_SCOPES: TokenScope[] = [
  'records:read',
  'records:write',
  'search:read',
  'events:write',
  'kv:read',
  'kv:write',
  'secrets:write',
];

const ADMIN_SCOPES: TokenScope[] = [
  ...DATA_SCOPES,
  'secrets:reveal',
  'tokens:manage',
  'backups:manage',
  'database:admin',
];

function makeToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function issueToken(label: string, scopes: TokenScope[], prefix: string): {
  issue: TokenIssue;
  record: TokenRecord;
} {
  const token = makeToken(prefix);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    issue: { id, token, scopes },
    record: {
      id,
      label,
      tokenHash: sha256(token),
      scopes,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

export function issueWorkspaceTokens(): {
  data: TokenIssue;
  admin: TokenIssue;
  records: TokenRecord[];
} {
  const data = issueToken('initial data token', DATA_SCOPES, 'cdb_data');
  const admin = issueToken('initial admin token', ADMIN_SCOPES, 'cdb_admin');
  return {
    data: data.issue,
    admin: admin.issue,
    records: [data.record, admin.record],
  };
}

export function hasScopes(token: TokenRecord, required: TokenScope[]): boolean {
  if (token.revokedAt) return false;
  if (token.scopes.includes('database:admin')) return true;
  return required.every((scope) => token.scopes.includes(scope));
}
