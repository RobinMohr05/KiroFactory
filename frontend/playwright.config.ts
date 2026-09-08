import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E test configuration.
 *
 * - E2E specs live in `frontend/e2e/` (kept separate from Vitest's `src/__tests__/`
 *   so the two runners never pick up each other's test files).
 * - The `webServer` block boots the Vite dev server on port 5173 before running tests.
 *   Tests can reach the app at http://localhost:5173.
 *
 * Note: the smoke test mocks `/api/auth/me` via Playwright route interception so
 * it does not require a running backend — the mock returns a valid user object,
 * allowing AppLayout to render its children and enabling a meaningful DOM
 * assertion (not just the static HTML title).
 */
export default defineConfig({
  testDir: './e2e',

  // Run tests in files in parallel
  fullyParallel: true,

  // Fail the build on CI if test.only is accidentally left in
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 1 : 0,

  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,

  reporter: 'list',

  use: {
    // Base URL so tests can use `page.goto('/')` without repeating the full URL
    baseURL: 'http://localhost:5173',

    // Collect trace on first retry
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Boot the Vite dev server before running tests, reuse an existing server if
  // already running (useful for local dev).
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
