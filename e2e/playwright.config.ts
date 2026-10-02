import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs the real stack: API + collab server (tsx) + Vite, against the
 * Postgres/Redis in DATABASE_URL / REDIS_URL. Locally, already-running dev
 * servers are reused.
 */
const env = {
  NODE_ENV: 'test',
  JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-only-secret-e2e-only-secret-e2e-only',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://huddle:huddle@localhost:5432/huddle',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  RATE_LIMIT_DISABLED: 'true',
  RUN_MIGRATIONS: 'true',
  AI_PROVIDER: 'mock',
  LOG_LEVEL: 'warn',
};

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  webServer: [
    {
      command: 'pnpm --filter @huddle/api exec tsx src/index.ts',
      url: 'http://localhost:4000/healthz',
      env: { ...env, PORT: '4000' },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @huddle/collab exec tsx src/index.ts',
      url: 'http://localhost:1234/healthz',
      env: { ...env, PORT: '1234' },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @huddle/web exec vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
