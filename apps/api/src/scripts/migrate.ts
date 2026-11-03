import { createDb, runMigrations } from '@huddle/db';

/** Release step (Fly release_command): run migrations once per deploy, not per instance. */
const handle = createDb(process.env.DATABASE_URL!, { max: 1 });
try {
  await runMigrations(handle.db);
  console.log('migrations applied');
} finally {
  await handle.close();
}
