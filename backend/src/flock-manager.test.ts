/**
 * Tests for flock-manager.ts — auto-scaling session pool orchestration.
 *
 * Uses mocks (no real DB) following the same pattern as
 * idle-loop-task-visibility-fixes.test.ts and session-pin-reorder-fixes.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

vi.mock("./db/flocks.js", () => ({
  createFlock: vi.fn(),
  getFlockById: vi.fn(),
  getAllFlocks: vi.fn(),
  updateFlockStatus: vi.fn(),
  deleteFlock: vi.fn(),
}));

vi.mock("./websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("./agent/task-claimer.js", () => ({
  getAvailableTaskCount: vi.fn(),
  waitForTaskAvailable: vi.fn(),
  notifyTaskAvailable: vi.fn(),
}));

vi.mock("./session-manager.js", () => ({
  createSession: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn(),
  getAllSessions: vi.fn().mockReturnValue([]),
  getAgentStageStates: vi.fn().mockResolvedValue({
    claimState: "todo",
    workingState: "in-progress",
    resolveState: "developed",
    kind: "editor",
    requiresTask: true,
  }),
}));

vi.mock("./logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

// Re-import the module fresh for each test — the module holds in-memory
// state (the `flocks` Map), so we need to ensure clean state between tests.
// Unfortunately vi.resetModules() + dynamic import is needed here.

import type { Flock, Session } from "./types.js";

function makeFlock(overrides: Partial<Flock> = {}): Flock {
  return {
    id: 1,
    name: "Test Flock",
    userId: 1,
    agentName: "developer-agent",
    tabIds: [1],
    maxConcurrency: 5,
    idleTimeoutSeconds: 30,
    status: "stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 100,
    name: "Test Flock #1",
    agent: "developer-agent",
    status: "stopped",
    prompt: "",
    interactive: false,
    loop: true,
    runs: 1,
    intervalSeconds: 10,
    cwd: "/workspace",
    timeoutSeconds: 0,
    userId: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    output: [],
    pinned: false,
    isPermanent: false,
    sortOrder: 0,
    ...overrides,
  };
}

/** Wait for async microtasks/timers to settle. */
async function flushAsync(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("flock-manager", () => {
  // We import these at the top, but the mocks are set up before import.
  let createFlockRecord: typeof import("./flock-manager.js")["createFlockRecord"];
  let startFlock: typeof import("./flock-manager.js")["startFlock"];
  let stopFlock: typeof import("./flock-manager.js")["stopFlock"];
  let deleteFlockRecord: typeof import("./flock-manager.js")["deleteFlockRecord"];
  let getFlockRunningSessionCount: typeof import("./flock-manager.js")["getFlockRunningSessionCount"];
  let getFlockSessionCounts: typeof import("./flock-manager.js")["getFlockSessionCounts"];

  let dbCreateFlock: typeof import("./db/flocks.js")["createFlock"];
  let getFlockById: typeof import("./db/flocks.js")["getFlockById"];
  let updateFlockStatus: typeof import("./db/flocks.js")["updateFlockStatus"];
  let dbDeleteFlock: typeof import("./db/flocks.js")["deleteFlock"];
  let broadcastToUser: typeof import("./websocket-handler.js")["broadcastToUser"];
  let getAvailableTaskCount: typeof import("./agent/task-claimer.js")["getAvailableTaskCount"];
  let waitForTaskAvailable: typeof import("./agent/task-claimer.js")["waitForTaskAvailable"];
  let createSession: typeof import("./session-manager.js")["createSession"];
  let startSession: typeof import("./session-manager.js")["startSession"];
  let stopSession: typeof import("./session-manager.js")["stopSession"];
  let getAllSessions: typeof import("./session-manager.js")["getAllSessions"];
  let getAgentStageStates: typeof import("./session-manager.js")["getAgentStageStates"];

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset the flock-manager module to get clean in-memory state.
    vi.resetModules();

    const flockMgr = await import("./flock-manager.js");
    createFlockRecord = flockMgr.createFlockRecord;
    startFlock = flockMgr.startFlock;
    stopFlock = flockMgr.stopFlock;
    deleteFlockRecord = flockMgr.deleteFlockRecord;
    getFlockRunningSessionCount = flockMgr.getFlockRunningSessionCount;
    getFlockSessionCounts = flockMgr.getFlockSessionCounts;

    const dbFlocks = await import("./db/flocks.js");
    dbCreateFlock = dbFlocks.createFlock;
    getFlockById = dbFlocks.getFlockById;
    updateFlockStatus = dbFlocks.updateFlockStatus;
    dbDeleteFlock = dbFlocks.deleteFlock;

    const ws = await import("./websocket-handler.js");
    broadcastToUser = ws.broadcastToUser;

    const tc = await import("./agent/task-claimer.js");
    getAvailableTaskCount = tc.getAvailableTaskCount;
    waitForTaskAvailable = tc.waitForTaskAvailable;

    const sm = await import("./session-manager.js");
    createSession = sm.createSession;
    startSession = sm.startSession;
    stopSession = sm.stopSession;
    getAllSessions = sm.getAllSessions;
    getAgentStageStates = sm.getAgentStageStates;

    // Default: waitForTaskAvailable never resolves (parks forever).
    vi.mocked(waitForTaskAvailable).mockImplementation(
      () => new Promise(() => {})
    );
  });

  describe("createFlockRecord", () => {
    it("creates a flock in the DB and broadcasts to the user", async () => {
      const flock = makeFlock();
      vi.mocked(dbCreateFlock).mockResolvedValue(flock);

      const result = await createFlockRecord({
        name: "Test Flock",
        userId: 1,
        agentName: "developer-agent",
        tabIds: [1],
      });

      expect(result).toEqual(flock);
      expect(dbCreateFlock).toHaveBeenCalledWith({
        name: "Test Flock",
        userId: 1,
        agentName: "developer-agent",
        tabIds: [1],
      });
      expect(broadcastToUser).toHaveBeenCalledWith(1, {
        type: "flock-created",
        flock,
      });
    });
  });

  describe("startFlock", () => {
    it("marks the flock as running and broadcasts the update", async () => {
      const stoppedFlock = makeFlock({ status: "stopped" });
      const runningFlock = makeFlock({ status: "running" });
      vi.mocked(getFlockById).mockResolvedValue(stoppedFlock);
      vi.mocked(updateFlockStatus).mockResolvedValue(runningFlock);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);

      const result = await startFlock(1);

      expect(result).toEqual(runningFlock);
      expect(updateFlockStatus).toHaveBeenCalledWith(1, "running");
      expect(broadcastToUser).toHaveBeenCalledWith(1, {
        type: "flock-updated",
        flock: runningFlock,
      });
    });

    it("spawns sessions up to maxConcurrency when tasks are available", async () => {
      const stoppedFlock = makeFlock({ status: "stopped", maxConcurrency: 3 });
      const runningFlock = makeFlock({ status: "running", maxConcurrency: 3 });
      vi.mocked(getFlockById).mockResolvedValue(stoppedFlock);
      vi.mocked(updateFlockStatus).mockResolvedValue(runningFlock);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(8);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++ })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      await startFlock(1);
      await flushAsync();

      // Should have spawned exactly 3 sessions (min(maxConcurrency=3, available=8))
      expect(createSession).toHaveBeenCalledTimes(3);
      expect(startSession).toHaveBeenCalledTimes(3);
    });

    it("spawns one session per task when maxConcurrency=0 (unlimited)", async () => {
      const stoppedFlock = makeFlock({ status: "stopped", maxConcurrency: 0 });
      const runningFlock = makeFlock({ status: "running", maxConcurrency: 0 });
      vi.mocked(getFlockById).mockResolvedValue(stoppedFlock);
      vi.mocked(updateFlockStatus).mockResolvedValue(runningFlock);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(4);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++ })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      await startFlock(1);
      await flushAsync();

      // unlimited: should spawn 4 sessions (all available tasks)
      expect(createSession).toHaveBeenCalledTimes(4);
    });

    it("spawns no sessions when no tasks are available", async () => {
      const stoppedFlock = makeFlock({ status: "stopped" });
      const runningFlock = makeFlock({ status: "running" });
      vi.mocked(getFlockById).mockResolvedValue(stoppedFlock);
      vi.mocked(updateFlockStatus).mockResolvedValue(runningFlock);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getAllSessions).mockReturnValue([]);

      await startFlock(1);
      await flushAsync();

      expect(createSession).not.toHaveBeenCalled();
    });

    it("uses the agent's stage states for task counting", async () => {
      vi.mocked(getAgentStageStates).mockResolvedValue({
        claimState: "developed",
        workingState: "in-code-review",
        resolveState: "reviewed",
        kind: "inspector",
        requiresTask: true,
      });

      const stoppedFlock = makeFlock({ status: "stopped" });
      const runningFlock = makeFlock({ status: "running" });
      vi.mocked(getFlockById).mockResolvedValue(stoppedFlock);
      vi.mocked(updateFlockStatus).mockResolvedValue(runningFlock);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getAllSessions).mockReturnValue([]);

      await startFlock(1);
      await flushAsync();

      expect(getAvailableTaskCount).toHaveBeenCalledWith(
        [1],
        "developed",
        "in-code-review"
      );
    });
  });

  describe("stopFlock", () => {
    it("stops all owned sessions and marks flock as stopped", async () => {
      // First start the flock so it has in-memory state
      const stoppedFlock = makeFlock({ status: "stopped" });
      const runningFlock = makeFlock({ status: "running" });
      vi.mocked(getFlockById).mockResolvedValue(stoppedFlock);
      vi.mocked(updateFlockStatus).mockResolvedValue(runningFlock);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(2);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++, status: "running" })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      vi.mocked(stopSession).mockResolvedValue(true);

      await startFlock(1);
      await flushAsync();

      // Now stop it — need to re-mock updateFlockStatus for the stop call
      const stoppedFlockResult = makeFlock({ status: "stopped" });
      vi.mocked(updateFlockStatus).mockResolvedValue(stoppedFlockResult);

      const result = await stopFlock(1);

      expect(result?.status).toBe("stopped");
      expect(stopSession).toHaveBeenCalled();
      expect(broadcastToUser).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: "flock-updated" })
      );
    });

    it("returns null when flock doesn't exist in DB", async () => {
      // No in-memory flock and DB returns null
      vi.mocked(updateFlockStatus).mockResolvedValue(null);
      const result = await stopFlock(999);
      expect(result).toBeNull();
    });
  });

  describe("deleteFlockRecord", () => {
    it("deletes the flock and broadcasts deletion", async () => {
      const flock = makeFlock();
      vi.mocked(getFlockById).mockResolvedValue(flock);
      vi.mocked(dbDeleteFlock).mockResolvedValue(true);

      const result = await deleteFlockRecord(1);

      expect(result).toBe(true);
      expect(broadcastToUser).toHaveBeenCalledWith(1, {
        type: "flock-deleted",
        flockId: 1,
      });
    });
  });

  describe("getFlockRunningSessionCount", () => {
    it("returns 0 when flock is not running", () => {
      expect(getFlockRunningSessionCount(999)).toBe(0);
    });
  });

  describe("getFlockSessionCounts", () => {
    it("returns an empty map when no flocks are running", () => {
      const counts = getFlockSessionCounts();
      expect(counts.size).toBe(0);
    });
  });

  describe("concurrency capping", () => {
    it("does not exceed maxConcurrency even with more tasks available", async () => {
      const stoppedFlock = makeFlock({ status: "stopped", maxConcurrency: 2 });
      const runningFlock = makeFlock({ status: "running", maxConcurrency: 2 });
      vi.mocked(getFlockById).mockResolvedValue(stoppedFlock);
      vi.mocked(updateFlockStatus).mockResolvedValue(runningFlock);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(10);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++ })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      await startFlock(1);
      await flushAsync();

      expect(createSession).toHaveBeenCalledTimes(2);
    });
  });
});
