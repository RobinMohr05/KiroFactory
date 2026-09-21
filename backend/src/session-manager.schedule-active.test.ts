/**
 * Unit tests for `setScheduleActive` in session-manager.
 *
 * Regression test for the PR-138 review finding: `setScheduleActive` used to
 * mutate the in-memory `scheduleActive` flag and broadcast a `session-updated`
 * WS event BEFORE awaiting the DB write. If the DB write threw, the in-memory
 * flag and all connected clients were left showing the new value while the DB
 * still held the old one — a divergence only a server restart would correct.
 *
 * The fix persists to the DB first and only mutates in-memory state + broadcasts
 * on success. These tests pin that ordering: on a failed DB write the in-memory
 * flag must be unchanged and no broadcast must be sent.
 *
 * Mocks mirror session-manager.oneshot-aca.test.ts so importing session-manager
 * is cheap and side-effect-free. `isDbAvailable` returns false so createSession
 * allocates a local-only id instead of calling insertSession.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateSessionScheduleActiveInDb, broadcastToUser } = vi.hoisted(() => ({
  updateSessionScheduleActiveInDb: vi.fn().mockResolvedValue(undefined),
  broadcastToUser: vi.fn(),
}));

vi.mock("./db/sessions.js", () => ({
  getAllSessionsFromDb: vi.fn().mockResolvedValue([]),
  getRunningSessionsFromDb: vi.fn().mockResolvedValue([]),
  insertSession: vi.fn().mockResolvedValue(1),
  updateSessionStatus: vi.fn().mockResolvedValue(undefined),
  updateSessionMeta: vi.fn().mockResolvedValue(undefined),
  updateSessionScheduleActiveInDb,
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
vi.mock("./websocket-handler.js", () => ({ broadcastToUser }));
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

import { createSession, getSession, setScheduleActive } from "./session-manager.js";

async function makeScheduledSession(scheduleActive: boolean) {
  return createSession({
    name: "sched",
    agent: "dev",
    userId: 42,
    cronExpression: "0 0 * * *",
    scheduleActive,
  });
}

describe("setScheduleActive", () => {
  beforeEach(() => {
    updateSessionScheduleActiveInDb.mockReset().mockResolvedValue(undefined);
    broadcastToUser.mockReset();
  });

  it("persists to the DB, then mutates in-memory state and broadcasts on success", async () => {
    const meta = await makeScheduledSession(false);
    broadcastToUser.mockReset(); // ignore the session-created broadcast

    const ok = await setScheduleActive(meta.id, true);

    expect(ok).toBe(true);
    expect(updateSessionScheduleActiveInDb).toHaveBeenCalledWith(meta.id, true);
    expect(getSession(meta.id)?.scheduleActive).toBe(true);
    expect(broadcastToUser).toHaveBeenCalledTimes(1);
    expect(broadcastToUser).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: "session-updated" }),
    );
  });

  it("does NOT mutate in-memory state or broadcast when the DB write fails", async () => {
    const meta = await makeScheduledSession(false);
    broadcastToUser.mockReset(); // ignore the session-created broadcast
    updateSessionScheduleActiveInDb.mockRejectedValueOnce(new Error("db down"));

    await expect(setScheduleActive(meta.id, true)).rejects.toThrow("db down");

    // in-memory flag must remain at its prior value; no divergence
    expect(getSession(meta.id)?.scheduleActive).toBe(false);
    // no WS broadcast telling clients the flag changed
    expect(broadcastToUser).not.toHaveBeenCalled();
  });

  it("returns false for an unknown session without touching the DB", async () => {
    const ok = await setScheduleActive(999999, true);
    expect(ok).toBe(false);
    expect(updateSessionScheduleActiveInDb).not.toHaveBeenCalled();
  });
});
