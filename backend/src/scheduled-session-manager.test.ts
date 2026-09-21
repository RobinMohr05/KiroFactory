/**
 * Tests for the scheduled-session one-shot runner logic:
 *  - skip-if-running (append system line, record NO error)
 *  - retries: one AgentError recorded per failed attempt (tagged attempt N/total),
 *    and retries stop early on success.
 *
 * We test `runScheduledSessionOnce` from scheduled-session-manager.ts with an
 * injected single-attempt runner and injected dependencies so no real
 * KiroRunner / worker / DB is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// scheduled-session-manager imports session-manager at module load, which
// pulls in the DB/worker/runner layers. Mock those so the import is cheap and
// side-effect-free (mirrors routes/sessions.test.ts).
vi.mock("./db/sessions.js", () => ({
  getAllSessionsFromDb: vi.fn().mockResolvedValue([]),
  getRunningSessionsFromDb: vi.fn().mockResolvedValue([]),
  insertSession: vi.fn().mockResolvedValue(1),
  updateSessionStatus: vi.fn().mockResolvedValue(undefined),
  updateSessionMeta: vi.fn().mockResolvedValue(undefined),
  deleteSessionFromDb: vi.fn().mockResolvedValue(true),
  isSessionOwnedByUser: vi.fn().mockResolvedValue(true),
}));
vi.mock("./db/connection.js", () => ({ isDbAvailable: vi.fn().mockReturnValue(false) }));
vi.mock("./db/users.js", () => ({
  getUserKiroApiKey: vi.fn().mockResolvedValue(null),
  getUserById: vi.fn().mockResolvedValue(null),
}));
vi.mock("./db/credentials.js", () => ({
  getAllDecryptedCredentials: vi.fn().mockResolvedValue({}),
  getDecryptedCredential: vi.fn().mockResolvedValue(null),
}));
vi.mock("./db/tabs.js", () => ({
  getAgentTabs: vi.fn().mockResolvedValue([]),
  getTabById: vi.fn().mockResolvedValue(null),
}));
vi.mock("./db/agents.js", () => ({ getAgentByName: vi.fn().mockResolvedValue(null) }));
vi.mock("./websocket-handler.js", () => ({ broadcastToUser: vi.fn() }));
vi.mock("./error-store.js", () => ({ recordError: vi.fn() }));
vi.mock("./agent/kiro-runner.js", () => ({ KiroRunner: { create: vi.fn() } }));
vi.mock("./agent/task-claimer.js", () => ({
  claimTask: vi.fn(),
  resolveTask: vi.fn(),
  resetTask: vi.fn(),
  getAvailableTaskCount: vi.fn().mockResolvedValue(0),
  markTaskDone: vi.fn(),
}));
vi.mock("./agent/prompt-builder.js", () => ({
  buildDevPrompt: vi.fn().mockReturnValue("prompt"),
  buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
}));
vi.mock("./agent/agent-config-writer.js", () => ({
  materializeAgentConfigIfMissing: vi.fn(),
  encodeAgentConfigBase64: vi.fn().mockReturnValue(""),
}));
vi.mock("./mcp-proxy-config.js", () => ({ buildProxyServersConfig: vi.fn().mockReturnValue([]) }));
vi.mock("./aca-worker-spawner.js", () => ({
  loadAcaConfig: vi.fn().mockReturnValue(null),
  startWorkerJob: vi.fn(),
  stopWorkerJob: vi.fn(),
  getWorkerJobStatus: vi.fn(),
  isAcaModeEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock("./wsl-worker-spawner.js", () => ({
  loadWslConfig: vi.fn().mockReturnValue(null),
  startWorkerJob: vi.fn(),
  stopWorkerJob: vi.fn(),
  getWorkerJobStatus: vi.fn(),
  captureContainerLogs: vi.fn(),
  isWslModeEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock("./worker-ws-handler.js", () => ({
  setWorkerEventHandler: vi.fn(),
  sendWorkerPrompt: vi.fn(),
  sendWorkerStop: vi.fn(),
  isWorkerConnected: vi.fn().mockReturnValue(false),
  connectToLocalWorker: vi.fn(),
}));

// Mock session-manager to control getScheduledSessions output in initScheduledSessions tests
vi.mock("./session-manager.js", () => ({
  getScheduledSessions: vi.fn().mockReturnValue([]),
  getSessionStatus: vi.fn().mockReturnValue("stopped"),
  runOneShotTurn: vi.fn().mockResolvedValue(undefined),
  appendScheduledSystemLine: vi.fn(),
  recordScheduledAttemptError: vi.fn(),
}));

import { runScheduledSessionOnce, initScheduledSessions, armSession, disarmSession, disarmAll } from "./scheduled-session-manager.js";
import type { ScheduledRunDeps } from "./scheduled-session-manager.js";
import { getScheduledSessions } from "./session-manager.js";

function makeDeps(overrides: Partial<ScheduledRunDeps> = {}): ScheduledRunDeps {
  return {
    getStatus: vi.fn().mockReturnValue("stopped"),
    runOneShotAttempt: vi.fn().mockResolvedValue(undefined),
    appendSystemLine: vi.fn(),
    recordAttemptError: vi.fn(),
    ...overrides,
  };
}

describe("runScheduledSessionOnce — skip if running", () => {
  it("skips the tick, logs a system line, and records no error when already running", async () => {
    const deps = makeDeps({ getStatus: vi.fn().mockReturnValue("running") });

    const result = await runScheduledSessionOnce(1, 0, deps);

    expect(result).toEqual({ skipped: true });
    expect(deps.runOneShotAttempt).not.toHaveBeenCalled();
    expect(deps.recordAttemptError).not.toHaveBeenCalled();
    expect(deps.appendSystemLine).toHaveBeenCalledWith(
      1,
      expect.stringContaining("skipped")
    );
  });
});

describe("runScheduledSessionOnce — retries", () => {
  it("runs exactly once on success with retries=0", async () => {
    const deps = makeDeps();
    const result = await runScheduledSessionOnce(1, 0, deps);

    expect(deps.runOneShotAttempt).toHaveBeenCalledTimes(1);
    expect(deps.recordAttemptError).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: false, attempts: 1, succeeded: true });
  });

  it("records one error per failed attempt and stops after retries exhausted", async () => {
    const runOneShotAttempt = vi.fn().mockRejectedValue(new Error("boom"));
    const deps = makeDeps({ runOneShotAttempt });

    const result = await runScheduledSessionOnce(1, 2, deps);

    // retries=2 → up to 3 attempts total, all fail
    expect(runOneShotAttempt).toHaveBeenCalledTimes(3);
    expect(deps.recordAttemptError).toHaveBeenCalledTimes(3);
    // Tagged with attempt number out of total
    expect(deps.recordAttemptError).toHaveBeenNthCalledWith(1, 1, 3, expect.any(Error));
    expect(deps.recordAttemptError).toHaveBeenNthCalledWith(2, 2, 3, expect.any(Error));
    expect(deps.recordAttemptError).toHaveBeenNthCalledWith(3, 3, 3, expect.any(Error));
    expect(result).toEqual({ skipped: false, attempts: 3, succeeded: false });
  });

  it("stops retrying early once an attempt succeeds, keeping earlier failures recorded", async () => {
    const runOneShotAttempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({ runOneShotAttempt });

    const result = await runScheduledSessionOnce(1, 3, deps);

    expect(runOneShotAttempt).toHaveBeenCalledTimes(2);
    // Only the first (failed) attempt recorded an error
    expect(deps.recordAttemptError).toHaveBeenCalledTimes(1);
    expect(deps.recordAttemptError).toHaveBeenNthCalledWith(1, 1, 4, expect.any(Error));
    expect(result).toEqual({ skipped: false, attempts: 2, succeeded: true });
  });
});

// ---------------------------------------------------------------------------
// initScheduledSessions — boot-time arming with scheduleActive condition
// ---------------------------------------------------------------------------

describe("initScheduledSessions — arms only sessions with cronExpression AND scheduleActive=true", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disarmAll();
  });

  const BASE_SESSION = {
    id: 1,
    name: "Sched",
    agent: "",
    status: "stopped" as const,
    prompt: "",
    interactive: false,
    loop: false,
    runs: 0,
    intervalSeconds: 10,
    cwd: "/workspace",
    timeoutSeconds: 0,
    userId: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    output: [],
    pinned: false,
    isPermanent: false,
    sortOrder: 0,
  };

  it("does NOT arm a session that has a cronExpression but scheduleActive=false", async () => {
    vi.mocked(getScheduledSessions).mockReturnValue([
      { ...BASE_SESSION, cronExpression: "0 9 * * *", cronTimezone: "UTC", scheduleActive: false },
    ] as any);

    // Arming a session ultimately schedules a timer via setTimeout. Spy on it
    // so we can assert the arming decision directly rather than merely that
    // getScheduledSessions was read — a bug that unconditionally armed every
    // cron session would otherwise slip through.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await initScheduledSessions();

    expect(getScheduledSessions).toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });

  it("does NOT arm a session that has a cronExpression but scheduleActive is undefined (defaults to false)", async () => {
    vi.mocked(getScheduledSessions).mockReturnValue([
      { ...BASE_SESSION, cronExpression: "0 9 * * *", cronTimezone: "UTC" }, // no scheduleActive
    ] as any);

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await initScheduledSessions();

    expect(getScheduledSessions).toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });

  it("arms a session that has cronExpression AND scheduleActive=true", async () => {
    vi.mocked(getScheduledSessions).mockReturnValue([
      { ...BASE_SESSION, id: 42, cronExpression: "0 9 * * *", cronTimezone: "UTC", retries: 1, scheduleActive: true },
    ] as any);

    // armSession → scheduleNext → setTimeout for the next cron fire. Spy on
    // setTimeout to confirm a timer was actually scheduled for this session.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await initScheduledSessions();

    expect(getScheduledSessions).toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
    // Clean up the timer that was actually armed so it can't fire later.
    disarmSession(42);
  });
});
