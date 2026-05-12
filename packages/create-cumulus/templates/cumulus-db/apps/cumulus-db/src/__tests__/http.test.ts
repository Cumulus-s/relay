// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHandler } from '../http.js';
import { CumulusDbEngine } from '../storage.js';
import type { CumulusDbConfig } from '../config.js';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function testServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'cumulus-db-http-'));
  const config: CumulusDbConfig = {
    dataDir,
    publicUrl: 'http://127.0.0.1:0',
    adminSecret: Buffer.alloc(32, 4).toString('base64'),
    masterKey: Buffer.alloc(32, 4),
    relayWebhookSecret: null,
    port: 0,
    embeddings: { baseUrl: null, apiKey: null, model: null },
  };
  const engine = new CumulusDbEngine(dataDir, config.masterKey);
  const server = createServer(createHandler(engine, config));
  const baseUrl = await new Promise<URL>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('invalid address');
      resolve(new URL(`http://127.0.0.1:${addr.port}`));
    });
  });
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  cleanup.push(() => engine.destroyAllForTests());
  return { baseUrl, engine };
}

describe('HTTP API', () => {
  it('creates records through REST and searches them', async () => {
    const { baseUrl, engine } = await testServer();
    const created = await engine.createWorkspace({ ownerAgentId: 'agent-1' });
    const headers = {
      Authorization: `Bearer ${created.dataToken.token}`,
      'Content-Type': 'application/json',
    };

    const write = await fetch(new URL(`/v1/databases/${created.manifest.id}/records`, baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'note', content: 'Hybrid search works for agents.' }),
    });
    expect(write.status).toBe(201);

    const search = await fetch(new URL(`/v1/databases/${created.manifest.id}/search`, baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: 'hybrid agents' }),
    });
    expect(search.status).toBe(200);
    const body = (await search.json()) as { hits: unknown[] };
    expect(body.hits.length).toBe(1);
  });
});
