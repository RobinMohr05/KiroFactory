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

import { describe, it, expect, vi } from "vitest";

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

import { runScheduledSessionOnce } from "./scheduled-session-manager.js";
import type { ScheduledRunDeps } from "./scheduled-session-manager.js";

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
