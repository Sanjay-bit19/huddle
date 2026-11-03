import { createDb } from './client';
import { runMigrations } from './migrate';

const url = process.env.DATABASE_URL ?? 'postgres://huddle:huddle@localhost:5432/huddle';
const handle = createDb(url, { max: 1 });
try {
  await runMigrations(handle.db);
  console.log('migrations applied');
} finally {
  await handle.close();
}
