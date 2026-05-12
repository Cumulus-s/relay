// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createHandler } from './http.js';
import { CumulusDbEngine } from './storage.js';

const key = Buffer.alloc(32, 9).toString('base64');
const config = loadConfig({
  ...process.env,
  CUMULUS_DB_DATA_DIR: join(tmpdir(), `cumulus-db-smoke-${Date.now()}`),
  CUMULUS_DB_MASTER_KEY: key,
  CUMULUS_DB_RELAY_WEBHOOK_SECRET: 'relay-smoke-secret',
  CUMULUS_DB_PUBLIC_URL: 'http://127.0.0.1:0',
  CUMULUS_DB_PORT: '4317',
});
const engine = new CumulusDbEngine(config.dataDir, config.masterKey);
await engine.ensureRoot();
const server = createServer(createHandler(engine, config));

const address = await new Promise<URL>((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('invalid server address');
    resolve(new URL(`http://127.0.0.1:${addr.port}`));
  });
});

try {
  const relayBody = JSON.stringify({
    kind: 'signup',
    signupId: '11111111-1111-4111-8111-111111111111',
    email: 'smoke@example.com',
    input: { email: 'smoke@example.com', agent_id: 'smoke-agent' },
    provider_slug: 'cumulus-database',
  });
  const relaySignup = await fetch(new URL('/v1/relay/signup', address), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Relay-Signature': `sha256=${createHmac('sha256', 'relay-smoke-secret').update(relayBody).digest('hex')}`,
    },
    body: relayBody,
  });
  if (!relaySignup.ok) throw new Error(`relay signup failed: ${relaySignup.status}`);
  const signup = (await relaySignup.json()) as {
    credentials: {
      database_id: string;
      data_token: string;
      admin_token: string;
    };
  };
  if (!signup.credentials.admin_token.startsWith('cdb_admin_')) {
    throw new Error('relay signup did not return admin token');
  }

  const headers = {
    Authorization: `Bearer ${signup.credentials.data_token}`,
    'Content-Type': 'application/json',
  };
  const create = await fetch(new URL(`/v1/databases/${signup.credentials.database_id}/records`, address), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'note',
      title: 'Smoke memory',
      content: 'Cumulus Database stores agent memory.',
      tags: ['smoke'],
    }),
  });
  if (!create.ok) throw new Error(`record create failed: ${create.status}`);

  const search = await fetch(new URL(`/v1/databases/${signup.credentials.database_id}/search`, address), {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'agent memory' }),
  });
  const payload = (await search.json()) as { hits?: unknown[] };
  if (!search.ok || !payload.hits?.length) throw new Error('search did not return the smoke record');
  console.log('cumulus-db smoke passed');
} finally {
  server.close();
  await engine.destroyAllForTests();
}
