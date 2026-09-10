/**
 * Tests for session-manager.ts's initSessions() pooled-session exemption
 * (task #1680): sessions owned by an AutoScaler (an incoming
 * (:AutoScaler)-[:OWNS_SESSION]->(:Session) edge) must load as "stopped" on
 * boot and must NOT be auto-restarted by the generic auto-restart path —
 * mirroring the existing cronExpression exemption. They are instead resumed
 * by autoscaler-manager.ts's initAutoScalers() -> startAutoScaler().
 *
 * Uses the same mocking pattern as tests/session-turn-tracking.test.ts,
 * scoped down to only what initSessions() touches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./db/sessions.js", () => ({
  getAllSessionsFromDb: vi.fn().mockResolvedValue([]),
  getRunningSessionsFromDb: vi.fn().mockResolvedValue([]),
  insertSession: vi.fn().mockResolvedValue(1),
  updateSessionStatus: vi.fn().mockResolvedValue(undefined),
  updateSessionMeta: vi.fn().mockResolvedValue(undefined),
  deleteSessionFromDb: vi.fn().mockResolvedValue(true),
  isSessionOwnedByUser: vi.fn().mockResolvedValue(true),
  reorderSessionsInDb: vi.fn().mockResolvedValue(undefined),
  updateSessionPinInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./db/autoscalers.js", () => ({
  getAllPooledSessionIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("./db/connection.js", () => ({
  isDbAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock("./db/users.js", () => ({
  getUserKiroApiKey: vi.fn().mockResolvedValue("fake-key"),
  getUserById: vi.fn().mockResolvedValue({ id: 1, email: "test@test.com", defaultGitProvider: null }),
}));

vi.mock("./db/credentials.js", () => ({
  getAllDecryptedCredentials: vi.fn().mockResolvedValue({}),
  getDecryptedCredential: vi.fn().mockResolvedValue(null),
}));

vi.mock("./db/tabs.js", () => ({
  getAgentTabs: vi.fn().mockResolvedValue([]),
  getTabById: vi.fn().mockResolvedValue(null),
}));

vi.mock("./db/agents.js", () => ({
  getAgentByName: vi.fn().mockResolvedValue(null),
}));

vi.mock("./db/tasks.js", () => ({
  getTaskAutoMergePrs: vi.fn().mockResolvedValue([]),
  areAllGroupTasksDone: vi.fn().mockResolvedValue(false),
  createTask: vi.fn(),
}));

vi.mock("./db/turns.js", () => ({
  createTurn: vi.fn().mockResolvedValue({ number: 1, sessionId: 1, startedAt: "2026-08-20T06:00:00.000Z" }),
  completeTurn: vi.fn().mockResolvedValue(null),
  createErrorEvent: vi.fn().mockResolvedValue(null),
  getMaxTurnNumber: vi.fn().mockResolvedValue(0),
}));

vi.mock("./websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("./error-store.js", () => ({
  recordError: vi.fn(),
}));

vi.mock("./agent/kiro-runner.js", () => ({
  KiroRunner: { create: vi.fn() },
}));

vi.mock("./agent/task-claimer.js", () => ({
  claimTask: vi.fn(),
  resolveTask: vi.fn(),
  resetTask: vi.fn(),
  getAvailableTaskCount: vi.fn().mockResolvedValue(0),
  waitForTaskAvailable: vi.fn(),
  markTaskDone: vi.fn(),
  findSiblingTasks: vi.fn().mockResolvedValue([]),
  findSiblingTasksByGroupId: vi.fn().mockResolvedValue([]),
  describeClaimFailure: vi.fn(),
  resetOrphanedTasks: vi.fn().mockResolvedValue(0),
}));

vi.mock("./agent/prompt-builder.js", () => ({
  buildDevPrompt: vi.fn().mockReturnValue("prompt"),
  buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
}));

vi.mock("./agent/local-git-check.js", () => ({
  hasLocalGitChanges: vi.fn().mockResolvedValue(false),
}));

vi.mock("./agent/repo-url-parser.js", () => ({
  buildPersistentBranchName: vi.fn(),
  buildTaskBranchName: vi.fn(),
  sanitizeBranchName: vi.fn(),
}));

vi.mock("./agent/agent-config-writer.js", () => ({
  materializeAgentConfigIfMissing: vi.fn().mockResolvedValue(undefined),
  encodeAgentConfigBase64: vi.fn().mockReturnValue(""),
}));

vi.mock("./agent/local-git-delivery.js", () => ({
  buildDeliveryResultPath: vi.fn(),
  buildLocalGitDeliveryServer: vi.fn(),
  buildLocalPrReviewServer: vi.fn(),
}));

vi.mock("./mcp-proxy-config.js", () => ({
  buildProxyServersConfig: vi.fn().mockReturnValue([]),
}));

vi.mock("./aca-worker-spawner.js", () => ({
  loadAcaConfig: vi.fn().mockReturnValue(null),
  startWorkerJob: vi.fn(),
  stopWorkerJob: vi.fn(),
  getWorkerJobStatus: vi.fn(),
  isAcaModeEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("./worker-ws-handler.js", () => ({
  setWorkerEventHandler: vi.fn(),
  sendWorkerPrompt: vi.fn(),
  sendWorkerStop: vi.fn(),
  isWorkerConnected: vi.fn().mockReturnValue(false),
}));

vi.mock("./logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logSessionEvent: vi.fn(),
  logWorkerEvent: vi.fn(),
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import type { Session } from "./types.js";

function makeDbSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    name: "Pooled Session",
    agent: "developer-agent",
    status: "running",
    prompt: "",
    interactive: false,
    loop: true,
    runs: 1,
    intervalSeconds: 10,
    cwd: "/workspace",
    timeoutSeconds: 0,
    userId: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    output: [],
    pinned: false,
    isPermanent: false,
    sortOrder: 0,
    ...overrides,
  };
}

describe("session-manager initSessions — autoscaler pool exemption", () => {
  let initSessions: typeof import("./session-manager.js")["initSessions"];
  let getAllSessions: typeof import("./session-manager.js")["getAllSessions"];
  let getSession: typeof import("./session-manager.js")["getSession"];
  let getAllSessionsFromDb: typeof import("./db/sessions.js")["getAllSessionsFromDb"];
  let getAllPooledSessionIds: typeof import("./db/autoscalers.js")["getAllPooledSessionIds"];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();

    const sm = await import("./session-manager.js");
    initSessions = sm.initSessions;
    getAllSessions = sm.getAllSessions;
    getSession = sm.getSession;

    const dbSessions = await import("./db/sessions.js");
    getAllSessionsFromDb = dbSessions.getAllSessionsFromDb;

    const dbAutoScalers = await import("./db/autoscalers.js");
    getAllPooledSessionIds = dbAutoScalers.getAllPooledSessionIds;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not auto-restart a session that was running and is owned by an AutoScaler", async () => {
    const pooledSession = makeDbSession({ id: 42, status: "running" });
    vi.mocked(getAllSessionsFromDb).mockResolvedValue([pooledSession]);
    vi.mocked(getAllPooledSessionIds).mockResolvedValue([42]);

    await initSessions();
    // Auto-restart runs inside a 2s setTimeout.
    await vi.advanceTimersByTimeAsync(2500);

    // startSession() sets status to "running" synchronously before doing any
    // async runner/container work — if the auto-restart path had fired for
    // this pooled session, status would now read "running" again.
    expect(getSession(42)?.status).toBe("stopped");
  });

  it("loads the pooled session as stopped and hides it from getAllSessions", async () => {
    const pooledSession = makeDbSession({ id: 42, status: "running" });
    vi.mocked(getAllSessionsFromDb).mockResolvedValue([pooledSession]);
    vi.mocked(getAllPooledSessionIds).mockResolvedValue([42]);

    await initSessions();

    // Hidden from the user-facing list.
    expect(getAllSessions(1).find((s) => s.id === 42)).toBeUndefined();

    // But still present/inspectable internally (error handling, autoscaler
    // reconcile logic) via getSession(), loaded with status "stopped".
    const internal = getSession(42);
    expect(internal).toBeDefined();
    expect(internal!.status).toBe("stopped");
  });

  it("still auto-restarts a non-pooled session that was running", async () => {
    const regularSession = makeDbSession({ id: 7, status: "running" });
    vi.mocked(getAllSessionsFromDb).mockResolvedValue([regularSession]);
    vi.mocked(getAllPooledSessionIds).mockResolvedValue([]); // not pooled

    await initSessions();
    await vi.advanceTimersByTimeAsync(2500);

    // The auto-restart path called startSession(7), which sets status to
    // "running" synchronously before continuing with async runner/container
    // work (which then fails in this test's minimal mock environment and
    // settles on "error" — irrelevant here). Either way it's no longer the
    // "stopped" status initSessions() set it to, proving the restart fired —
    // unlike the pooled-session case above, which stays "stopped".
    expect(getSession(7)?.status).not.toBe("stopped");
  });

  it("still records an error for a pooled session that fails during startup (error handling unaffected by list hiding)", async () => {
    const pooledSession = makeDbSession({ id: 42, status: "running" });
    vi.mocked(getAllSessionsFromDb).mockResolvedValue([pooledSession]);
    vi.mocked(getAllPooledSessionIds).mockResolvedValue([42]);

    await initSessions();

    // Manually invoke startSession on the pooled session (mirroring what
    // autoscaler-manager's startAutoScaler -> reconcile would eventually do)
    // to exercise the real launcher failure -> recordSessionError path. The
    // minimal mock environment here has no working KiroRunner, so the
    // launcher (runSessionAca/runSession) is expected to reject quickly.
    const sm = await import("./session-manager.js");
    await sm.startSession(42);
    // Flush the launcher's rejection handler (a .catch() on the async launch).
    await vi.advanceTimersByTimeAsync(50);

    const { recordError } = await import("./error-store.js");
    expect(recordError).toHaveBeenCalled();
    const call = vi.mocked(recordError).mock.calls.find((c) => c[0].sessionId === 42);
    expect(call).toBeDefined();

    // The session is still hidden from the user-facing list even after
    // erroring — only status/error visibility (via getSession) changes were
    // in scope for this task, not error-store visibility.
    expect(getAllSessions(1).find((s) => s.id === 42)).toBeUndefined();
  });
});
