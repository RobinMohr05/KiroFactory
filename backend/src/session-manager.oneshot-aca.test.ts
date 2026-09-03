/**
 * Tests for the ACA/remote one-shot result classifier.
 *
 * Regression test for the PR-104 review finding: the ACA one-shot path used to
 * treat *only* `mcpServerInitFailures` as a failure and silently swallowed the
 * other failure signals that `runLoopModeAca` checks on the same
 * `WorkerPromptResult` — `error` (ACP error / timeout / git failure) and
 * `stopReason === "cancelled"`. In ACA mode (the production deployment mode) a
 * failed scheduled turn therefore resolved as a *success*, so
 * `runScheduledSessionOnce` never retried and never recorded a per-attempt
 * AgentError.
 *
 * `classifyOneShotAcaResult` is the extracted, pure decision the ACA one-shot
 * block uses: it maps a WorkerPromptResult to "resolve" (turn succeeded) or
 * "reject" (turn failed, so the scheduler should retry + record an error).
 *
 * These mocks mirror routes/sessions.test.ts so importing session-manager is
 * cheap and side-effect-free.
 */

import { describe, it, expect, vi } from "vitest";

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

import { classifyOneShotAcaResult } from "./session-manager.js";

describe("classifyOneShotAcaResult", () => {
  it("resolves for a clean successful turn", () => {
    expect(classifyOneShotAcaResult({ error: null, stopReason: "end_turn" })).toEqual({
      outcome: "resolve",
    });
  });

  it("resolves when the result is undefined (no prompt configured)", () => {
    expect(classifyOneShotAcaResult(undefined)).toEqual({ outcome: "resolve" });
  });

  it("rejects when a required MCP server failed to initialize", () => {
    const result = classifyOneShotAcaResult({
      mcpServerInitFailures: [{ name: "verdict" }, { name: null }],
    });
    expect(result.outcome).toBe("reject");
    if (result.outcome === "reject") {
      expect(result.reason).toMatch(/MCP server/i);
      expect(result.reason).toContain("verdict");
    }
  });

  it("rejects when the agent turn reported an error (ACP/timeout/git failure)", () => {
    const result = classifyOneShotAcaResult({ error: "boom: git push failed" });
    expect(result.outcome).toBe("reject");
    if (result.outcome === "reject") {
      expect(result.reason).toContain("boom: git push failed");
    }
  });

  it("rejects when the turn was cancelled (timeout) before completing", () => {
    const result = classifyOneShotAcaResult({ stopReason: "cancelled" });
    expect(result.outcome).toBe("reject");
    if (result.outcome === "reject") {
      expect(result.reason).toMatch(/cancelled/i);
    }
  });

  it("prioritizes the MCP-init failure over a plain error", () => {
    const result = classifyOneShotAcaResult({
      error: "some error",
      mcpServerInitFailures: [{ name: "pr-review" }],
    });
    expect(result.outcome).toBe("reject");
    if (result.outcome === "reject") {
      expect(result.reason).toMatch(/MCP server/i);
    }
  });
});
