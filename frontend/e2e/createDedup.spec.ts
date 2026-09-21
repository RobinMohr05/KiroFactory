/**
 * E2E tests for the duplicate-on-create bug fix (task #1698).
 *
 * Scenario: when the user creates a tab or a task, the backend sends a
 * `*-created` WebSocket broadcast to ALL of the user's open sockets,
 * including the originating one. Without the fix, the entity is appended
 * twice: once from the POST response and once from the WS echo, producing
 * a visible duplicate until the page is refreshed.
 *
 * These tests verify that after creating an entity through the UI:
 *   1. Exactly one entry for that entity appears in the list — no duplicate.
 *   2. This holds WITHOUT a page refresh.
 *
 * Approach: mock all API calls via Playwright route interception so no real
 * backend is required. A controlled WebSocket mock is injected via
 * page.addInitScript() so we can fire a WS `*-created` message at a precise
 * point and assert the deduplicated result.
 *
 * NOTE: These specs require Playwright browsers (installed via
 * `npx playwright install chromium` plus its system libraries). They were
 * verified passing locally with browsers installed, and run in CI where
 * browsers are available. The unit-level dedup coverage lives in
 * `src/__tests__/wsDedup.test.tsx` and runs with Vitest regardless of
 * browser availability.
 */

import { test, expect } from '@playwright/test';

// ── Shared fixtures ───────────────────────────────────────────────────────

const MOCK_USER = { id: 1, email: 'test@example.com', uiViewMode: 'advanced' };
const MOCK_TAB = { id: 99, name: 'Dedup Test Tab', repositoryUrl: null };

/**
 * Register all API mocks needed to boot the app shell.
 */
async function setupApiMocks(page: import('@playwright/test').Page) {
  await page.route('/api/auth/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: MOCK_USER }),
    })
  );

  // Initial tab list — one tab so the board renders
  await page.route('/api/tabs', route => {
    if (route.request().method() === 'POST') {
      // Per-test overrides will replace this; return a fallback
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([MOCK_TAB]),
    });
  });

  await page.route(`/api/tabs/${MOCK_TAB.id}`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...MOCK_TAB, tasks: [] }),
    })
  );

  await page.route('/api/sessions', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('/api/agents', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('/api/errors', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('/api/autoscalers', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  // GET /api/tasks is queried by TaskModal on mount to populate its
  // dependency picker — return an empty list so the modal boots cleanly.
  await page.route('/api/tasks', route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    // POST handled by per-test override; fallback so nothing hangs.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/**
 * Inject a minimal WebSocket shim before any page scripts run.
 *
 * The shim replaces global `WebSocket` so AppContext connects to the mock
 * instead of a real server. Tests can fire fake incoming messages by
 * evaluating `window.__mockWs.simulateMessage(jsonString)` on the page.
 *
 * The script is passed as a plain string (not an arrow function) to avoid
 * TypeScript trying to type-check browser globals against tsconfig.node.json
 * (which has no DOM lib). The evaluate() calls below use the same pattern.
 */
const WS_MOCK_SCRIPT = `
  (function() {
    var messageCallback = null;

    function MockWebSocket() {
      window.__mockWs = this;
    }
    MockWebSocket.OPEN = 1;
    MockWebSocket.prototype.readyState = 1;
    MockWebSocket.prototype.addEventListener = function(event, cb) {
      if (event === 'message') { messageCallback = cb; }
      if (event === 'open') { setTimeout(function() { cb({ type: 'open' }); }, 0); }
    };
    MockWebSocket.prototype.removeEventListener = function() {};
    MockWebSocket.prototype.close = function() {};
    MockWebSocket.prototype.send = function() {};
    MockWebSocket.prototype.simulateMessage = function(data) {
      if (messageCallback) messageCallback({ data: data });
    };

    window.WebSocket = MockWebSocket;
  })();
`;

async function injectWsMock(page: import('@playwright/test').Page) {
  await page.addInitScript({ content: WS_MOCK_SCRIPT });
}

/** Fire a mock WS message into AppContext's handleWsMessage. */
async function fireWsMessage(
  page: import('@playwright/test').Page,
  msg: Record<string, unknown>
) {
  const data = JSON.stringify(msg);
  // The evaluate callback accesses window.__mockWs — cast to any to avoid DOM type errors
  // in tsconfig.node.json (no DOM lib). Same pattern used by plannerQuestionCard.spec.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate((d: string) => { (globalThis as any).__mockWs?.simulateMessage(d); }, data);
}

// ── Tab create dedup ──────────────────────────────────────────────────────

test.describe('tab create — no duplicate without page refresh', () => {
  test.beforeEach(async ({ page }) => {
    await injectWsMock(page);
    await setupApiMocks(page);
  });

  test('creating a tab via the UI shows exactly one tab with that name', async ({ page }) => {
    const NEW_TAB = { id: 200, name: 'Brand New Tab' };

    // Override the /api/tabs route to handle POST (create)
    await page.unroute('/api/tabs');
    await page.route('/api/tabs', async route => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(NEW_TAB),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([MOCK_TAB]),
        });
      }
    });

    await page.goto('/');
    // Wait for the app shell to render
    await expect(page.locator('#root > *').first()).toBeVisible();

    // Open the "New Tab" modal
    await page.click('#newBoardBtn');

    // Fill in the name and submit. The tab-name input in TabModal has
    // id="tabFormName" (not "tabName").
    await page.fill('#tabFormName', NEW_TAB.name);
    await page.click('button[type="submit"]');

    // Simulate the WS echo that the backend sends to all open sockets.
    // Before the fix, this produced a duplicate entry.
    await fireWsMessage(page, { type: 'tab-created', tab: NEW_TAB });

    // Assert: exactly ONE tab item with the new id — no duplicate
    const tabItems = page.locator(`[data-board-id="${NEW_TAB.id}"]`);
    await expect(tabItems).toHaveCount(1);
  });
});

// ── Task create dedup ─────────────────────────────────────────────────────

test.describe('task create — no duplicate without page refresh', () => {
  test.beforeEach(async ({ page }) => {
    await injectWsMock(page);
    await setupApiMocks(page);
  });

  test('creating a task via the UI shows exactly one card for that task', async ({ page }) => {
    const NEW_TASK = {
      id: 999,
      title: 'Brand New Dedup Task',
      type: 'feature',
      priority: 3,
      state: 'todo',
      tabs: [{ id: MOCK_TAB.id, name: MOCK_TAB.name }],
    };

    // Mock POST /api/tasks (create). GET /api/tasks is already mocked in
    // setupApiMocks to return [] for the TaskModal dependency picker.
    await page.unroute('/api/tasks');
    await page.route('/api/tasks', async route => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(NEW_TASK),
        });
      } else {
        // GET — dependency picker list
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
    });

    // The "+ Task" button (#newTaskBtn) opens the AI Task Planner, NOT the
    // manual TaskModal. The only real code path to the manual create form
    // (which has #taskTitle and POSTs a single task to /api/tasks) is to open
    // the planner and switch its mode dropdown to "Manual". Mock the planner
    // start/stop endpoints so opening it doesn't hang, then switch to manual.
    await page.route('/api/task-planner/start', route =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ sessionId: 4242 }),
      })
    );
    await page.route('/api/task-planner/4242', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    );

    await page.goto('/');
    await expect(page.locator('#root > *').first()).toBeVisible();

    // Open the AI Task Planner…
    await page.click('#newTaskBtn');
    // …then switch its mode dropdown to "Manual" to open the manual TaskModal
    // in create mode (onSwitchToManual -> setEditingTask(null)).
    await page.selectOption('#taskPlannerTitle', 'manual');

    // The manual create form's title input is #taskTitle.
    await page.fill('#taskTitle', NEW_TASK.title);
    await page.click('button[type="submit"]');

    // Simulate the WS echo (the duplicate trigger)
    await fireWsMessage(page, { type: 'task-created', task: NEW_TASK });

    // Assert: exactly one card for this task id
    const taskCards = page.locator(`[data-task-id="${NEW_TASK.id}"]`);
    await expect(taskCards).toHaveCount(1);
  });
});
