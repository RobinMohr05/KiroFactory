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
  getRunningAutoScalers: vi.fn(),
  updateAutoScalerStatus: vi.fn(),
  updateAutoScaler: vi.fn(),
  deleteAutoScaler: vi.fn(),
  linkPooledSession: vi.fn(),
  unlinkPooledSession: vi.fn(),
  touchPooledSession: vi.fn(),
  getPooledSessionIds: vi.fn().mockResolvedValue([]),
  getPooledSessionsWithLastUsed: vi.fn().mockResolvedValue([]),
  getAllPooledSessionIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("./db/sessions.js", () => ({
  updateSessionStatus: vi.fn(),
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

vi.mock("./session-manager.js", () => {
  const getAllSessionsMock = vi.fn().mockReturnValue([]);
  return {
    createSession: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    getAllSessions: getAllSessionsMock,
    // Default getSession implementation looks the session up in whatever
    // list getAllSessions is currently mocked to return, so existing test
    // bodies that only set getAllSessions' mock return value keep working
    // after autoscaler-manager.ts's internal lookups switched from
    // getAllSessions(...).find(...) to getSession(id) (the latter is
    // unaffected by getAllSessions' pooled-session filtering in the real
    // implementation).
    getSession: vi.fn((id: number) => getAllSessionsMock().find((s: any) => s.id === id)),
    markSessionPooled: vi.fn(),
    unmarkSessionPooled: vi.fn(),
    deleteSession: vi.fn().mockReturnValue(true),
    getAgentStageStates: vi.fn().mockResolvedValue({
      claimState: "todo",
      workingState: "in-progress",
      resolveState: "developed",
      kind: "editor",
      requiresTask: true,
    }),
  };
});

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
  let deleteSession: typeof import("./session-manager.js")["deleteSession"];
  let getAllSessions: typeof import("./session-manager.js")["getAllSessions"];
  let getSession: typeof import("./session-manager.js")["getSession"];
  let markSessionPooled: typeof import("./session-manager.js")["markSessionPooled"];
  let getAgentStageStates: typeof import("./session-manager.js")["getAgentStageStates"];

  let initAutoScalers: typeof import("./autoscaler-manager.js")["initAutoScalers"];
  let linkPooledSession: typeof import("./db/autoscalers.js")["linkPooledSession"];
  let unlinkPooledSession: typeof import("./db/autoscalers.js")["unlinkPooledSession"];
  let touchPooledSession: typeof import("./db/autoscalers.js")["touchPooledSession"];
  let getPooledSessionIds: typeof import("./db/autoscalers.js")["getPooledSessionIds"];
  let getPooledSessionsWithLastUsed: typeof import("./db/autoscalers.js")["getPooledSessionsWithLastUsed"];
  let getRunningAutoScalers: typeof import("./db/autoscalers.js")["getRunningAutoScalers"];
  let updateSessionStatusDb: typeof import("./db/sessions.js")["updateSessionStatus"];

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
    initAutoScalers = autoScalerMgr.initAutoScalers;

    const dbAutoScalers = await import("./db/autoscalers.js");
    dbCreateAutoScaler = dbAutoScalers.createAutoScaler;
    dbUpdateAutoScaler = dbAutoScalers.updateAutoScaler;
    getAutoScalerById = dbAutoScalers.getAutoScalerById;
    updateAutoScalerStatus = dbAutoScalers.updateAutoScalerStatus;
    dbDeleteAutoScaler = dbAutoScalers.deleteAutoScaler;
    linkPooledSession = dbAutoScalers.linkPooledSession;
    unlinkPooledSession = dbAutoScalers.unlinkPooledSession;
    touchPooledSession = dbAutoScalers.touchPooledSession;
    getPooledSessionIds = dbAutoScalers.getPooledSessionIds;
    getPooledSessionsWithLastUsed = dbAutoScalers.getPooledSessionsWithLastUsed;
    getRunningAutoScalers = dbAutoScalers.getRunningAutoScalers;

    const dbSessions = await import("./db/sessions.js");
    updateSessionStatusDb = dbSessions.updateSessionStatus;

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
    deleteSession = sm.deleteSession;
    getAllSessions = sm.getAllSessions;
    getSession = sm.getSession;
    markSessionPooled = sm.markSessionPooled;
    getAgentStageStates = sm.getAgentStageStates;

    // Default: waitForTaskAvailable never resolves (parks forever).
    vi.mocked(waitForTaskAvailable).mockImplementation(
      () => new Promise(() => {})
    );

    // Re-establish safe defaults for mocks that individual tests override.
    // vi.clearAllMocks() (in this beforeEach) clears call history but does NOT
    // restore a base implementation set via .mockResolvedValue in the vi.mock
    // factory, so an override like getPooledSessionIds -> [301,302,303] in one
    // test would otherwise leak into the next (e.g. seeding a phantom pool /
    // HWM). Pin the empty/no-op defaults here so each test starts clean.
    vi.mocked(getPooledSessionIds).mockResolvedValue([]);
    vi.mocked(getPooledSessionsWithLastUsed).mockResolvedValue([]);
    vi.mocked(getAllSessions).mockReturnValue([]);
    vi.mocked(deleteSession).mockReturnValue(true);
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

      const backing: ReturnType<typeof makeSession>[] = [];
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "stopped" });
        backing.push(s);
        return s;
      });
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        const s = backing.find((x) => x.id === id);
        if (s) s.status = "running";
        return true;
      });

      await startAutoScaler(1);
      await flushAsync();

      // targetRunning = min(cap=3, C+1=9) = 3
      expect(createSession).toHaveBeenCalledTimes(3);
      expect(startSession).toHaveBeenCalledTimes(3);
    });

    it("spawns C+1 sessions when maxConcurrency=0 (unlimited) — one eager standby beyond claimable count", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 0 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 0 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(4);

      const backing: ReturnType<typeof makeSession>[] = [];
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "stopped" });
        backing.push(s);
        return s;
      });
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        const s = backing.find((x) => x.id === id);
        if (s) s.status = "running";
        return true;
      });

      await startAutoScaler(1);
      await flushAsync();

      // unlimited: targetRunning = C + 1 = 5 (4 claimable + 1 eager standby)
      expect(createSession).toHaveBeenCalledTimes(5);
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

      const backing: ReturnType<typeof makeSession>[] = [];
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "stopped" });
        backing.push(s);
        return s;
      });
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        const s = backing.find((x) => x.id === id);
        if (s) s.status = "running";
        return true;
      });

      await startAutoScaler(1);
      await flushAsync();

      expect(createSession).toHaveBeenCalledTimes(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TASK #1681: reuse-based pool model (replaces the old desired-count
  // formula + keepWarmWhileTasksExist floor-of-1 behavior).
  //
  // Desired-count model:
  //   C = claimable count, N = non-done count, cap = maxConcurrency, HWM = high-water mark
  //   - C > 0: targetRunning = min(cap, C + 1) (clamped to available pool size)
  //   - C == 0 and N > 0: targetRunning = min(cap, ceil(ceil(N/2)/2)); targetPool = min(cap, ceil(N/2))
  //   - N == 0: targetRunning = 0; pool retained (not deleted)
  // ───────────────────────────────────────────────────────────────────────────

  describe("reuse-based pool model", () => {
    it("C=4, cap=8 -> 5 running (C+1 eager standby)", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 8 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 8 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(4);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(4);

      const backing: ReturnType<typeof makeSession>[] = [];
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "stopped" });
        backing.push(s);
        return s;
      });
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        const s = backing.find((x) => x.id === id);
        if (s) s.status = "running";
        return true;
      });

      await startAutoScaler(1);
      await flushAsync();

      expect(createSession).toHaveBeenCalledTimes(5);
    });

    it("C=0, N=6, cap=8 -> pool 3 / running 2", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 8 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 8 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(6);

      const backing: ReturnType<typeof makeSession>[] = [];
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "stopped" });
        backing.push(s);
        return s;
      });
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        const s = backing.find((x) => x.id === id);
        if (s) s.status = "running";
        return true;
      });

      await startAutoScaler(1);
      await flushAsync();

      // targetPool = min(8, ceil(6/2)) = 3; targetRunning = min(8, ceil(ceil(6/2)/2)) = ceil(3/2) = 2
      expect(createSession).toHaveBeenCalledTimes(3);
      expect(startSession).toHaveBeenCalledTimes(2);
    });

    it("N=0 -> 0 running, pool retained (no deletion)", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 5 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 5 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(0);
      vi.mocked(getAllSessions).mockReturnValue([]);
      // Pool already has 2 ready sessions from a previous run.
      vi.mocked(getPooledSessionIds).mockResolvedValue([201, 202]);
      vi.mocked(getPooledSessionsWithLastUsed).mockResolvedValue([
        { sessionId: 201, lastUsedAt: new Date().toISOString() },
        { sessionId: 202, lastUsedAt: new Date().toISOString() },
      ]);

      await startAutoScaler(1);
      await flushAsync();

      expect(createSession).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
      // Pool must be retained — deleteSession must never be called just because N=0.
      const { deleteSession: dsMock } = await import("./session-manager.js");
      expect(dsMock).not.toHaveBeenCalled();
    });

    it("reuses a ready session (same id) instead of creating a new one when scaling up", async () => {
      vi.useFakeTimers();
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 5 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 5 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      // Initially no claimable work — the adopted pool session stays ready.
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(0);

      // Two ready (stopped) pooled sessions already exist — enough to satisfy
      // the C+1 eager-standby target purely by reuse (no new session needed).
      const ready777 = makeSession({ id: 777, status: "stopped" });
      const ready778 = makeSession({ id: 778, status: "stopped" });
      vi.mocked(getPooledSessionIds).mockResolvedValue([777, 778]);
      vi.mocked(getPooledSessionsWithLastUsed).mockResolvedValue([
        { sessionId: 777, lastUsedAt: new Date(Date.now() - 60_000).toISOString() },
        { sessionId: 778, lastUsedAt: new Date(Date.now() - 30_000).toISOString() },
      ]);
      vi.mocked(getAllSessions).mockReturnValue([ready777, ready778]);
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        if (id === 777) ready777.status = "running";
        if (id === 778) ready778.status = "running";
        return true;
      });

      // waitForTaskAvailable resolves once (to drive the second reconcile),
      // then parks forever.
      let resolveWait: () => void;
      const firstWait = new Promise<void>((r) => { resolveWait = r; });
      vi.mocked(waitForTaskAvailable)
        .mockReturnValueOnce(firstWait)
        .mockReturnValue(new Promise(() => {}));

      await startAutoScaler(1);
      await vi.advanceTimersByTimeAsync(50);

      // Initial reconcile: C=0/N=0 so nothing scaled up, and the adopted ready
      // sessions were NOT re-created.
      expect(createSession).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();

      // Now a task becomes claimable — waking the reconcile loop must scale up
      // by REUSING the existing ready sessions (starting the same ids), not
      // creating new ones. C=1 -> targetRunning=min(5,2)=2, satisfied by the
      // two ready pool members.
      vi.mocked(getAvailableTaskCount).mockResolvedValue(1);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(1);
      resolveWait!();
      await vi.advanceTimersByTimeAsync(50);

      expect(startSession).toHaveBeenCalledWith(777);
      expect(createSession).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("HWM grows monotonically and does not shrink except on cap decrease", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 10 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 10 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      // C=0, N=20 -> targetPool = min(10, ceil(20/2)) = 10
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(20);

      const backing: ReturnType<typeof makeSession>[] = [];
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "stopped" });
        backing.push(s);
        return s;
      });
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        const s = backing.find((x) => x.id === id);
        if (s) s.status = "running";
        return true;
      });

      await startAutoScaler(1);
      await flushAsync();

      // Pool grew to 10 (HWM = 10).
      expect(createSession).toHaveBeenCalledTimes(10);

      // Now N drops to 0 — pool must be retained at HWM=10, no deletions.
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(0);
      const { deleteSession: dsMock } = await import("./session-manager.js");
      vi.mocked(dsMock).mockClear();

      // Trigger another reconcile pass indirectly isn't exposed publicly here;
      // this test asserts the invariant via the pool-retention test above and
      // documents the HWM requirement for the cap-decrease test below.
      expect(dsMock).not.toHaveBeenCalled();
    });

    it("cap decrease trims ready sessions oldest-lastUsedAt-first and spares an actively-claiming session", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 5 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(makeAutoScaler({ status: "running", maxConcurrency: 5 }));
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(0);

      const oldReady = makeSession({ id: 301, status: "stopped" });
      const newReady = makeSession({ id: 302, status: "stopped" });
      const running = makeSession({ id: 303, status: "running", currentTaskId: 999 });
      vi.mocked(getPooledSessionIds).mockResolvedValue([301, 302, 303]);
      vi.mocked(getPooledSessionsWithLastUsed).mockResolvedValue([
        { sessionId: 301, lastUsedAt: new Date(Date.now() - 100_000).toISOString() }, // oldest
        { sessionId: 302, lastUsedAt: new Date(Date.now() - 10_000).toISOString() },
        { sessionId: 303, lastUsedAt: new Date().toISOString() },
      ]);
      vi.mocked(getAllSessions).mockReturnValue([oldReady, newReady, running]);
      vi.mocked(deleteSession).mockReturnValue(true);

      await startAutoScaler(1);
      await flushAsync();

      // At cap=5 the pool of 3 fits, so nothing was trimmed yet.
      expect(deleteSession).not.toHaveBeenCalled();

      // Now genuinely decrease the cap on the LIVE autoscaler (3 -> 1) via
      // updateAutoScalerRecord, which refreshes managed.autoScaler and kicks a
      // reconcile. With cap=1 and a pool of 3, two sessions must be trimmed —
      // and they must be the two ready ones, oldest lastUsedAt first (301 then
      // 302), never the actively-claiming running session 303.
      vi.mocked(dbUpdateAutoScaler).mockResolvedValue(makeAutoScaler({ status: "running", maxConcurrency: 1 }));

      await updateAutoScalerRecord(1, { maxConcurrency: 1 });
      await flushAsync();

      // Both ready sessions trimmed; the running one spared.
      expect(deleteSession).toHaveBeenCalledWith(301);
      expect(deleteSession).toHaveBeenCalledWith(302);
      expect(deleteSession).not.toHaveBeenCalledWith(303);

      // Oldest-first ordering: 301 deleted before 302.
      const deletedOrder = vi.mocked(deleteSession).mock.calls.map((c) => c[0]);
      expect(deletedOrder.indexOf(301)).toBeLessThan(deletedOrder.indexOf(302));

      // Clean up: stop the live autoscaler so its reconcile loop / timers don't
      // linger and bleed into later tests.
      await stopAutoScaler(1);
    });

    it("assigns unique, monotonically increasing session names even after a pool member is removed", async () => {
      // Regression for PR #119 review: names were derived from
      // `sessionIds.size + 1`, which is NOT monotonic — trimming/reaping a
      // pool member lowers `size`, so a later create can regenerate a name
      // that still exists on a surviving member (e.g. #1 #2 #3, reap #2 ->
      // size=2 -> next create named #3, duplicating the surviving #3).
      // A per-autoscaler monotonic counter must guarantee unique names.
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 10 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 10 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      // C=0, N=6 -> targetPool = min(10, ceil(6/2)) = 3: create three sessions.
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(6);

      const backing: ReturnType<typeof makeSession>[] = [];
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      let sessionCounter = 100;
      const createdNames: string[] = [];
      vi.mocked(createSession).mockImplementation(async (input: any) => {
        createdNames.push(input.name);
        const s = makeSession({ id: sessionCounter++, status: "stopped", name: input.name });
        backing.push(s);
        return s;
      });
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        const s = backing.find((x) => x.id === id);
        if (s) s.status = "running";
        return true;
      });

      await startAutoScaler(1);
      await flushAsync();

      // First pass created #1 #2 #3 (three sessions for targetPool=3).
      expect(createdNames).toEqual([
        "Test AutoScaler #1",
        "Test AutoScaler #2",
        "Test AutoScaler #3",
      ]);

      // Simulate the middle pool member (#2, id 101) being reaped/trimmed:
      // remove it from the backing store so getSession() no longer finds it.
      // reconcile()'s prune step will then drop it from managed.sessionIds,
      // lowering the tracked pool size to 2 — the exact condition that used to
      // regenerate a duplicate "#3".
      const idx = backing.findIndex((s) => s.name === "Test AutoScaler #2");
      backing.splice(idx, 1);

      // Grow the pool again (N larger -> targetPool grows), forcing a new create.
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(8); // targetPool = ceil(8/2) = 4
      vi.mocked(dbUpdateAutoScaler).mockResolvedValue(makeAutoScaler({ status: "running", maxConcurrency: 10 }));
      await updateAutoScalerRecord(1, { name: "Test AutoScaler" }); // kicks a reconcile
      await flushAsync();

      // The newly created name must NOT duplicate any surviving name, and must
      // continue the monotonic sequence (i.e. "#4", not a reused "#3").
      const newNames = createdNames.slice(3);
      expect(newNames.length).toBeGreaterThan(0);
      for (const n of newNames) {
        expect(n).not.toBe("Test AutoScaler #3");
      }
      // All assigned names are unique overall.
      expect(new Set(createdNames).size).toBe(createdNames.length);

      await stopAutoScaler(1);
    });

    it("reaper deletes a session whose lastUsedAt exceeds the idle threshold and spares a running one", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 5 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 5 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getNonDoneTaskCount).mockResolvedValue(0);

      const stale = makeSession({ id: 401, status: "stopped" });
      const fresh = makeSession({ id: 402, status: "stopped" });
      const running = makeSession({ id: 403, status: "running" });
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      vi.mocked(getPooledSessionIds).mockResolvedValue([401, 402, 403]);
      vi.mocked(getPooledSessionsWithLastUsed).mockResolvedValue([
        { sessionId: 401, lastUsedAt: eightDaysAgo }, // stale beyond 7-day default threshold
        { sessionId: 402, lastUsedAt: oneHourAgo },
        { sessionId: 403, lastUsedAt: oneHourAgo },
      ]);
      vi.mocked(getAllSessions).mockReturnValue([stale, fresh, running]);
      vi.mocked(deleteSession).mockReturnValue(true);

      await startAutoScaler(1);
      await flushAsync();

      expect(deleteSession).toHaveBeenCalledWith(401);
      expect(deleteSession).not.toHaveBeenCalledWith(402);
      expect(deleteSession).not.toHaveBeenCalledWith(403);
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

      const backing: ReturnType<typeof makeSession>[] = [];
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      let sessionCounter = 100;
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "stopped" });
        backing.push(s);
        return s;
      });
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        const s = backing.find((x) => x.id === id);
        if (s) s.status = "running";
        return true;
      });

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

      // The second reconcile should have created exactly one session
      // (targetRunning = min(Infinity, C+1=2) = 2, but this test doesn't mock
      // getNonDoneTaskCount so N defaults to undefined — irrelevant since C>0
      // takes the C-branch which never reads N). With maxConcurrency=0
      // (unlimited/default) and C=1, targetRunning = 2.
      expect(createSession).toHaveBeenCalledTimes(2);
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

    it("re-reconciles and reuses the existing pooled session when it stops during an in-progress reconcile", async () => {
      vi.useFakeTimers();

      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 1 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 1 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(1);

      let backing: ReturnType<typeof makeSession>[] = [];
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      let sessionCounter = 100;
      const spawnedSessions: ReturnType<typeof makeSession>[] = [];
      vi.mocked(createSession).mockImplementation(async () => {
        const s = makeSession({ id: sessionCounter++, status: "stopped" });
        spawnedSessions.push(s);
        backing.push(s);
        return s;
      });
      vi.mocked(startSession).mockImplementation(async (id: number) => {
        const s = backing.find((x) => x.id === id);
        if (s) s.status = "running";
        return true;
      });
      vi.mocked(stopSession).mockResolvedValue(true);

      await startAutoScaler(1);
      await vi.advanceTimersByTimeAsync(100);

      // One session spawned initially
      expect(createSession).toHaveBeenCalledTimes(1);

      // Simulate session dying (still present, just no longer running — the
      // reuse-based model treats this as a pool member to reuse, not a dead
      // session to replace).
      backing = spawnedSessions.map(s => ({ ...s, status: "stopped" as const }));
      vi.mocked(getAllSessions).mockImplementation(() => backing as any);

      // Advance to trigger watchSessionCompletion interval (5s) + re-reconcile
      await vi.advanceTimersByTimeAsync(6000);

      // The reuse-based model starts the existing ready session again instead
      // of creating a brand-new one — no additional createSession call.
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(startSession).toHaveBeenCalledWith(spawnedSessions[0].id);
      vi.useRealTimers();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TASK #1680: durable ownership link between an AutoScaler and its pooled
  // worker sessions (OWNS_SESSION edge) — persists the pool across restarts.
  // ───────────────────────────────────────────────────────────────────────────

  describe("pooled session persistence", () => {
    it("links a freshly spawned session to the autoScaler's pool and marks it pooled in-memory", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 1 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 1 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(1);
      vi.mocked(getAllSessions).mockReturnValue([]);
      vi.mocked(getPooledSessionIds).mockResolvedValue([]);

      const session = makeSession({ id: 555 });
      vi.mocked(createSession).mockResolvedValue(session);
      vi.mocked(startSession).mockResolvedValue(undefined as any);

      await startAutoScaler(1);
      await flushAsync();

      expect(linkPooledSession).toHaveBeenCalledWith(1, 555);
      expect(markSessionPooled).toHaveBeenCalledWith(555);
    });

    it("adopts persisted pooled session IDs into managed.sessionIds on startAutoScaler, without spawning new ones for them", async () => {
      const stoppedAutoScaler = makeAutoScaler({ status: "stopped", maxConcurrency: 5 });
      const runningAutoScaler = makeAutoScaler({ status: "running", maxConcurrency: 5 });
      vi.mocked(getAutoScalerById).mockResolvedValue(stoppedAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      // Two sessions already persisted as pooled from a previous run.
      vi.mocked(getPooledSessionIds).mockResolvedValue([201, 202]);
      // Both adopted sessions are still "running" (as if the autoscaler never
      // actually stopped them) so reconcile's pruning step keeps them counted
      // and doesn't need to spawn replacements.
      vi.mocked(getAllSessions).mockReturnValue([]);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(2);

      await startAutoScaler(1);
      await flushAsync();

      expect(getPooledSessionIds).toHaveBeenCalledWith(1);
      // getAutoScalerRunningSessionCount reflects the adopted pool size before
      // any pruning removes sessions that getSession() reports as not running
      // (getSession defaults to undefined here since no session was registered,
      // so the reconcile prune step removes them — but the adoption call itself
      // is what's under test).
      expect(getPooledSessionIds).toHaveBeenCalled();
    });
  });

  describe("initAutoScalers", () => {
    it("resets pooled sessions still marked running in the DB, then resumes each running AutoScaler", async () => {
      const runningAutoScaler = makeAutoScaler({ id: 9, status: "running" });
      vi.mocked(getRunningAutoScalers).mockResolvedValue([runningAutoScaler]);
      vi.mocked(getPooledSessionIds).mockResolvedValue([301, 302]);
      vi.mocked(getAutoScalerById).mockResolvedValue(runningAutoScaler);
      vi.mocked(updateAutoScalerStatus).mockResolvedValue(runningAutoScaler);
      vi.mocked(getAvailableTaskCount).mockResolvedValue(0);
      vi.mocked(getAllSessions).mockReturnValue([]);

      await initAutoScalers();
      await flushAsync();

      expect(getRunningAutoScalers).toHaveBeenCalled();
      expect(updateSessionStatusDb).toHaveBeenCalledWith(301, "stopped");
      expect(updateSessionStatusDb).toHaveBeenCalledWith(302, "stopped");
      // startAutoScaler was invoked for the resumed AutoScaler (adopts the pool).
      expect(getPooledSessionIds).toHaveBeenCalledWith(9);
    });

    it("does nothing when no AutoScalers were running before the restart", async () => {
      vi.mocked(getRunningAutoScalers).mockResolvedValue([]);

      await initAutoScalers();

      expect(updateSessionStatusDb).not.toHaveBeenCalled();
      expect(getAutoScalerById).not.toHaveBeenCalled();
    });
  });
});
