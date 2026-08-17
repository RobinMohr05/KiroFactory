/**
 * Regression tests for the "idle dev/review/qa loop sessions don't notice
 * newly created or moved tasks" hotfix.
 *
 * Root cause (see backend/src/agent/task-claimer.ts and
 * backend/src/routes/tasks.ts): the event-driven loop-wakeup mechanism
 * introduced in commit 0791c35 had three defects:
 *   1. getAvailableTaskCount()'s 5s TTL cache was never invalidated on
 *      write, so a loop woken by "task-available" could immediately
 *      re-read a stale cached 0 and park again waiting for a second event
 *      that might never come.
 *   2. resolveTask() (the dev -> review -> qa handoff) never called
 *      notifyTaskAvailable(), so the primary pipeline handoff never woke
 *      the next stage's idle loop.
 *   3. PUT /api/tasks/:id (board drag-and-drop) and POST /:id/tabs never
 *      called notifyTaskAvailable() either, so manually moving a task into
 *      a claimable state never woke anyone.
 *
 * These tests are unit tests using mocks — they don't require a real DB
 * connection, matching the pattern in session-pin-reorder-fixes.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a mock Neo4j Result for a single-row `RETURN count(t) AS count`
 * query — the shape getAvailableTaskCount() reads via
 * `result.records[0].get("count")`.
 */
function countResult(count: number) {
  return { records: [{ get: (_key: string) => count }] };
}

// ============================================================================
// Behavioral tests: backend/src/agent/task-claimer.ts
// ============================================================================
describe("task-claimer — idle loop wake-up fixes", () => {
  let taskClaimer: typeof import("../agent/task-claimer.js");

  // Mock ManagedTransaction — every readQuery/writeQuery callback in
  // task-claimer.ts is handed this object and calls `.run(cypher, params)`
  // on it exactly once per DB round trip, replacing the old mssql
  // mockRequest.query() call this test used to assert on.
  const mockTx = {
    run: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useRealTimers();

    mockTx.run.mockReset();

    vi.doMock("../db/connection.js", () => ({
      readQuery: vi.fn((work: (tx: typeof mockTx) => unknown) => work(mockTx)),
      writeQuery: vi.fn((work: (tx: typeof mockTx) => unknown) => work(mockTx)),
    }));

    // task-claimer.ts imports getTaskById only to power the fire-and-forget
    // broadcastTaskUpdate() helper — stub it out so tests don't need to
    // simulate a full task row or the websocket broadcaster.
    vi.doMock("../db/tasks.js", () => ({
      getTaskById: vi.fn().mockResolvedValue(null),
    }));

    taskClaimer = await import("../agent/task-claimer.js");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caches getAvailableTaskCount results within the TTL (baseline behavior)", async () => {
    mockTx.run.mockResolvedValue(countResult(0));
    const first = await taskClaimer.getAvailableTaskCount(undefined, "todo");
    expect(first).toBe(0);

    // The DB would now return a different count, but the cache should still
    // serve the stale value within the TTL window.
    mockTx.run.mockResolvedValue(countResult(5));
    const second = await taskClaimer.getAvailableTaskCount(undefined, "todo");
    expect(second).toBe(0);
    expect(mockTx.run).toHaveBeenCalledTimes(1);
  });

  it("notifyTaskAvailable invalidates the count cache so the next check sees fresh data", async () => {
    mockTx.run.mockResolvedValue(countResult(0));
    await taskClaimer.getAvailableTaskCount(undefined, "todo"); // primes cache with a stale 0

    mockTx.run.mockResolvedValue(countResult(3));
    taskClaimer.notifyTaskAvailable();

    const fresh = await taskClaimer.getAvailableTaskCount(undefined, "todo");
    expect(fresh).toBe(3);
    expect(mockTx.run).toHaveBeenCalledTimes(2); // cache bypassed, real query happened
  });

  it("waitForTaskAvailable resolves once notifyTaskAvailable fires, not before", async () => {
    mockTx.run.mockResolvedValue(countResult(0));
    const controller = new AbortController();

    let resolved = false;
    const done = taskClaimer
      .waitForTaskAvailable(undefined, "todo", controller.signal)
      .then(() => { resolved = true; });

    await delay(20);
    expect(resolved).toBe(false);

    taskClaimer.notifyTaskAvailable();
    await done;
    expect(resolved).toBe(true);
  });

  it("waitForTaskAvailable resolves when the AbortSignal fires", async () => {
    mockTx.run.mockResolvedValue(countResult(0));
    const controller = new AbortController();

    let resolved = false;
    const done = taskClaimer
      .waitForTaskAvailable(undefined, "todo", controller.signal)
      .then(() => { resolved = true; });

    await delay(20);
    expect(resolved).toBe(false);

    controller.abort();
    await done;
    expect(resolved).toBe(true);
  });

  it("waitForTaskAvailable resolves via the fallback timer if a wake-up signal is ever missed", async () => {
    vi.useFakeTimers();
    mockTx.run.mockResolvedValue(countResult(0));
    const controller = new AbortController();

    let resolved = false;
    const done = taskClaimer
      .waitForTaskAvailable(undefined, "todo", controller.signal)
      .then(() => { resolved = true; });

    // Let the fast-path async COUNT check settle so we're parked and the
    // fallback setTimeout has actually been registered.
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // No "task-available" event and no abort — only the 5-minute fallback
    // (matching FALLBACK_POLL_MS in task-claimer.ts) should wake it.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    await done;
    expect(resolved).toBe(true);
  });

  it("resolveTask (the dev -> review -> qa handoff) wakes idle loops waiting on the next stage", async () => {
    // Prime the cache with a stale "0" for the reviewer's claim state,
    // exactly as if a review-agent loop had just gone idle.
    mockTx.run.mockResolvedValue(countResult(0));
    await taskClaimer.getAvailableTaskCount(undefined, "developed");

    const controller = new AbortController();
    let woken = false;
    const waitDone = taskClaimer
      .waitForTaskAvailable(undefined, "developed", controller.signal)
      .then(() => { woken = true; });

    await delay(20);
    expect(woken).toBe(false);

    // resolveTask's own SET, followed by the fresh COUNT once the cache
    // has been invalidated.
    mockTx.run
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValue(countResult(1));

    await taskClaimer.resolveTask(42, "developed");

    await waitDone;
    expect(woken).toBe(true);

    const fresh = await taskClaimer.getAvailableTaskCount(undefined, "developed");
    expect(fresh).toBe(1);
  });

  it("resetTask still wakes idle loops (pre-existing behavior, guards against regression)", async () => {
    mockTx.run.mockResolvedValue(countResult(0));
    await taskClaimer.getAvailableTaskCount(undefined, "todo");

    const controller = new AbortController();
    let woken = false;
    const waitDone = taskClaimer
      .waitForTaskAvailable(undefined, "todo", controller.signal)
      .then(() => { woken = true; });

    await delay(20);
    expect(woken).toBe(false);

    mockTx.run
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValue(countResult(1));

    await taskClaimer.resetTask(7, "todo");

    await waitDone;
    expect(woken).toBe(true);
  });
});

// ============================================================================
// Structural tests: backend/src/routes/tasks.ts wiring
//
// These follow the same "read the source, verify the fixed handler contains
// the expected call" pattern already used in session-pin-reorder-fixes.test.ts
// for route-adjacent functions, since exercising the Express routes directly
// would require a full HTTP test harness not currently used in this project.
// ============================================================================
describe("routes/tasks.ts — notifyTaskAvailable wiring", () => {
  async function readRoutesSource(): Promise<string> {
    const fs = await import("node:fs");
    return fs.readFileSync(new URL("../routes/tasks.ts", import.meta.url), "utf-8");
  }

  it("POST / (create task) calls notifyTaskAvailable", async () => {
    const source = await readRoutesSource();
    const match = source.match(/router\.post\("\/",[\s\S]*?^\}\);/m);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("notifyTaskAvailable()");
  });

  it("PUT /:id calls notifyTaskAvailable when the update includes a state change", async () => {
    const source = await readRoutesSource();
    const match = source.match(/router\.put\("\/:id",[\s\S]*?^\}\);/m);
    expect(match).not.toBeNull();
    const body = match![0];

    expect(body).toContain("notifyTaskAvailable()");
    // Must be gated on the update actually touching state, not fired
    // unconditionally on every PUT (e.g. a plain title/description edit).
    expect(body).toContain("input.state !== undefined");
  });

  it("POST /:id/tabs calls notifyTaskAvailable after assigning tabs", async () => {
    const source = await readRoutesSource();
    const match = source.match(/router\.post\("\/:id\/tabs",[\s\S]*?^\}\);/m);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("notifyTaskAvailable()");
  });
});
