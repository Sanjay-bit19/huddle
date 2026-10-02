import { hash } from '@node-rs/argon2';
import { createDb, runMigrations, users } from '@huddle/db';

/** Creates the demo account advertised in the README. Safe to run repeatedly. */
const url = process.env.DATABASE_URL ?? 'postgres://huddle:huddle@localhost:5432/huddle';
const handle = createDb(url, { max: 1 });
try {
  await runMigrations(handle.db);
  const passwordHash = await hash(process.env.DEMO_PASSWORD ?? 'huddle-demo-2026');
  await handle.db
    .insert(users)
    .values({ email: 'demo@huddle.dev', name: 'Demo User', passwordHash })
    .onConflictDoNothing({ target: users.email });
  console.log('seeded demo@huddle.dev');
} finally {
  await handle.close();
}
