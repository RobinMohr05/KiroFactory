/**
 * Tests for PATCH /api/sessions/:id — editable session fields.
 *
 * We test the session-manager's `updateSessionFields` function directly
 * (unit tests) since the route is a thin wrapper. We also verify:
 * - The whitelist of editable fields works correctly
 * - `agent` is rejected/ignored
 * - Running sessions return 409
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// We'll test the route handler logic indirectly by importing from session-manager.
// The actual in-memory session store and broadcastToUser are internal,
// so we mock the DB and broadcast layer and test updateSessionFields directly.

// Mock the DB layer
vi.mock("../db/sessions.js", () => ({
  getAllSessionsFromDb: vi.fn().mockResolvedValue([]),
  getRunningSessionsFromDb: vi.fn().mockResolvedValue([]),
  insertSession: vi.fn().mockResolvedValue(1),
  updateSessionStatus: vi.fn().mockResolvedValue(undefined),
  updateSessionMeta: vi.fn().mockResolvedValue(undefined),
  deleteSessionFromDb: vi.fn().mockResolvedValue(true),
  isSessionOwnedByUser: vi.fn().mockResolvedValue(true),
}));

vi.mock("../db/connection.js", () => ({
  isDbAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock("../db/users.js", () => ({
  getUserKiroApiKey: vi.fn().mockResolvedValue("fake-key"),
  getUserById: vi.fn().mockResolvedValue({ id: 1, email: "test@test.com", defaultGitProvider: null }),
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
  getAgentByName: vi.fn().mockResolvedValue(null),
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
  claimTask: vi.fn(),
  resolveTask: vi.fn(),
  resetTask: vi.fn(),
  getAvailableTaskCount: vi.fn().mockResolvedValue(0),
  markTaskDone: vi.fn(),
}));

vi.mock("../agent/prompt-builder.js", () => ({
  buildDevPrompt: vi.fn().mockReturnValue("prompt"),
  buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
}));

vi.mock("../agent/agent-config-writer.js", () => ({
  materializeAgentConfigIfMissing: vi.fn().mockResolvedValue(undefined),
  encodeAgentConfigBase64: vi.fn().mockReturnValue(""),
}));

vi.mock("../mcp-proxy-config.js", () => ({
  buildProxyServersConfig: vi.fn().mockReturnValue([]),
}));

vi.mock("../aca-worker-spawner.js", () => ({
  loadAcaConfig: vi.fn().mockReturnValue(null),
  startWorkerJob: vi.fn(),
  stopWorkerJob: vi.fn(),
  getWorkerJobStatus: vi.fn(),
  isAcaModeEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("../worker-ws-handler.js", () => ({
  setWorkerEventHandler: vi.fn(),
  sendWorkerPrompt: vi.fn(),
  sendWorkerStop: vi.fn(),
  isWorkerConnected: vi.fn().mockReturnValue(false),
}));

// Now import the module under test — must be after mocks
import {
  createSession,
  getSession,
  updateSessionTabs,
  updateSessionFields,
} from "../session-manager.js";
import { broadcastToUser } from "../websocket-handler.js";
import type { CreateSessionInput, UpdateSessionInput } from "../types.js";

describe("updateSessionFields", () => {
  let sessionId: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Create a test session
    const input: CreateSessionInput = {
      name: "Test Session",
      agent: "dev-agent",
      prompt: "Original prompt",
      cwd: "/workspace",
      timeoutSeconds: 300,
      model: "claude-sonnet-4",
      interactive: true,
      loop: true,
      runs: 5,
      intervalSeconds: 10,
      userId: 1,
    };
    const session = await createSession(input);
    sessionId = session.id;
  });

  it("should update allowed fields (name, prompt, cwd, model, etc.)", () => {
    const updates: UpdateSessionInput = {
      name: "Updated Session",
      prompt: "New prompt",
      cwd: "/new/path",
      model: "claude-haiku",
      timeoutSeconds: 600,
      interactive: false,
      loop: false,
      runs: 10,
      intervalSeconds: 30,
    };

    const result = updateSessionFields(sessionId, updates);
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.name).toBe("Updated Session");
    expect(session!.prompt).toBe("New prompt");
    expect(session!.cwd).toBe("/new/path");
    expect(session!.model).toBe("claude-haiku");
    expect(session!.timeoutSeconds).toBe(600);
    expect(session!.interactive).toBe(false);
    expect(session!.loop).toBe(false);
    expect(session!.runs).toBe(10);
    expect(session!.intervalSeconds).toBe(30);
  });

  it("should update tabIds", () => {
    const result = updateSessionFields(sessionId, { tabIds: [1, 2, 3] });
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.tabIds).toEqual([1, 2, 3]);
  });

  it("should update mcpServers", () => {
    const mcpServers = [{ name: "test", command: "node", args: ["test.js"], env: [] }];
    const result = updateSessionFields(sessionId, { mcpServers });
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.mcpServers).toEqual(mcpServers);
  });

  it("should NOT allow updating the 'agent' field", () => {
    const result = updateSessionFields(sessionId, { agent: "new-agent" } as any);
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.agent).toBe("dev-agent"); // unchanged
  });

  it("should return error when session is running", async () => {
    // Manually set status to running (bypass startSession which needs real runner)
    const session = getSession(sessionId);
    (session as any).status = "running";

    const result = updateSessionFields(sessionId, { name: "New Name" });
    expect(result).toEqual({ success: false, reason: "running" });

    // Name should NOT have changed
    const updatedSession = getSession(sessionId);
    expect(updatedSession!.name).toBe("Test Session");
  });

  it("should return null for non-existent session", () => {
    const result = updateSessionFields(99999, { name: "Foo" });
    expect(result).toBeNull();
  });

  it("should broadcast session-updated event", () => {
    updateSessionFields(sessionId, { name: "Broadcast Test" });

    expect(broadcastToUser).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: "session-updated",
        session: expect.objectContaining({ name: "Broadcast Test" }),
      })
    );
  });

  it("should only update fields that are provided (partial updates)", () => {
    const result = updateSessionFields(sessionId, { name: "Only Name Changed" });
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.name).toBe("Only Name Changed");
    expect(session!.prompt).toBe("Original prompt"); // unchanged
    expect(session!.cwd).toBe("/workspace"); // unchanged
  });

  it("should reset 'cwd' to default when null is provided", () => {
    // Set to a custom path first
    updateSessionFields(sessionId, { cwd: "/custom/path" });
    const before = getSession(sessionId);
    expect(before!.cwd).toBe("/custom/path");

    // Clearing with null resets to the project root default
    const result = updateSessionFields(sessionId, { cwd: null });
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    // cwd is required — clears to project root default, not undefined
    expect(session!.cwd).toBeDefined();
    expect(typeof session!.cwd).toBe("string");
    expect(session!.cwd.length).toBeGreaterThan(0);
    expect(session!.cwd).not.toBe("/custom/path"); // no longer the custom value
  });

  it("should clear 'model' when null is provided", () => {
    // Verify the field is set initially
    const before = getSession(sessionId);
    expect(before!.model).toBe("claude-sonnet-4");

    const result = updateSessionFields(sessionId, { model: null });
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.model).toBeUndefined();
  });

  it("should clear 'mcpServers' when null is provided", () => {
    // First set mcpServers
    updateSessionFields(sessionId, {
      mcpServers: [{ name: "test", command: "node", args: ["test.js"], env: [] }],
    });
    const before = getSession(sessionId);
    expect(before!.mcpServers).toHaveLength(1);

    // Now clear it
    const result = updateSessionFields(sessionId, { mcpServers: null });
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.mcpServers).toBeUndefined();
  });

  it("should clear 'mcpServers' when empty array is provided", () => {
    // First set mcpServers
    updateSessionFields(sessionId, {
      mcpServers: [{ name: "test", command: "node", args: ["test.js"], env: [] }],
    });
    const before = getSession(sessionId);
    expect(before!.mcpServers).toHaveLength(1);

    // Now clear with empty array
    const result = updateSessionFields(sessionId, { mcpServers: [] });
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.mcpServers).toBeUndefined();
  });

  it("should not crash when tabIds is null", () => {
    // First set tabIds to something
    updateSessionFields(sessionId, { tabIds: [1, 2] });
    const before = getSession(sessionId);
    expect(before!.tabIds).toEqual([1, 2]);

    // Sending null should clear tabIds without throwing TypeError
    const result = updateSessionFields(sessionId, { tabIds: null } as any);
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.tabIds).toBeUndefined();
  });

  it("should clear tabIds when empty array is provided", () => {
    // First set tabIds
    updateSessionFields(sessionId, { tabIds: [1, 2, 3] });
    const before = getSession(sessionId);
    expect(before!.tabIds).toEqual([1, 2, 3]);

    // Now clear with empty array
    const result = updateSessionFields(sessionId, { tabIds: [] });
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    expect(session!.tabIds).toBeUndefined();
  });

  it("should reject empty string name", () => {
    const result = updateSessionFields(sessionId, { name: "" });
    expect(result).toEqual({ success: false, reason: "name cannot be empty" });

    // Name should NOT have changed
    const session = getSession(sessionId);
    expect(session!.name).toBe("Test Session");
  });

  it("should reject whitespace-only name", () => {
    const result = updateSessionFields(sessionId, { name: "   " });
    expect(result).toEqual({ success: false, reason: "name cannot be empty" });

    // Name should NOT have changed
    const session = getSession(sessionId);
    expect(session!.name).toBe("Test Session");
  });

  it("should reject null name without crashing (TypeError)", () => {
    const result = updateSessionFields(sessionId, { name: null } as any);
    expect(result).toEqual({ success: false, reason: "name cannot be empty" });

    // Name should NOT have changed
    const session = getSession(sessionId);
    expect(session!.name).toBe("Test Session");
  });

  it("should treat null prompt as empty string (not corrupt session state)", () => {
    const result = updateSessionFields(sessionId, { prompt: null } as any);
    expect(result).toEqual({ success: true });

    const session = getSession(sessionId);
    // Should be an empty string, NOT null (null would crash on .trim() later)
    expect(session!.prompt).toBe("");
  });
});

describe("createSession — internal-only fields", () => {
  it("does not apply forceLocal when set via createSession with explicit undefined", async () => {
    const session = await createSession({
      name: "Public Session",
      interactive: true,
      loop: false,
      runs: 0,
      intervalSeconds: 10,
      userId: 1,
      forceLocal: undefined,
    });

    const loaded = getSession(session.id);
    expect(loaded!.forceLocal).toBeFalsy();
  });

  it("applies forceLocal when set via createSession (internal path)", async () => {
    const session = await createSession({
      name: "Planner Session",
      interactive: true,
      loop: false,
      runs: 0,
      intervalSeconds: 10,
      userId: 1,
      forceLocal: true,
    });

    const loaded = getSession(session.id);
    expect(loaded!.forceLocal).toBe(true);
  });

  it("applies rawMcpServers when set via createSession (internal path)", async () => {
    const mcpEntry = { type: "http", name: "github", url: "https://api.githubcopilot.com/mcp/", headers: [] };
    const session = await createSession({
      name: "Planner Session",
      interactive: true,
      loop: false,
      runs: 0,
      intervalSeconds: 10,
      userId: 1,
      rawMcpServers: [mcpEntry],
    });

    const loaded = getSession(session.id);
    expect(loaded!.rawMcpServers).toEqual([mcpEntry]);
  });
});
