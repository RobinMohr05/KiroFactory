/**
 * Tests for autoscaler-manager.ts — auto-scaling session pool orchestration.
 *
 * Uses mocks (no real DB) following the same pattern as
 * idle-loop-task-visibility-fixes.test.ts and session-pin-reorder-fixes.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

vi.mock("./db/autoscalers.js", () => ({
  createAutoScaler: vi.fn(),
  getAutoScalerById: vi.fn(),
  getAllAutoScalers: vi.fn(),
  updateAutoScalerStatus: vi.fn(),
  deleteAutoScaler: vi.fn(),
}));

vi.mock("./websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("./agent/task-claimer.js", () => ({
  getAvailableTaskCount: vi.fn(),
  getNonDoneTaskCount: vi.fn(),
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
// state (the `autoScalers` Map), so we need to ensure clean state between tests.
// Unfortunately vi.resetModules() + dynamic import is needed here.

import type { AutoScaler, Session } from "./types.js";

function makeAutoScaler(overrides: Partial<AutoScaler> = {}): AutoScaler {
  return {
    id: 1,
    name: "Test AutoScaler",
    userId: 1,
    agentName: "developer-agent",
    tabIds: [1],
    maxConcurrency: 5,
    idleTimeoutSeconds: 30,
    keepWarmWhileTasksExist: false,
    status: "stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 100,
    name: "Test AutoScaler #1",
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

describe("autoscaler-manager", () => {
  // We import these at the top, but the mocks are set up before import.
  let createAutoScalerRecord: typeof import("./autoscaler-manager.js")["createAutoScalerRecord"];
  let startAutoScaler: typeof import("./autoscaler-manager.js")["startAutoScaler"];
  let stopAutoScaler: typeof import("./autoscaler-manager.js")["stopAutoScaler"];
  let deleteAutoScalerRecord: typeof import("./autoscaler-manager.js")["deleteAutoScalerRecord"];
  let getAutoScalerRunningSessionCount: typeof import("./autoscaler-manager.js")["getAutoScalerRunningSessionCount"];
  let getAutoScalerSessionCounts: typeof import("./autoscaler-manager.js")["getAutoScalerSessionCounts"];

  let dbCreateAutoScaler: typeof import("./db/autoscalers.js")["createAutoScaler"];
  let getAutoScalerById: typeof import("./db/autoscalers.js")["getAutoScalerById"];
  let updateAutoScalerStatus: typeof import("./db/autoscalers.js")["updateAutoScalerStatus"];
  let dbDeleteAutoScaler: typeof import("./db/autoscalers.js")["deleteAutoScaler"];
  let broadcastToUser: typeof import("./websocket-handler.js")["broadcastToUser"];
  let getAvailableTaskCount: typeof import("./agent/task-claimer.js")["getAvailableTaskCount"];
  let getNonDoneTaskCount: typeof import("./agent/task-claimer.js")["getNonDoneTaskCount"];
  let waitForTaskAvailable: typeof import("./agent/task-claimer.js")["waitForTaskAvailable"];
  let createSession: typeof import("./session-manager.js")["createSession"];
  let startSession: typeof import("./session-manager.js")["startSession"];
  let stopSession: typeof import("./session-manager.js")["stopSession"];
  let getAllSessions: typeof import("./session-manager.js")["getAllSessions"];
  let getAgentStageStates: typeof import("./session-manager.js")["getAgentStageStates"];

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset the autoscaler-manager module to get clean in-memory state.
    vi.resetModules();

    const autoScalerMgr = await import("./autoscaler-manager.js");
    createAutoScalerRecord = autoScalerMgr.createAutoScalerRecord;
    startAutoScaler = autoScalerMgr.startAutoScaler;
    stopAutoScaler = autoScalerMgr.stopAutoScaler;
    deleteAutoScalerRecord = autoScalerMgr.deleteAutoScalerRecord;
    getAutoScalerRunningSessionCount = autoScalerMgr.getAutoScalerRunningSessionCount;
    getAutoScalerSessionCounts = autoScalerMgr.getAutoScalerSessionCounts;

    const dbAutoScalers = await import("./db/autoscalers.js");
    dbCreateAutoScaler = dbAutoScalers.createAutoScaler;
    getAutoScalerById = dbAutoScalers.getAutoScalerById;
    updateAutoScalerStatus = dbAutoScalers.updateAutoScalerStatus;
    dbDeleteAutoScaler = dbAutoScalers.deleteAutoScaler;

    const ws = await import("./websocket-handler.js");
    broadcastToUser = ws.broadcastToUser;

    const tc = await import("./agent/task-claimer.js");
    getAvailableTaskCount = tc.getAvailableTaskCount;
    getNonDoneTaskCount = tc.getNonDoneTaskCount;
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

  afterEach(() => {
    // Always restore real timers even if a test fails mid-way through useFakeTimers
    vi.useRealTimers();
  });

  describe("createAutoScalerRecord", () => {
    it("creates a autoScaler in the DB and broadcasts to the user", async () => {
      const autoScaler = makeAutoScaler();
      vi.mocked(dbCreateAutoScaler).mockResolvedValue(autoScaler);

      const result = await createAutoScalerRecord({
        name: "Test AutoScaler",
        userId: 1,
        agentName: "developer-agent",
        tabIds: [1],
      });

      expect(result).toEqual(autoScaler);
      expect(dbCreateAutoScaler).toHaveBeenCalledWith({
        name: "Test AutoScaler",
        userId: 1,
        agentName: "developer-agent",
        tabIds: [1],
      });
      expect(broadcastToUser).toHaveBeenCalledWith(1, {
        type: "autoscaler-created",
        autoScaler,
      });
    });
  });

  describe("startAutoScaler", () => {
    it("marks the autoScaler as running and broadcasts the update", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped" });
      const runningAutoScaler = makeAutoScaler({ status: "running" });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);

      const result = await startAutoScaler(1);

      expect(result).toEqual(runningAutoScaler);
      expect(updateAutoScalerStatus).toHaveBeenCalledWith(1, "running");
      expect(broadcastToUser).toHaveBeenCalledWith(1, {
        type: "autoscaler-updated",
        autoScaler: runningAutoScaler,
      });
    });

    it("spawns sessions up to maxConcurrency when tasks are available", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 3 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 3 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(8);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++ })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      await startAutoScaler(1);
      await flushAsync();

      // Should have spawned exactly 3 sessions (min(maxConcurrency=3, available=8))
      expect(createSession).toHaveBeenCalledTimes(3);
      expect(startSession).toHaveBeenCalledTimes(3);
    });

    it("spawns one session per task when maxConcurrency=0 (unlimited)", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 0 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 0 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(4);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++ })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      await startAutoScaler(1);
      await flushAsync();

      // unlimited: should spawn 4 sessions (all available tasks)
      expect(createSession).toHaveBeenCalledTimes(4);
    });

    it("spawns no sessions when no tasks are available", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped" });
      const runningAutoScaler = makeAutoScaler({ status: "running" });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getAllSessions).mockReturnValue([]);

      await startAutoScaler(1);
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

      const stoppedAutoScaler = makeAutoScaler({ status: "stopped" });
      const runningAutoScaler = makeAutoScaler({ status: "running" });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getAllSessions).mockReturnValue([]);

      await startAutoScaler(1);
      await flushAsync();

      expect(getAvailableTaskCount).toHaveBeenCalledWith(
        [1],
        "developed",
        "in-code-review"
      );
    });
  });

  describe("stopAutoScaler", () => {
    it("stops all owned sessions and marks autoScaler as stopped", async () => {
      // First start the autoScaler so it has in-memory state
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped" });
      const runningAutoScaler = makeAutoScaler({ status: "running" });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(2);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++, status: "running" })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      vi.mocked(stopSession).mockResolvedValue(true);

      await startAutoScaler(1);
      await flushAsync();

      // Now stop it — need to re-mock updateAutoScalerStatus for the stop call
      const stoppedAutoScalerResult = makeAutoScaler({ status: "stopped" });
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(stoppedAutoScalerResult);

      const result = await stopAutoScaler(1);

      expect(result?.status).toBe("stopped");
      expect(stopSession).toHaveBeenCalled();
      expect(broadcastToUser).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: "autoscaler-updated" })
      );
    });

    it("returns null when autoScaler doesn't exist in DB", async () => {
      // No in-memory autoScaler and DB returns null
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(null);
      const result = await stopAutoScaler(999);
      expect(result).toBeNull();
    });
  });

  describe("deleteAutoScalerRecord", () => {
    it("deletes the autoScaler and broadcasts deletion", async () => {
      const autoScaler = makeAutoScaler();
      vi.mocked(getAutoScalerById).mockResolvedValue(autoScaler);
      vi.mocked(dbDeleteAutoScaler).mockResolvedValue(true);

      const result = await deleteAutoScalerRecord(1);

      expect(result).toBe(true);
      expect(broadcastToUser).toHaveBeenCalledWith(1, {
        type: "autoscaler-deleted",
        autoScalerId: 1,
      });
    });
  });

  describe("getAutoScalerRunningSessionCount", () => {
    it("returns 0 when autoScaler is not running", () => {
      expect(getAutoScalerRunningSessionCount(999)).toBe(0);
    });
  });

  describe("getAutoScalerSessionCounts", () => {
    it("returns an empty map when no autoScalers are running", () => {
      const counts = getAutoScalerSessionCounts();
      expect(counts.size).toBe(0);
    });
  });

  describe("concurrency capping", () => {
    it("does not exceed maxConcurrency even with more tasks available", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 2 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 2 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(10);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++ })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      await startAutoScaler(1);
      await flushAsync();

      expect(createSession).toHaveBeenCalledTimes(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // NEW BEHAVIORS (task #1678):
  //   (a) floor-of-1 in warm mode when only non-claimable non-done tasks exist
  //   (b) scale-up to claimable count, capped by maxConcurrency
  //   (c) extra scale-up session is stopped after idleTimeoutSeconds of no new claim
  //   (d) floor session is NOT stopped on idle while a non-done task exists
  //   (e) keepWarmWhileTasksExist false keeps floor 0
  // ───────────────────────────────────────────────────────────────────────────

  describe("keepWarmWhileTasksExist behavior", () => {
    it("(a) floor-of-1: spawns one session when keepWarmWhileTasksExist=true and non-done tasks exist but nothing is claimable", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", keepWarmWhileTasksExist: true });
      const runningAutoScaler = makeAutoScaler({ status: "running", keepWarmWhileTasksExist: true });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      // No claimable tasks, but 2 non-done tasks exist
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(2);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++ })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      await startAutoScaler(1);
      await flushAsync();

      // Should spawn exactly 1 warm session (floor)
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it("(b) scale-up to claimable count capped by maxConcurrency in warm mode", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", keepWarmWhileTasksExist: true, maxConcurrency: 3 });
      const runningAutoScaler = makeAutoScaler({ status: "running", keepWarmWhileTasksExist: true, maxConcurrency: 3 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      // 5 claimable tasks, but maxConcurrency=3
      vi.mocked(getAvailableTaskCount).mockResolvedValue(5);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(5);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++ })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      await startAutoScaler(1);
      await flushAsync();

      // Should spawn exactly 3 sessions (capped by maxConcurrency)
      expect(createSession).toHaveBeenCalledTimes(3);
    });

    it("(c) extra scale-up sessions are stopped after idleTimeoutSeconds with no new claim", async () => {
      vi.useFakeTimers();
      const idleTimeoutSeconds = 30;
      // keepWarmWhileTasksExist=true: 1 floor session + 2 scale-up sessions = 3 total
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", keepWarmWhileTasksExist: true, maxConcurrency: 3, idleTimeoutSeconds });
      const runningAutoScaler = makeAutoScaler({ status: "running", keepWarmWhileTasksExist: true, maxConcurrency: 3, idleTimeoutSeconds });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(3);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(3);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      const sessions: ReturnType<typeof makeSession>[] = [];
      vi.mocked(createSession).mockImplementation(async () => {
        const session = makeSession({ id: sessionCounter++, status: "running" });
        sessions.push(session);
        return session;
      });
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      vi.mocked(stopSession).mockResolvedValue(true);

      await startAutoScaler(1);
      await vi.advanceTimersByTimeAsync(0);

      // Should have spawned 3 sessions
      expect(createSession).toHaveBeenCalledTimes(3);

      // Make sessions appear as still running for getAllSessions
      vi.mocked(getAllSessions).mockReturnValue(sessions.map(s => ({ ...s, status: "running" as const })));

      // Advance time past idleTimeoutSeconds (no task claims happened)
      await vi.advanceTimersByTimeAsync((idleTimeoutSeconds + 5) * 1000);

      // The 2 extra (non-floor) sessions should have been stopped
      expect(stopSession).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it("(d) floor session is NOT stopped on idle while non-done tasks exist", async () => {
      vi.useFakeTimers();
      const idleTimeoutSeconds = 30;
      // keepWarmWhileTasksExist=true: 0 claimable tasks, but 1 non-done task
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", keepWarmWhileTasksExist: true, maxConcurrency: 5, idleTimeoutSeconds });
      const runningAutoScaler = makeAutoScaler({ status: "running", keepWarmWhileTasksExist: true, maxConcurrency: 5, idleTimeoutSeconds });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(1);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      const sessions: ReturnType<typeof makeSession>[] = [];
      vi.mocked(createSession).mockImplementation(async () => {
        const session = makeSession({ id: sessionCounter++, status: "running" });
        sessions.push(session);
        return session;
      });
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      vi.mocked(stopSession).mockResolvedValue(true);

      await startAutoScaler(1);
      await vi.advanceTimersByTimeAsync(0);

      // Should have spawned exactly 1 floor session
      expect(createSession).toHaveBeenCalledTimes(1);

      // Make the session appear as still running
      vi.mocked(getAllSessions).mockReturnValue(sessions.map(s => ({ ...s, status: "running" as const })));

      // Advance time past idleTimeoutSeconds
      await vi.advanceTimersByTimeAsync((idleTimeoutSeconds + 5) * 1000);

      // The floor session should NOT have been stopped (it's the warm session)
      expect(stopSession).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("(e) keepWarmWhileTasksExist=false keeps floor 0 when no claimable tasks", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", keepWarmWhileTasksExist: false });
      const runningAutoScaler = makeAutoScaler({ status: "running", keepWarmWhileTasksExist: false });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      // No claimable tasks, but there are non-done tasks
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(5);
      vi.mocked(getAllSessions).mockReturnValue([]);

      await startAutoScaler(1);
      await flushAsync();

      // Should NOT spawn any session (floor 0 when keepWarmWhileTasksExist=false)
      expect(createSession).not.toHaveBeenCalled();
    });
  });
});
