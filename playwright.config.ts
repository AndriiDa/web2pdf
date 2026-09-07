import { defineConfig } from '@playwright/test';

/**
 * Integration and end-to-end tests.
 *
 * `pipeline.spec.ts` drives the conversion pipeline directly (no web server
 * needed). `e2e.spec.ts` drives the real UI and starts the Next.js dev server.
 */
export default defineConfig({
  testDir: './test',
  // Browser work is memory-hungry; keep concurrency low and predictable.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'pipeline',
      testMatch: /integration\/.*\.spec\.ts/,
    },
    {
      name: 'e2e',
      testMatch: /e2e\/.*\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:3000' },
    },
  ],
  /**
   * Started only for the e2e project. `reuseExistingServer` keeps local runs
   * fast when a dev server is already up.
   */
  webServer: {
    command: 'npm run start -- --port 3000 --hostname 127.0.0.1',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // The serverless Chromium binary is Linux-only, so tests always run local.
    // ALLOW_PRIVATE_TARGETS lets the suite reach its loopback fixture server;
    // it is a test-only flag and is off by default everywhere else.
    env: { BROWSER_MODE: 'local', LOG_LEVEL: 'warn', ALLOW_PRIVATE_TARGETS: '1' },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
