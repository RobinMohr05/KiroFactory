/**
 * Playwright visual test for AI Task Planner question cards.
 *
 * Tests that long question-card headers and long Rec: recommendation lines
 * render fully (wrap rather than being clipped) at both wide and narrow
 * viewport widths.
 *
 * Approach: isolated harness — injects the rendered HTML and the app CSS
 * directly via page.setContent() so no backend session, WebSocket, or full
 * app mount is required. The CSS is read from src/style.css (the single
 * source of truth that is also copied to public/style.css by the Vite plugin).
 *
 * Key assertions:
 *   1. scrollWidth <= clientWidth + tolerance  →  no horizontal overflow
 *   2. Full text of the long title is present in the DOM
 *   3. Full text of the long Rec: line is present in the DOM
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve path to the CSS source from this spec file's location
const __dirname_here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(__dirname_here, '../src/style.css');

// ---------------------------------------------------------------------------
// Sample content — deliberately very long to trigger the original clipping bug
// ---------------------------------------------------------------------------

const LONG_TITLE =
  'What is the preferred deployment strategy for the production environment given all operational and compliance requirements covering zero-downtime releases and audit logging';

const LONG_REC =
  'Blue-green deployment with automated rollback is recommended because it guarantees zero-downtime releases, enables instant rollback on failure, satisfies all compliance audit requirements without manual intervention, and has been validated by the platform team across every production region';

/**
 * Build an isolated HTML page that:
 *   - Loads the full app stylesheet inline (so CSS variables and all
 *     planner-question rules take effect)
 *   - Wraps the injected HTML in a .planner-message.assistant container
 *     (matching the real app's DOM structure)
 *   - Applies a fixed body background matching --bg-secondary so screenshots
 *     look reasonable
 */
function buildHarness(innerHtml: string, css: string): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>${css}</style>
</head>
<body style="margin: 1rem; background: #1a1a2e;">
  <div class="task-planner-messages">
    <div class="planner-message assistant">
      ${innerHtml}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render a single question card using the same logic as renderPlannerMarkdown,
 * but as a pre-built HTML string for injection — avoids bundling TypeScript in
 * the Playwright process while still exercising the exact CSS classes the real
 * renderer produces.
 *
 * Mirrors what renderPlannerMarkdown/renderQuestionCard would emit for the
 * sample question.
 */
function buildCardHtml(): string {
  const headerHtml = `<strong>Q1 — ${LONG_TITLE}</strong>`;
  const body = '<p>(A) Rolling update<br>(B) Blue-green deployment</p>';
  const rec = `<strong>Rec:</strong> ${LONG_REC}`;

  return `<div class="planner-question">
  <div class="planner-question-header">${headerHtml}</div>
  <div class="planner-question-body">${body}</div>
  <div class="planner-question-rec">${rec}</div>
</div>`;
}

// ---------------------------------------------------------------------------

test.describe('plannerQuestionCard — no horizontal clipping', () => {
  let css: string;

  test.beforeAll(() => {
    css = readFileSync(CSS_PATH, 'utf8');
  });

  test('long title and long Rec: line are fully present in the DOM (wide viewport)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const cardHtml = buildCardHtml();
    await page.setContent(buildHarness(cardHtml, css), { waitUntil: 'domcontentloaded' });

    // Full text must be in the DOM
    const headerEl = page.locator('.planner-question-header');
    await expect(headerEl).toContainText('production environment');
    await expect(headerEl).toContainText('audit logging');

    const recEl = page.locator('.planner-question-rec');
    await expect(recEl).toContainText('Blue-green deployment with automated rollback');
    await expect(recEl).toContainText('every production region');
  });

  test('long title and long Rec: line are fully present in the DOM (narrow viewport)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const cardHtml = buildCardHtml();
    await page.setContent(buildHarness(cardHtml, css), { waitUntil: 'domcontentloaded' });

    const headerEl = page.locator('.planner-question-header');
    await expect(headerEl).toContainText('production environment');
    await expect(headerEl).toContainText('audit logging');

    const recEl = page.locator('.planner-question-rec');
    await expect(recEl).toContainText('Blue-green deployment with automated rollback');
    await expect(recEl).toContainText('every production region');
  });

  test('.planner-question does not overflow horizontally (wide viewport)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const cardHtml = buildCardHtml();
    await page.setContent(buildHarness(cardHtml, css), { waitUntil: 'domcontentloaded' });

    // Assert no horizontal scroll overflow — allow a small tolerance (1px) for
    // sub-pixel rounding differences across browsers and OS font-hinting.
    // The evaluate callback runs in the browser (DOM context), not Node — cast
    // to `any` since tsconfig.node.json does not include the DOM lib.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isOverflowing = await page.locator('.planner-question').evaluate((el: any) => {
      return el.scrollWidth > el.clientWidth + 1;
    });
    expect(isOverflowing).toBe(false);
  });

  test('.planner-question does not overflow horizontally (narrow viewport)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const cardHtml = buildCardHtml();
    await page.setContent(buildHarness(cardHtml, css), { waitUntil: 'domcontentloaded' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isOverflowing = await page.locator('.planner-question').evaluate((el: any) => {
      return el.scrollWidth > el.clientWidth + 1;
    });
    expect(isOverflowing).toBe(false);
  });

  test('captures a screenshot of the rendered card as a visual artifact', async ({
    page,
  }, testInfo) => {
    // Wide viewport — representative of how the card normally appears
    await page.setViewportSize({ width: 900, height: 600 });
    const cardHtml = buildCardHtml();
    await page.setContent(buildHarness(cardHtml, css), { waitUntil: 'domcontentloaded' });

    // Capture the full planner-question card so the screenshot shows the
    // wrapping behaviour at a glance. Attach to the test report as a visual artifact.
    const cardEl = page.locator('.planner-question');
    await expect(cardEl).toBeVisible();
    const screenshotWide = await cardEl.screenshot();
    await testInfo.attach('planner-question-card-wide.png', {
      body: screenshotWide,
      contentType: 'image/png',
    });

    // Also capture a narrow-viewport render for comparison
    await page.setViewportSize({ width: 375, height: 812 });
    await page.setContent(buildHarness(cardHtml, css), { waitUntil: 'domcontentloaded' });
    const screenshotNarrow = await page.locator('.planner-question').screenshot();
    await testInfo.attach('planner-question-card-narrow.png', {
      body: screenshotNarrow,
      contentType: 'image/png',
    });
  });
});
