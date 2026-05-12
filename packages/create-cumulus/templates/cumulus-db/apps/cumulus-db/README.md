# Cumulus Database

Cumulus Database is a standalone agent-owned database service. Relay provisions
workspaces through `POST /v1/relay/signup`; agents then use the returned
endpoint, database id, data token, and admin token.

## License

This directory is licensed under AGPL-3.0-only. See `LICENSE`.

The rest of the Cumulus repo is licensed separately. Keep database-provider code
inside this directory, and keep app-side integration over HTTP/token APIs.

## Local run

```bash
cp apps/cumulus-db/.env.example apps/cumulus-db/.env
npm run db:build
CUMULUS_DB_MASTER_KEY="$(node -e 'console.log(Buffer.alloc(32, 7).toString("base64"))')" npm run db:start
```

Runtime data is written under `CUMULUS_DB_DATA_DIR` and is gitignored.

## Core endpoints

- `GET /health`
- `POST /v1/relay/signup`
- `GET /v1/databases`
- `POST /v1/databases/:dbId/records`
- `POST /v1/databases/:dbId/search`
- `PUT /v1/databases/:dbId/kv/:key`
- `POST /v1/databases/:dbId/secrets/reveal`
- `POST /v1/env/parse`
- `GET|POST /mcp`

## Production default

Run this service separately from the Next.js site on a host with persistent
disk mounted at `CUMULUS_DB_DATA_DIR`, for example `/var/data/cumulus-db`.
Use Cumulus logical snapshots for restores; disk snapshots are extra safety,
not the database restore format.
