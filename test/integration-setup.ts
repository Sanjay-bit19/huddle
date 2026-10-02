import { createDb, runMigrations } from '@huddle/db';

/**
 * Runs once before the integration project: points every suite at the test
 * database / Redis db and applies migrations.
 */
export default async function setup() {
  process.env.DATABASE_URL ??= 'postgres://huddle:huddle@localhost:5432/huddle_test';
  process.env.REDIS_URL ??= 'redis://localhost:6379/1';
  const handle = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    await runMigrations(handle.db);
  } finally {
    await handle.close();
  }
}
