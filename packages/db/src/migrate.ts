import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

export const migrationsFolder =
  process.env.HUDDLE_MIGRATIONS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}
