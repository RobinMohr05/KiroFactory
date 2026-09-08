import { test, expect } from '@playwright/test';

/**
 * Smoke test — verifies the app shell loads in a browser.
 *
 * This test does NOT require a running backend. It uses Playwright's route
 * interception to mock `/api/auth/me` so that AppContext receives a valid user
 * object and AppLayout renders its children — without needing a real backend
 * process.
 *
 * What we assert:
 *   1. The page title is "Vibecode Heaven" (set in index.html — stable across
 *      auth state changes and never modified by React router).
 *   2. React successfully mounted into `#root` and rendered a visible child —
 *      this confirms the JS bundle loaded and React ran successfully, and that
 *      the app progressed past the `user === null` guard in AppLayout.
 *
 * Do NOT extend this test to require WebSocket connectivity or a real authenticated
 * session — that belongs in a separate E2E suite with a full backend fixture.
 */
test.beforeEach(async ({ page }) => {
  // Mock the auth endpoint so AppContext receives a valid user and AppLayout
  // renders its children. Without this, /api/auth/me fails with a network
  // error (no backend), user stays null, and AppLayout returns null.
  await page.route('/api/auth/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 1, email: 'test@example.com', uiViewMode: 'advanced' } }),
    })
  );
});

test('app root renders', async ({ page }) => {
  await page.goto('/');

  // The <title> in index.html is the most stable indicator that the correct
  // HTML was served and the browser didn't hit an unexpected error page.
  await expect(page).toHaveTitle('Vibecode Heaven');

  // Assert a visible child exists inside #root — this confirms the JavaScript
  // bundle loaded and React ran successfully past the auth guard in AppLayout.
  // A bare `toBeAttached()` on #root would pass even if React never mounted
  // (the div is static in index.html); `#root > *` only passes once React
  // has rendered at least one child node. `.first()` handles the case where
  // React renders multiple children (header, tab bar, etc.).
  await expect(page.locator('#root > *').first()).toBeVisible();
});
