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
  updateAutoScaler: vi.fn(),
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
  let updateAutoScalerRecord: typeof import("./autoscaler-manager.js")["updateAutoScalerRecord"];
  let startAutoScaler: typeof import("./autoscaler-manager.js")["startAutoScaler"];
  let stopAutoScaler: typeof import("./autoscaler-manager.js")["stopAutoScaler"];
  let deleteAutoScalerRecord: typeof import("./autoscaler-manager.js")["deleteAutoScalerRecord"];
  let getAutoScalerRunningSessionCount: typeof import("./autoscaler-manager.js")["getAutoScalerRunningSessionCount"];
  let getAutoScalerSessionCounts: typeof import("./autoscaler-manager.js")["getAutoScalerSessionCounts"];

  let dbCreateAutoScaler: typeof import("./db/autoscalers.js")["createAutoScaler"];
  let dbUpdateAutoScaler: typeof import("./db/autoscalers.js")["updateAutoScaler"];
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
    updateAutoScalerRecord = autoScalerMgr.updateAutoScalerRecord;
    startAutoScaler = autoScalerMgr.startAutoScaler;
    stopAutoScaler = autoScalerMgr.stopAutoScaler;
    deleteAutoScalerRecord = autoScalerMgr.deleteAutoScalerRecord;
    getAutoScalerRunningSessionCount = autoScalerMgr.getAutoScalerRunningSessionCount;
    getAutoScalerSessionCounts = autoScalerMgr.getAutoScalerSessionCounts;

    const dbAutoScalers = await import("./db/autoscalers.js");
    dbCreateAutoScaler = dbAutoScalers.createAutoScaler;
    dbUpdateAutoScaler = dbAutoScalers.updateAutoScaler;
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

  describe("updateAutoScalerRecord", () => {
    it("updates the autoScaler in the DB and broadcasts autoscaler-updated to the user", async () => {
      const updatedAutoScaler = makeAutoScaler({ name: "Renamed" });
      vi.mocked(dbUpdateAutoScaler).mockResolvedValue(updatedAutoScaler);

      const result = await updateAutoScalerRecord(1, { name: "Renamed" });

      expect(result).toEqual(updatedAutoScaler);
      expect(dbUpdateAutoScaler).toHaveBeenCalledWith(1, { name: "Renamed" });
      expect(broadcastToUser).toHaveBeenCalledWith(1, {
        type: "autoscaler-updated",
        autoScaler: updatedAutoScaler,
      });
    });

    it("returns null and does not broadcast when the autoScaler does not exist", async () => {
      vi.mocked(dbUpdateAutoScaler).mockResolvedValue(null);

      const result = await updateAutoScalerRecord(999, { name: "Ghost" });

      expect(result).toBeNull();
      expect(broadcastToUser).not.toHaveBeenCalled();
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

      let sessionCounter = 100;
      let taskCounter = 500;
      const sessions: ReturnType<typeof makeSession>[] = [];
      // Each spawned session claims a task (currentTaskId set) so the
      // serialized-spawn gate lets the burst proceed up to the cap.
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "running", currentTaskId: taskCounter++ });
        sessions.push(s);
        return s;
      });
      vi.mocked(getAllSessions).mockImplementation(() =>
        sessions.map((s) => ({ ...s, status: "running" as const }))
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

      let sessionCounter = 100;
      let taskCounter = 500;
      const sessions: ReturnType<typeof makeSession>[] = [];
      // Each spawned session claims a task (currentTaskId set) so the
      // serialized-spawn gate lets the full burst through.
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "running", currentTaskId: taskCounter++ });
        sessions.push(s);
        return s;
      });
      vi.mocked(getAllSessions).mockImplementation(() =>
        sessions.map((s) => ({ ...s, status: "running" as const }))
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

      let sessionCounter = 100;
      let taskCounter = 500;
      const sessions: ReturnType<typeof makeSession>[] = [];
      // Each spawned session claims a task (currentTaskId set) so the
      // serialized-spawn gate lets the burst proceed up to the cap.
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "running", currentTaskId: taskCounter++ });
        sessions.push(s);
        return s;
      });
      vi.mocked(getAllSessions).mockImplementation(() =>
        sessions.map((s) => ({ ...s, status: "running" as const }))
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

      let sessionCounter = 100;
      let taskCounter = 500;
      const sessions: ReturnType<typeof makeSession>[] = [];
      // Each spawned session claims a task (currentTaskId set) so the
      // serialized-spawn gate lets the burst proceed up to the cap.
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "running", currentTaskId: taskCounter++ });
        sessions.push(s);
        return s;
      });
      vi.mocked(getAllSessions).mockImplementation(() =>
        sessions.map((s) => ({ ...s, status: "running" as const }))
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

      let sessionCounter = 100;
      let taskCounter = 500;
      const sessions: ReturnType<typeof makeSession>[] = [];
      // Each spawned session claims a task (currentTaskId set) so the
      // serialized-spawn gate lets the full burst of 3 through. The
      // currentTaskId then stays fixed, so watchSessionIdle sees "no new claim"
      // and idle-times-out the non-floor sessions after idleTimeoutSeconds.
      vi.mocked(createSession).mockImplementation(async () => {
        const session = makeSession({ id: sessionCounter++, status: "running", currentTaskId: taskCounter++ });
        sessions.push(session);
        return session;
      });
      vi.mocked(getAllSessions).mockImplementation(() =>
        sessions.map((s) => ({ ...s, status: "running" as const }))
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      vi.mocked(stopSession).mockResolvedValue(true);

      await startAutoScaler(1);
      await vi.advanceTimersByTimeAsync(0);

      // Should have spawned 3 sessions
      expect(createSession).toHaveBeenCalledTimes(3);

      // Sessions continue to appear running with the same claimed task
      // (already reflected by the getAllSessions implementation above).

      // Advance time past idleTimeoutSeconds (no NEW task claims happened)
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

    it("floor session stops after idleTimeoutSeconds when all tasks become done (nonDoneCount=0)", async () => {
      vi.useFakeTimers();
      const idleTimeoutSeconds = 30;
      // Start with keepWarmWhileTasksExist=true, 0 claimable, 1 non-done task
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", keepWarmWhileTasksExist: true, maxConcurrency: 5, idleTimeoutSeconds });
      const runningAutoScaler = makeAutoScaler({ status: "running", keepWarmWhileTasksExist: true, maxConcurrency: 5, idleTimeoutSeconds });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      // Initially 1 non-done task exists — floor session is spawned and protected
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

      // Advance time to just before the idle timeout — floor session should NOT be stopped
      // because nonDoneCount is still 1
      await vi.advanceTimersByTimeAsync((idleTimeoutSeconds - 5) * 1000);
      expect(stopSession).not.toHaveBeenCalled();

      // Now simulate all tasks becoming done (nonDoneCount = 0)
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(0);

      // Advance past the idle timeout — the floor session should now be stopped
      await vi.advanceTimersByTimeAsync(10 * 1000);

      expect(stopSession).toHaveBeenCalledTimes(1);
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
      // keepWarmWhileTasksExist=false: should never query non-done count
      expect(getNonDoneTaskCount).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THUNDERING-HERD FIX (task #1682):
  //   1. reconcile() serializes spawns: after spawning a session it waits for
  //      that session to OBSERVABLY claim a task (its currentTaskId becomes
  //      non-null) before spawning the next one. If a spawned session parks
  //      without claiming (loses the race for the last task, sees an empty
  //      queue), reconcile stops the burst instead of spawning more sessions
  //      that would immediately idle out.
  //
  //      This deliberately does NOT re-read getAvailableTaskCount between
  //      spawns: that count is cached for COUNT_CACHE_TTL_MS (5s) keyed on
  //      tabIds/claimState/workingState and is only invalidated on
  //      notifyTaskAvailable() (task creation/reset), never on a successful
  //      claim. A whole reconcile pass completes well under 5s, so every
  //      re-read within one pass returns the identical cached value — the
  //      re-check was a no-op that never trimmed the burst. Waiting on the
  //      session's actual claim signal is the only thing that reflects a
  //      sibling winning the race.
  //   2. watchSessionCompletion debounces its re-reconcile call so that
  //      multiple near-simultaneous session deaths (a burst of idle-timeouts
  //      all firing within ~30s of each other) coalesce into a single reconcile
  //      pass rather than each triggering an independent full pass.
  // ───────────────────────────────────────────────────────────────────────────

  describe("thundering-herd prevention", () => {
    it("stops spawning after a spawned session parks without claiming a task", async () => {
      vi.useFakeTimers();
      // Scenario: reconcile sees claimableCount=3 and plans to spawn 3 sessions.
      // The first spawned session never claims a task (its currentTaskId stays
      // undefined — it lost the race / the queue emptied). reconcile must NOT
      // spawn the remaining 2; it should stop the burst after the first parks.
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 5 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 5 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);

      // Count stays 3 the entire time — mirroring production where the 5s
      // cache makes every re-read return the same value within one pass. The
      // ONLY thing that should stop the burst is the spawned session parking.
      vi.mocked(getAvailableTaskCount).mockResolvedValue(3);

      let sessionCounter = 100;
      const sessions: ReturnType<typeof makeSession>[] = [];
      vi.mocked(createSession).mockImplementation(async () => {
        // Spawned session is running but has NOT claimed a task (no currentTaskId).
        const s = makeSession({ id: sessionCounter++, status: "running" });
        sessions.push(s);
        return s;
      });
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      // getAllSessions reports the spawned sessions as running-but-idle
      // (currentTaskId undefined) — i.e. they parked without claiming.
      vi.mocked(getAllSessions).mockImplementation(() =>
        sessions.map((s) => ({ ...s, status: "running" as const }))
      );

      await startAutoScaler(1);
      // Advance well past the claim-wait window so the "did it claim?" poll
      // resolves as "parked" for the first spawned session.
      await vi.advanceTimersByTimeAsync(20000);

      // Only the first session should have been spawned; once it parked the
      // burst stopped.
      expect(createSession).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("keeps spawning while each spawned session claims a task (currentTaskId set)", async () => {
      vi.useFakeTimers();
      // Scenario: 5 tasks claimable, maxConcurrency=3 → plan to spawn 3. Each
      // spawned session promptly claims a task (currentTaskId set), so the
      // burst proceeds to the full planned count of 3.
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 3 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 3 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(5);

      let sessionCounter = 100;
      let taskCounter = 500;
      const sessions: ReturnType<typeof makeSession>[] = [];
      vi.mocked(createSession).mockImplementation(async () => {
        // Each spawned session immediately "claims" a task: currentTaskId set.
        const s = makeSession({
          id: sessionCounter++,
          status: "running",
          currentTaskId: taskCounter++,
        });
        sessions.push(s);
        return s;
      });
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      vi.mocked(getAllSessions).mockImplementation(() =>
        sessions.map((s) => ({ ...s, status: "running" as const }))
      );

      await startAutoScaler(1);
      await vi.advanceTimersByTimeAsync(20000);

      // All 3 planned sessions spawned — each claimed a task so the burst
      // proceeded to the cap.
      expect(createSession).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it("debounces watchSessionCompletion re-reconcile: multiple simultaneous session deaths trigger only one reconcile pass", async () => {
      vi.useFakeTimers();

      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 3 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 3 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);

      // Initial reconcile: 3 tasks → spawn 3 sessions
      vi.mocked(getAvailableTaskCount).mockResolvedValue(3);

      let sessionCounter = 100;
      let taskCounter = 500;
      const sessions: ReturnType<typeof makeSession>[] = [];
      // Each spawned session promptly claims a task (currentTaskId set) so the
      // serialized-spawn gate lets the full burst of 3 through.
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "running", currentTaskId: taskCounter++ });
        sessions.push(s);
        return s;
      });
      // While spawning, getAllSessions reports the running sessions with their
      // claimed task so waitForSessionToClaimOrPark sees each one claim.
      vi.mocked(getAllSessions).mockImplementation(() =>
        sessions.map(s => ({ ...s, status: "running" as const }))
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      vi.mocked(stopSession).mockResolvedValue(true);

      await startAutoScaler(1);
      await vi.advanceTimersByTimeAsync(50);

      expect(createSession).toHaveBeenCalledTimes(3);

      // Now all 3 sessions die "simultaneously" (within a short window):
      // make them appear as stopped
      vi.mocked(getAllSessions).mockReturnValue(
        sessions.map(s => ({ ...s, status: "stopped" as const }))
      );

      // Reset so we can count only re-reconcile-triggered getAgentStageStates calls.
      // getAgentStageStates is called once per reconcile pass (not per spawn), so
      // it's a reliable proxy for "how many separate reconcile passes ran".
      vi.mocked(getAgentStageStates).mockClear();

      // Advance by just past watchSessionCompletion's 5s poll interval — all 3
      // watchers fire "simultaneously", then the 1s debounce expires
      await vi.advanceTimersByTimeAsync(7000);

      // With debouncing, only ONE reconcile pass should have been triggered
      // (not 3 separate ones). getAgentStageStates is called once per reconcile pass.
      expect(getAgentStageStates).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PR REVIEW FIXES:
  //   1. reconcileLoop survives transient errors (no permanent kill)
  //   2. idleTimeoutSeconds=0 logs a warning when session is spawned
  //   3. stages snapshotted once per loop iteration (no redundant DB fetch)
  //   4. pendingReconcile: dropped reconcile while busy re-runs after current pass
  // ───────────────────────────────────────────────────────────────────────────

  describe("reconcileLoop error resilience", () => {
    it("continues looping after a transient reconcile error instead of dying", async () => {
      vi.useFakeTimers();
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped" });
      const runningAutoScaler = makeAutoScaler({ status: "running" });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);

      // First reconcile call throws a transient error; second succeeds with 1 task.
      vi.mocked(getAvailableTaskCount)
        .mockRejectedValueOnce(new Error("Neo4j connection hiccup"))
        .mockResolvedValue(1);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++, status: "running" })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      // waitForTaskAvailable resolves once, then parks forever.
      let resolveFirst: () => void;
      const firstWait = new Promise<void>((r) => { resolveFirst = r; });
      vi.mocked(waitForTaskAvailable)
        .mockReturnValueOnce(firstWait)
        .mockReturnValue(new Promise(() => {}));

      await startAutoScaler(1);
      // Flush initial reconcile (will fail) + backoff timer
      await vi.advanceTimersByTimeAsync(6000); // > 5s backoff

      // Trigger second loop iteration
      resolveFirst!();
      await vi.advanceTimersByTimeAsync(100);

      // The second reconcile should have spawned a session
      expect(createSession).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("logs a warning when a reconcile iteration fails", async () => {
      vi.useFakeTimers();
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped" });
      const runningAutoScaler = makeAutoScaler({ status: "running" });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);

      vi.mocked(getAvailableTaskCount).mockRejectedValue(new Error("transient error"));
      vi.mocked(getAllSessions).mockReturnValue([]);

      const { log } = await import("./logger.js");

      await startAutoScaler(1);
      await vi.advanceTimersByTimeAsync(100);

      expect(log.warn).toHaveBeenCalledWith(
        "autoscaler-reconcile-error",
        expect.objectContaining({ component: "autoscaler-manager" })
      );
      vi.useRealTimers();
    });
  });

  describe("idleTimeoutSeconds=0 warning", () => {
    it("logs a warning when idleTimeoutSeconds=0 and a session is spawned", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", idleTimeoutSeconds: 0 });
      const runningAutoScaler = makeAutoScaler({ status: "running", idleTimeoutSeconds: 0 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(1);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () =>
        makeSession({ id: sessionCounter++, status: "running" })
      );
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      const { log } = await import("./logger.js");

      await startAutoScaler(1);
      await flushAsync();

      // Should warn that sessions will run indefinitely (no idle-death)
      expect(log.warn).toHaveBeenCalledWith(
        "autoscaler-no-idle-timeout",
        expect.objectContaining({ component: "autoscaler-manager" })
      );
    });
  });

  describe("pendingReconcile: dropped reconcile re-runs after current pass", () => {
    it("triggers a follow-up reconcile when a session dies during an ongoing reconcile", async () => {
      vi.useFakeTimers();
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 2 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 2 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);

      // Use a deferred first reconcile to simulate a long-running reconcile.
      let resolveFirstReconcile: () => void;
      const firstReconcileGate = new Promise<void>((r) => { resolveFirstReconcile = r; });

      vi.mocked(getAvailableTaskCount)
        // First call blocks until we release it (simulating slow DB query).
        .mockReturnValueOnce(firstReconcileGate.then(() => 1))
        // Subsequent calls return 1 (for the re-reconcile triggered by session death).
        .mockResolvedValue(1);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      const spawnedSessions: ReturnType<typeof makeSession>[] = [];
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "running" });
        spawnedSessions.push(s);
        return s;
      });
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      vi.mocked(stopSession).mockResolvedValue(true);

      await startAutoScaler(1);
      // First reconcile is blocked waiting for getAvailableTaskCount.

      // Simulate watchSessionCompletion detecting a dead session and calling reconcile
      // while the first reconcile is still in-progress: this should set pendingReconcile=true.
      // We release the gate to let the first reconcile finish.
      resolveFirstReconcile!();
      await vi.advanceTimersByTimeAsync(100);

      // A second reconcile should have been triggered (the pending one).
      // Net result: createSession called at least once.
      expect(createSession).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("re-reconciles when a session completes during an in-progress reconcile", async () => {
      vi.useFakeTimers();

      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 1 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 1 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(1);
      vi.mocked(getAllSessions).mockReturnValue([]);

      let sessionCounter = 100;
      const spawnedSessions: ReturnType<typeof makeSession>[] = [];
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "running" });
        spawnedSessions.push(s);
        return s;
      });
      vi.mocked(startSession).mockResolvedValue(undefined as any);
      vi.mocked(stopSession).mockResolvedValue(true);

      await startAutoScaler(1);
      await vi.advanceTimersByTimeAsync(100);

      // One session spawned initially
      expect(createSession).toHaveBeenCalledTimes(1);

      // Simulate session dying
      vi.mocked(getAllSessions).mockReturnValue(
        spawnedSessions.map(s => ({ ...s, status: "stopped" as const }))
      );

      // Advance to trigger watchSessionCompletion interval (5s) + re-reconcile
      await vi.advanceTimersByTimeAsync(6000);

      // A replacement session should have been spawned
      expect(createSession).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });
});
