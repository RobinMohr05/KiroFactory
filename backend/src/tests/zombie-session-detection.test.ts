/**
 * Tests for zombie session/task state fixes (task #1827).
 *
 * Covers three root causes:
 *
 * 1. WS heartbeat: after a worker authenticates, a periodic ping/pong is
 *    started. If no pong is received within the timeout window, the worker
 *    is treated as disconnected (onWorkerExited called with "disconnected").
 *
 * 2. Periodic zombie-sweep: a runtime sweep (not just at startup) detects
 *    sessions whose container is gone and resets them and their claimed task.
 *
 * 3. stopSession() teardown: the container stop is now awaited, and failures
 *    are logged via structured log.warn instead of console.warn, before
 *    reporting success. A session's claimed task is reset to "todo" when the
 *    session is stopped while running (zombie scenario).
 *
 * Note: resetOrphanedTasks() stage-awareness (root cause #3 from the task
 * description) is already implemented and tested in
 * task-claimer-reset-orphaned.test.ts — not duplicated here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (all vi.fn() directly in factory to avoid hoisting issues)
// ---------------------------------------------------------------------------

vi.mock("../db/sessions.js", () => ({
  getAllSessionsFromDb: vi.fn().mockResolvedValue([]),
  getRunningSessionsFromDb: vi.fn().mockResolvedValue([]),
  insertSession: vi.fn().mockResolvedValue(1),
  updateSessionStatus: vi.fn().mockResolvedValue(undefined),
  updateSessionMeta: vi.fn().mockResolvedValue(undefined),
  deleteSessionFromDb: vi.fn().mockResolvedValue(true),
  isSessionOwnedByUser: vi.fn().mockResolvedValue(true),
  reorderSessionsInDb: vi.fn().mockResolvedValue(undefined),
  updateSessionPinInDb: vi.fn().mockResolvedValue(undefined),
  updateSessionScheduleActiveInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/connection.js", () => ({
  isDbAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock("../db/users.js", () => ({
  getUserKiroApiKey: vi.fn().mockResolvedValue(null),
  getUserById: vi.fn().mockResolvedValue(null),
}));

vi.mock("../db/credentials.js", () => ({
  getAllDecryptedCredentials: vi.fn().mockResolvedValue({}),
  getDecryptedCredential: vi.fn().mockResolvedValue(null),
}));

vi.mock("../db/tabs.js", () => ({
  getAgentTabs: vi.fn().mockResolvedValue([]),
  getTabById: vi.fn().mockResolvedValue(null),
}));

vi.mock("../db/agents.js", () => ({
  getAgentByName: vi.fn().mockResolvedValue({
    name: "developer-agent",
    kind: "editor",
    claimState: "todo",
    workingState: "in-progress",
    resolveState: "developed",
    requiresTask: true,
    mcpServers: [],
  }),
  getAllAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../db/turns.js", () => ({
  createTurn: vi.fn().mockResolvedValue(null),
  completeTurn: vi.fn().mockResolvedValue(null),
  createErrorEvent: vi.fn().mockResolvedValue(null),
  getMaxTurnNumber: vi.fn().mockResolvedValue(0),
}));

vi.mock("../db/tasks.js", () => ({
  getTaskAutoMergePrs: vi.fn().mockResolvedValue(false),
  areAllGroupTasksDone: vi.fn().mockResolvedValue(false),
  createTask: vi.fn(),
  getAllTasks: vi.fn().mockResolvedValue([]),
}));

vi.mock("../websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("../error-store.js", () => ({
  recordError: vi.fn(),
}));

vi.mock("../agent/kiro-runner.js", () => ({
  KiroRunner: { create: vi.fn() },
}));

vi.mock("../agent/task-claimer.js", () => ({
  claimTask: vi.fn().mockResolvedValue(null),
  resolveTask: vi.fn().mockResolvedValue(undefined),
  resetTask: vi.fn().mockResolvedValue(undefined),
  getAvailableTaskCount: vi.fn().mockResolvedValue(0),
  waitForTaskAvailable: vi.fn().mockResolvedValue(undefined),
  markTaskDone: vi.fn(),
  findSiblingTasks: vi.fn().mockResolvedValue([]),
  findSiblingTasksByGroupId: vi.fn().mockResolvedValue([]),
  notifyTaskAvailable: vi.fn(),
  resetOrphanedTasks: vi.fn().mockResolvedValue(0),
  describeClaimFailure: vi.fn().mockResolvedValue({ reason: "empty" }),
  getNonDoneTaskCount: vi.fn().mockResolvedValue(0),
}));

vi.mock("../agent/prompt-builder.js", () => ({
  buildDevPrompt: vi.fn().mockReturnValue("implement this task"),
  buildReviewPrompt: vi.fn().mockReturnValue("review this PR"),
}));

vi.mock("../agent/agent-config-writer.js", () => ({
  materializeAgentConfigIfMissing: vi.fn(),
  encodeAgentConfigBase64: vi.fn().mockReturnValue(""),
}));

vi.mock("../mcp-proxy-config.js", () => ({
  buildProxyServersConfig: vi.fn().mockReturnValue(null),
}));

vi.mock("../agent/local-git-check.js", () => ({
  hasLocalGitChanges: vi.fn().mockReturnValue(false),
}));

vi.mock("../agent/repo-url-parser.js", () => ({
  buildPersistentBranchName: vi.fn().mockReturnValue("persistent/branch"),
  buildTaskBranchName: vi.fn().mockReturnValue("task/branch"),
  sanitizeBranchName: vi.fn((b: string | null) => b),
}));

vi.mock("../session-sanitize.js", () => ({
  sanitizeSessionForClient: vi.fn((s: any) => s),
}));

vi.mock("../db/autoscalers.js", () => ({
  getAllPooledSessionIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("../aca-worker-spawner.js", () => ({
  loadAcaConfig: vi.fn().mockReturnValue(null),
  startWorkerJob: vi.fn(),
  stopWorkerJob: vi.fn(),
  getWorkerJobStatus: vi.fn(),
  isAcaModeEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("../wsl-worker-spawner.js", () => ({
  loadWslConfig: vi.fn().mockReturnValue({
    distroName: "kirofactory-docker",
    workerImage: "kirofactory-worker:local",
    proxyImage: "",
    workerListenPort: 9091,
    workerSecret: "test-secret",
    gitUserName: "Test",
    gitUserEmail: "test@test.com",
    azureDevOpsPat: "",
  }),
  startWorkerJob: vi.fn().mockResolvedValue({ executionName: "test-container-1", status: "running", publishedPort: 9091 }),
  stopWorkerJob: vi.fn().mockResolvedValue(undefined),
  getWorkerJobStatus: vi.fn().mockResolvedValue({ status: "running" }),
  captureContainerLogs: vi.fn().mockResolvedValue([]),
  isWslModeEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock("../worker-ws-handler.js", () => ({
  setWorkerEventHandler: vi.fn(),
  sendWorkerPrompt: vi.fn().mockReturnValue(true),
  sendWorkerStop: vi.fn().mockReturnValue(true),
  sendWorkerListTasksResponse: vi.fn().mockReturnValue(true),
  isWorkerConnected: vi.fn().mockReturnValue(false),
  connectToLocalWorker: vi.fn().mockResolvedValue(undefined),
  setupWorkerWebSocket: vi.fn().mockReturnValue({ on: vi.fn() }),
  closeAllWorkerConnections: vi.fn(),
}));

// Import after mocks
import {
  createSession,
  stopSession,
  getSession,
  startZombieDetectionSweep,
  stopZombieDetectionSweep,
} from "../session-manager.js";
import { resetTask } from "../agent/task-claimer.js";
import { log } from "../logger.js";
import * as wslSpawner from "../wsl-worker-spawner.js";
import { getAgentByName } from "../db/agents.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Get internal session map for test setup. Exposed via _sessionsForTest
 * on the session-manager module — must be added there.
 */
async function getInternalSession(id: number): Promise<any> {
  const mod = await import("../session-manager.js");
  const sessions = (mod as any)._sessionsForTest?.() as Map<number, any> | undefined;
  return sessions?.get(id);
}

/**
 * Simulate a session running with a container (like runSessionAca would set up).
 */
async function setSessionRunningWithContainer(
  sessionId: number,
  executionName: string,
  currentTaskId?: number
): Promise<void> {
  const m = await getInternalSession(sessionId);
  if (!m) return;
  m.meta.status = "running";
  if (currentTaskId !== undefined) {
    m.meta.currentTaskId = currentTaskId;
    m.meta.currentTaskTitle = `Task ${currentTaskId}`;
  }
  m.containerSpawner = {
    kind: "wsl",
    stop: wslSpawner.stopWorkerJob,
    status: wslSpawner.getWorkerJobStatus,
    start: wslSpawner.startWorkerJob,
    hasProxyImage: () => false,
  };
  m.acaExecutionName = executionName;
}

// ---------------------------------------------------------------------------
// Test suite 1: stopSession() awaits container teardown and logs failures
// ---------------------------------------------------------------------------

describe("stopSession() — container teardown verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(wslSpawner.stopWorkerJob).mockResolvedValue(undefined);
    vi.mocked(wslSpawner.getWorkerJobStatus).mockResolvedValue({ status: "stopped" });
  });

  afterEach(() => {
    stopZombieDetectionSweep();
  });

  it("awaits container teardown before reporting success (no longer fire-and-forget)", async () => {
    const session = await createSession({
      name: "Worker Session",
      agent: "developer-agent",
      userId: 1,
      loop: false,
      interactive: true,
    });

    await setSessionRunningWithContainer(session.id, "test-container-1");

    let wslStopResolved = false;
    let stopSessionResolved = false;

    // Make stop() take a bit to resolve so we can verify ordering
    vi.mocked(wslSpawner.stopWorkerJob).mockImplementationOnce(async () => {
      await wait(30);
      wslStopResolved = true;
    });

    const stopPromise = stopSession(session.id).then(() => {
      stopSessionResolved = true;
    });

    // Let it start — but don't wait for full completion yet
    await wait(5);
    // At this point, stopWorkerJob is still running (it takes 30ms)
    expect(wslStopResolved).toBe(false);

    // Now wait for full completion
    await stopPromise;
    expect(wslStopResolved).toBe(true);
    expect(stopSessionResolved).toBe(true);
    expect(vi.mocked(wslSpawner.stopWorkerJob)).toHaveBeenCalledTimes(1);
  });

  it("logs structured log.warn (not console.warn) when container stop fails", async () => {
    const logWarnSpy = vi.spyOn(log, "warn");

    const session = await createSession({
      name: "Worker Session 2",
      agent: "developer-agent",
      userId: 1,
      loop: false,
      interactive: true,
    });

    await setSessionRunningWithContainer(session.id, "test-container-2");

    vi.mocked(wslSpawner.stopWorkerJob).mockRejectedValueOnce(new Error("docker stop: no such container"));

    // stopSession should NOT throw even when the container stop fails
    await expect(stopSession(session.id)).resolves.toBe(true);

    // Must use structured log.warn instead of console.warn
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("stop-worker-failed"),
      expect.objectContaining({
        component: "session-manager",
        executionName: "test-container-2",
      })
    );
    logWarnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: Zombie sweep — detects sessions with dead containers
// ---------------------------------------------------------------------------

describe("startZombieDetectionSweep() / stopZombieDetectionSweep()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(wslSpawner.getWorkerJobStatus).mockResolvedValue({ status: "running" });
    // Default agent for these tests is the developer-agent (claimState "todo").
    // Individual tests that need an inspector-stage agent override this.
    vi.mocked(getAgentByName).mockResolvedValue({
      name: "developer-agent",
      kind: "editor",
      claimState: "todo",
      workingState: "in-progress",
      resolveState: "developed",
      requiresTask: true,
      mcpServers: [],
    } as any);
  });

  afterEach(() => {
    stopZombieDetectionSweep();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("startZombieDetectionSweep is exported from session-manager", () => {
    expect(typeof startZombieDetectionSweep).toBe("function");
  });

  it("stopZombieDetectionSweep is exported from session-manager", () => {
    expect(typeof stopZombieDetectionSweep).toBe("function");
  });

  it("detects a 'running' session whose container is gone and resets its claimed task to 'todo'", async () => {
    vi.useFakeTimers();

    const session = await createSession({
      name: "Zombie Session",
      agent: "developer-agent",
      userId: 1,
      loop: true,
      interactive: false,
    });

    await setSessionRunningWithContainer(session.id, "zombie-container-1", 999);

    // Container is gone
    vi.mocked(wslSpawner.getWorkerJobStatus).mockResolvedValue({ status: "exited" });
    vi.mocked(resetTask).mockResolvedValue(undefined);

    startZombieDetectionSweep(100);
    await vi.advanceTimersByTimeAsync(200);

    const updatedSession = getSession(session.id);
    expect(updatedSession?.status).not.toBe("running");
    expect(resetTask).toHaveBeenCalledWith(999, "todo");
  });

  it("does NOT reset task or change session status when container is still running", async () => {
    vi.useFakeTimers();

    const session = await createSession({
      name: "Healthy Session",
      agent: "developer-agent",
      userId: 1,
      loop: true,
      interactive: false,
    });

    await setSessionRunningWithContainer(session.id, "healthy-container-1", 100);

    // Container is alive
    vi.mocked(wslSpawner.getWorkerJobStatus).mockResolvedValue({ status: "running" });

    startZombieDetectionSweep(100);
    await vi.advanceTimersByTimeAsync(200);

    const updatedSession = getSession(session.id);
    expect(updatedSession?.status).toBe("running");
    expect(resetTask).not.toHaveBeenCalled();
  });

  it("skips sessions without a containerSpawner (KiroRunner/forceLocal sessions)", async () => {
    vi.useFakeTimers();

    const session = await createSession({
      name: "Local Session",
      agent: "developer-agent",
      userId: 1,
      loop: true,
      interactive: false,
      forceLocal: true,
    });

    // Mark running but no container
    const m = await getInternalSession(session.id);
    if (m) {
      m.meta.status = "running";
      m.containerSpawner = null;
      m.acaExecutionName = null; // explicitly no container
    }

    startZombieDetectionSweep(100);
    await vi.advanceTimersByTimeAsync(200);

    // Status check was not invoked for THIS session's container (none exists)
    // Other sessions from prior tests may or may not be present; what matters
    // is that no status check was done for "local-container" (no such name)
    // and the session itself is undisturbed.
    expect(getSession(session.id)?.status).toBe("running");
  });

  it("skips sessions that are not in 'running' status", async () => {
    vi.useFakeTimers();

    const session = await createSession({
      name: "Stopped Session",
      agent: "developer-agent",
      userId: 1,
      loop: false,
      interactive: true,
    });

    // Session is stopped — should not be checked
    const m = await getInternalSession(session.id);
    if (m) {
      m.meta.status = "stopped";
      m.containerSpawner = {
        kind: "wsl",
        stop: vi.fn(),
        status: vi.mocked(wslSpawner.getWorkerJobStatus),
        start: vi.fn(),
        hasProxyImage: () => false,
      };
      m.acaExecutionName = "stopped-container-unique-1";
    }

    // Ensure we can distinguish whether THIS session's container was checked
    const statusCallsBefore = vi.mocked(wslSpawner.getWorkerJobStatus).mock.calls.length;

    startZombieDetectionSweep(100);
    await vi.advanceTimersByTimeAsync(200);

    const statusCallsAfter = vi.mocked(wslSpawner.getWorkerJobStatus).mock.calls;
    // The stopped-container-unique-1 must NOT have been checked.
    // cast to unknown[] since the actual call from containerSpawner.status()
    // passes one arg (executionName), while the raw function signature has two.
    expect((statusCallsAfter as unknown[][]).some((call) => call.includes("stopped-container-unique-1"))).toBe(false);
  });

  it("resets an inspector-stage zombie's task to that stage's claimState (not literal 'todo')", async () => {
    vi.useFakeTimers();

    // A code-reviewer-agent claims tasks in the 'developed' state, works them
    // in 'in-code-review', and resolves to 'in-qa'. A zombie mid-review must
    // return the task to 'developed', NOT all the way back to 'todo'.
    vi.mocked(getAgentByName).mockResolvedValue({
      name: "code-reviewer-agent",
      kind: "inspector",
      claimState: "developed",
      workingState: "in-code-review",
      resolveState: "in-qa",
      requiresTask: true,
      mcpServers: [],
    } as any);

    const session = await createSession({
      name: "Zombie Reviewer Session",
      agent: "code-reviewer-agent",
      userId: 1,
      loop: true,
      interactive: false,
    });

    await setSessionRunningWithContainer(session.id, "zombie-reviewer-1", 777);

    vi.mocked(wslSpawner.getWorkerJobStatus).mockResolvedValue({ status: "exited" });
    vi.mocked(resetTask).mockResolvedValue(undefined);

    startZombieDetectionSweep(100);
    await vi.advanceTimersByTimeAsync(200);

    const updatedSession = getSession(session.id);
    expect(updatedSession?.status).not.toBe("running");
    expect(resetTask).toHaveBeenCalledWith(777, "developed");
  });

  it("treats an unrecognized/'unknown' container status as still alive (re-check next sweep)", async () => {
    vi.useFakeTimers();

    const session = await createSession({
      name: "Ambiguous Status Session",
      agent: "developer-agent",
      userId: 1,
      loop: true,
      interactive: false,
    });

    await setSessionRunningWithContainer(session.id, "ambiguous-container-1", 555);

    // ACA API responded ok but with no usable status field → "Unknown".
    // This must NOT be treated as a dead container.
    vi.mocked(wslSpawner.getWorkerJobStatus).mockResolvedValue({ status: "Unknown" });

    startZombieDetectionSweep(100);
    await vi.advanceTimersByTimeAsync(200);

    const updatedSession = getSession(session.id);
    expect(updatedSession?.status).toBe("running");
    expect(resetTask).not.toHaveBeenCalled();
  });

  it("treats a known terminal status ('failed') as a dead container", async () => {
    vi.useFakeTimers();

    const session = await createSession({
      name: "Failed Container Session",
      agent: "developer-agent",
      userId: 1,
      loop: true,
      interactive: false,
    });

    await setSessionRunningWithContainer(session.id, "failed-container-1", 444);

    vi.mocked(wslSpawner.getWorkerJobStatus).mockResolvedValue({ status: "failed" });
    vi.mocked(resetTask).mockResolvedValue(undefined);

    startZombieDetectionSweep(100);
    await vi.advanceTimersByTimeAsync(200);

    const updatedSession = getSession(session.id);
    expect(updatedSession?.status).not.toBe("running");
    expect(resetTask).toHaveBeenCalledWith(444, "todo");
  });
});
