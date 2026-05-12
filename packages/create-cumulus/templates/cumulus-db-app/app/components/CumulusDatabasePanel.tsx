'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type DbManifest = {
  id: string;
  ownerAgentId: string;
  humanOwnerEmail: string | null;
  relaySignupId: string | null;
  updatedAt: string;
  recordCount: number;
  lastCompactedAt: string | null;
};

type DbRecord = {
  id: string;
  type: string;
  title?: string;
  content?: string | null;
  tags: string[];
  secret: {
    recordIsSecret: boolean;
    fields: string[];
    likelySecretKeys: string[];
    detectorWarnings: string[];
  };
  updatedAt: string;
};

type EnvParse = {
  variables: Array<{
    key: string;
    value: string;
    isLikelySecret: boolean;
    reason: string | null;
  }>;
  warnings: string[];
  invalidLines: Array<{ line: number; reason: string }>;
  duplicateKeys: string[];
  suggestedSecretKeys: string[];
};

const connectionStorageKey = 'cumulus_db_connection:v1';

async function jsonFetch<T>(url: string, init?: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, {
    ...init,
    headers,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}

const fieldStyle = {
  width: '100%',
  border: '1px solid var(--color-hair)',
  borderRadius: 5.5,
  background: 'transparent',
  color: 'var(--color-ink)',
  padding: '10px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
} as const;

const buttonStyle = {
  border: '1px solid var(--color-ink)',
  borderRadius: 5.5,
  background: 'var(--color-ink)',
  color: 'var(--color-paper)',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '10px 14px',
  textTransform: 'uppercase',
} as const;

const quietButtonStyle = {
  ...buttonStyle,
  background: 'transparent',
  color: 'var(--color-ink)',
} as const;

export function CumulusDatabasePanel() {
  const [databaseId, setDatabaseId] = useState('');
  const [token, setToken] = useState('');
  const [records, setRecords] = useState<DbRecord[]>([]);
  const [manifest, setManifest] = useState<DbManifest | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [secretRecord, setSecretRecord] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DbRecord[]>([]);
  const [envText, setEnvText] = useState('');
  const [envParse, setEnvParse] = useState<EnvParse | null>(null);
  const [revealed, setRevealed] = useState<{ field: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem(connectionStorageKey);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { databaseId?: string };
      if (saved.databaseId) setDatabaseId(saved.databaseId);
    } catch {
      window.localStorage.removeItem(connectionStorageKey);
    }
  }, []);

  const canUseDatabase = useMemo(
    () => databaseId.trim().length > 0 && token.trim().length > 0,
    [databaseId, token],
  );

  const loadRecords = useCallback(async () => {
    if (!canUseDatabase) return;
    setBusy(true);
    setError(null);
    try {
      const id = databaseId.trim();
      const scopedToken = token.trim();
      window.localStorage.setItem(
        connectionStorageKey,
        JSON.stringify({ databaseId: id }),
      );
      const body = await jsonFetch<{ database: DbManifest; records: DbRecord[] }>(
        `/api/cumulus-db/databases/${encodeURIComponent(id)}`,
        undefined,
        scopedToken,
      );
      setManifest(body.database);
      setRecords(body.records);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [canUseDatabase, databaseId, token]);

  async function createRecord() {
    if (!canUseDatabase || !content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await jsonFetch(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/records`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: secretRecord ? 'secret' : 'note',
            title: title.trim() || undefined,
            content,
            recordIsSecret: secretRecord,
            tags: secretRecord ? ['secret'] : ['manual'],
          }),
        },
        token.trim(),
      );
      setTitle('');
      setContent('');
      setSecretRecord(false);
      await loadRecords();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!canUseDatabase) return;
    setError(null);
    try {
      const body = await jsonFetch<{ hits: Array<{ record: DbRecord }> }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/search`,
        {
          method: 'POST',
          body: JSON.stringify({ query, limit: 12 }),
        },
        token.trim(),
      );
      setResults(body.hits.map((hit) => hit.record));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function parseEnv() {
    setError(null);
    try {
      const body = await jsonFetch<EnvParse>('/api/cumulus-db/env/parse', {
        method: 'POST',
        body: JSON.stringify({ content: envText }),
      });
      setEnvParse(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveEnvRecord() {
    if (!canUseDatabase || !envParse) return;
    const secrets = Object.fromEntries(
      envParse.variables
        .filter((item) => item.isLikelySecret)
        .map((item) => [item.key, item.value]),
    );
    const publicVars = Object.fromEntries(
      envParse.variables
        .filter((item) => !item.isLikelySecret)
        .map((item) => [item.key, item.value]),
    );
    await jsonFetch(
      `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/records`,
      {
        method: 'POST',
        body: JSON.stringify({
          type: Object.keys(secrets).length ? 'secret' : 'document',
          title: 'Environment variables',
          json: publicVars,
          secrets,
          tags: ['env'],
        }),
      },
      token.trim(),
    );
    setEnvText('');
    setEnvParse(null);
    await loadRecords();
  }

  async function revealSecret(recordId: string, field: string) {
    if (!canUseDatabase) return;
    setError(null);
    try {
      const body = await jsonFetch<{ secret: { field: string; value: string } }>(
        `/api/cumulus-db/databases/${encodeURIComponent(databaseId.trim())}/secrets/reveal`,
        {
          method: 'POST',
          body: JSON.stringify({ recordId, field }),
        },
        token.trim(),
      );
      setRevealed(body.secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ display: 'grid', gap: 28, maxWidth: 920 }}>
      <section style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <input
            value={databaseId}
            onChange={(event) => setDatabaseId(event.target.value)}
            placeholder="Database id"
            style={fieldStyle}
          />
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Scoped data token"
            type="password"
            style={fieldStyle}
          />
          <button type="button" onClick={loadRecords} disabled={!canUseDatabase || busy} style={buttonStyle}>
            Connect
          </button>
        </div>
        {manifest ? (
          <p style={{ color: 'var(--color-ink-2)', fontSize: 13, margin: 0 }}>
            Connected to <code>{manifest.id}</code>. Records: {records.length}.
          </p>
        ) : null}
        {error ? (
          <p style={{ color: 'var(--color-terracotta)', fontSize: 13, margin: 0 }}>{error}</p>
        ) : null}
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Records</h2>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title"
          style={fieldStyle}
        />
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Content"
          rows={4}
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
        <label style={{ alignItems: 'center', display: 'inline-flex', gap: 8, fontSize: 13 }}>
          <input
            checked={secretRecord}
            onChange={(event) => setSecretRecord(event.target.checked)}
            type="checkbox"
          />
          Store as secret
        </label>
        <button type="button" onClick={createRecord} disabled={!canUseDatabase || !content.trim() || busy} style={buttonStyle}>
          Add record
        </button>
        <div style={{ display: 'grid', gap: 10 }}>
          {records.slice(0, 8).map((record) => (
            <article
              key={record.id}
              style={{
                border: '1px solid var(--color-hair)',
                borderRadius: 5.5,
                padding: 14,
              }}
            >
              <b style={{ color: 'var(--color-ink)' }}>{record.title || record.type}</b>
              <p style={{ color: 'var(--color-ink-2)', fontSize: 13, margin: '8px 0 0' }}>
                {record.content ?? '[no content]'}
              </p>
              {record.secret.fields.map((field) => (
                <button
                  key={field}
                  type="button"
                  onClick={() => revealSecret(record.id, field)}
                  style={{ ...quietButtonStyle, marginTop: 10 }}
                >
                  Reveal {field}
                </button>
              ))}
            </article>
          ))}
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Search</h2>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search query"
            style={fieldStyle}
          />
          <button type="button" onClick={runSearch} disabled={!canUseDatabase} style={buttonStyle}>
            Search
          </button>
        </div>
        {results.map((record) => (
          <p key={record.id} style={{ color: 'var(--color-ink-2)', fontSize: 13, margin: 0 }}>
            <strong>{record.title || record.type}</strong>: {record.content ?? '[no content]'}
          </p>
        ))}
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Environment</h2>
        <textarea
          value={envText}
          onChange={(event) => setEnvText(event.target.value)}
          placeholder="KEY=value"
          rows={5}
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={parseEnv} disabled={!envText.trim()} style={buttonStyle}>
            Parse env
          </button>
          <button type="button" onClick={saveEnvRecord} disabled={!canUseDatabase || !envParse} style={quietButtonStyle}>
            Save env record
          </button>
        </div>
        {envParse ? (
          <p style={{ color: 'var(--color-ink-2)', fontSize: 13, margin: 0 }}>
            Parsed {envParse.variables.length} variable(s). Secrets:{' '}
            {envParse.variables.filter((item) => item.isLikelySecret).length}.
          </p>
        ) : null}
      </section>

      {revealed ? (
        <section style={{ border: '1px solid var(--color-hair)', borderRadius: 5.5, padding: 14 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Revealed secret</h2>
          <pre style={{ overflowX: 'auto' }}>{`${revealed.field}=${revealed.value}`}</pre>
        </section>
      ) : null}
    </div>
  );
}
