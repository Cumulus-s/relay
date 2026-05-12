// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createHandler } from './http.js';
import { CumulusDbEngine } from './storage.js';

const config = loadConfig();
const engine = new CumulusDbEngine(config.dataDir, config.masterKey);
await engine.ensureRoot();

const server = createServer(createHandler(engine, config));
server.listen(config.port, () => {
  console.log(`Cumulus Database listening on ${config.publicUrl}`);
});
