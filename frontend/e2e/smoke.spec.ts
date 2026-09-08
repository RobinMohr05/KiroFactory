import { test, expect } from '@playwright/test';

/**
 * Smoke test — verifies the app shell loads in a browser.
 *
 * This test does NOT require a running backend. The Vite dev server serves the
 * React SPA, and the auth check (`/api/auth/me`) fails gracefully with a network
 * error (no backend running), which AppContext's error handler allows through.
 *
 * What we assert:
 *   1. The page title is "Vibecode Heaven" (set in index.html — stable across
 *      auth state changes and never modified by React router).
 *   2. React successfully mounted into `#root` — verified by asserting a visible
 *      child element exists inside `#root`. `#root` itself is hardcoded in
 *      index.html and would always pass a bare attachment check even if the JS
 *      bundle failed to load; the `#root > *` selector only passes after React
 *      has rendered at least one child node.
 *
 * Do NOT extend this test to require authentication or WebSocket connectivity —
 * that belongs in a separate E2E suite with a full backend fixture.
 */
test('app root renders', async ({ page }) => {
  await page.goto('/');

  // The <title> in index.html is the most stable indicator that the correct
  // HTML was served and the browser didn't hit an unexpected error page.
  await expect(page).toHaveTitle('Vibecode Heaven');

  // Assert a visible child exists inside #root — this confirms the JavaScript
  // bundle loaded and React ran successfully. A bare `toBeAttached()` on #root
  // would pass even if React never mounted (the div is static in index.html).
  await expect(page.locator('#root > *')).toBeVisible();
});
