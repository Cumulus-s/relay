import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

type Database = ReturnType<typeof drizzle<typeof schema>>;

let cachedDb: Database | null = null;

export function getDb(): Database {
  if (cachedDb) return cachedDb;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  cachedDb = drizzle(neon(url), { schema });
  return cachedDb;
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    const database = getDb();
    const value = Reflect.get(database as object, prop);
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
