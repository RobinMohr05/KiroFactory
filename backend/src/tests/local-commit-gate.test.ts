/**
 * Tests for local-mode commit gate in runLoopMode().
 *
 * Verifies that when an editor-kind agent (e.g. developer-agent) completes
 * a turn in local loop mode with no git changes AND no verdict, the task is
 * treated as a failure (reset to claimState) rather than unconditionally
 * resolved. This matches the safety behaviour in runLoopModeAca().
 *
 * Bug: task #598 — discovered 2026-08-21: local pipeline marked tasks "done"
 * with zero code changes because runLoopMode() had no equivalent of the
 * hasChanges/committed cross-check that runLoopModeAca() performs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock all external dependencies (same pattern as session-turn-tracking.test.ts) ───

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
  getAgentByName: vi.fn().mockResolvedValue({
    name: "developer-agent",
    kind: "editor",
    claimState: "todo",
    workingState: "in-progress",
    resolveState: "developed",
    requiresTask: true,
  }),
}));

vi.mock("../db/turns.js", () => ({
  createTurn: vi.fn().mockResolvedValue({ number: 1, sessionId: 1, startedAt: "2026-08-21T10:00:00.000Z" }),
  completeTurn: vi.fn().mockResolvedValue(null),
  createErrorEvent: vi.fn().mockResolvedValue(null),
  getMaxTurnNumber: vi.fn().mockResolvedValue(0),
}));

vi.mock("../db/tasks.js", () => ({
  getTaskAutoMergePrs: vi.fn().mockResolvedValue(false),
  areAllGroupTasksDone: vi.fn().mockResolvedValue(false),
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

const mockClaimTask = vi.fn();
const mockResolveTask = vi.fn();
const mockResetTask = vi.fn();

vi.mock("../agent/task-claimer.js", () => ({
  claimTask: (...args: unknown[]) => mockClaimTask(...args),
  resolveTask: (...args: unknown[]) => mockResolveTask(...args),
  resetTask: (...args: unknown[]) => mockResetTask(...args),
  getAvailableTaskCount: vi.fn().mockResolvedValue(1),
  waitForTaskAvailable: vi.fn(),
  markTaskDone: vi.fn(),
  findSiblingTasks: vi.fn().mockResolvedValue([]),
  findSiblingTasksByGroupId: vi.fn().mockResolvedValue([]),
}));

vi.mock("../agent/prompt-builder.js", () => ({
  buildDevPrompt: vi.fn().mockReturnValue("implement this task"),
  buildReviewPrompt: vi.fn().mockReturnValue("review this PR"),
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

// Mock the local git check utility that gates editor-kind agent success
const mockHasLocalGitChanges = vi.fn();
vi.mock("../agent/local-git-check.js", () => ({
  hasLocalGitChanges: (...args: unknown[]) => mockHasLocalGitChanges(...args),
}));

// Import after all mocks are registered
import { createSession, startSession } from "../session-manager.js";
import type { CreateSessionInput } from "../types.js";

describe("local-mode commit gate (runLoopMode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: claimTask returns one task, then null (to end the loop after one iteration)
    mockClaimTask
      .mockResolvedValueOnce({
        id: 42,
        title: "Add login form",
        type: "feature",
        priority: 2,
        description: "Add a login form to the home page",
      })
      .mockResolvedValue(null);

    mockResolveTask.mockResolvedValue(undefined);
    mockResetTask.mockResolvedValue(undefined);
  });

  it("should reset task (not resolve) when editor-kind agent produces no git changes and no verdict", async () => {
    // Simulate: git status --porcelain returns empty → no changes
    mockHasLocalGitChanges.mockReturnValue(false);

    const input: CreateSessionInput = {
      name: "Dev Loop",
      agent: "developer-agent",
      prompt: "",
      interactive: false,
      loop: true,
      runs: 1, // Run once then stop
      intervalSeconds: 0,
      userId: 1,
    };
    const session = await createSession(input);

    // Mock the KiroRunner instance that will be used
    const { KiroRunner } = await import("../agent/kiro-runner.js");
    const mockRunner = {
      isAlive: true,
      pid: 12345,
      lastTurnCredits: 0,
      mcpServerInitFailures: [],
      newSession: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async function* () {
        // Simulate a turn that produces output but no verdict and no changes
        yield { type: "text", text: "I looked at the code but couldn't figure out what to change." };
      }),
      stop: vi.fn(),
    };
    (KiroRunner.create as any).mockResolvedValue(mockRunner);

    // Start the session — this will enter runLoopMode
    await startSession(session.id);

    // Wait for the async loop to complete (runs: 1 and intervalSeconds: 0)
    await new Promise((r) => setTimeout(r, 200));

    // The key assertion: task should be RESET (failure) not RESOLVED (success)
    // because the editor-kind agent produced no git changes and no verdict
    expect(mockResetTask).toHaveBeenCalledWith(42, "todo");
    expect(mockResolveTask).not.toHaveBeenCalled();
  });

  it("should resolve task when editor-kind agent produces git changes (even without explicit verdict)", async () => {
    // Simulate: git status --porcelain returns content → changes exist
    mockHasLocalGitChanges.mockReturnValue(true);

    const input: CreateSessionInput = {
      name: "Dev Loop",
      agent: "developer-agent",
      prompt: "",
      interactive: false,
      loop: true,
      runs: 1,
      intervalSeconds: 0,
      userId: 1,
    };
    const session = await createSession(input);

    const { KiroRunner } = await import("../agent/kiro-runner.js");
    const mockRunner = {
      isAlive: true,
      pid: 12345,
      lastTurnCredits: 0,
      mcpServerInitFailures: [],
      newSession: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "I implemented the login form." };
      }),
      stop: vi.fn(),
    };
    (KiroRunner.create as any).mockResolvedValue(mockRunner);

    await startSession(session.id);
    await new Promise((r) => setTimeout(r, 200));

    // With changes present, the task should be resolved normally
    expect(mockResolveTask).toHaveBeenCalledWith(42, "developed");
    expect(mockResetTask).not.toHaveBeenCalled();
  });

  it("should skip git check for inspector-kind agents (they never produce file changes)", async () => {
    // Override getAgentByName to return an inspector agent
    const { getAgentByName } = await import("../db/agents.js");
    (getAgentByName as any).mockResolvedValue({
      name: "code-reviewer-agent",
      kind: "inspector",
      claimState: "developed",
      workingState: "in-code-review",
      resolveState: "reviewed",
      requiresTask: true,
    });

    // Inspector reports no_action_needed verdict (normal for "no issues found")
    // Git check should NOT be called for inspectors
    mockHasLocalGitChanges.mockReturnValue(false);

    const input: CreateSessionInput = {
      name: "Review Loop",
      agent: "code-reviewer-agent",
      prompt: "",
      interactive: false,
      loop: true,
      runs: 1,
      intervalSeconds: 0,
      userId: 1,
    };
    const session = await createSession(input);

    const { KiroRunner } = await import("../agent/kiro-runner.js");
    const mockRunner = {
      isAlive: true,
      pid: 12345,
      lastTurnCredits: 0,
      mcpServerInitFailures: [],
      newSession: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "Code looks good, no issues." };
        // Inspector sets verdict via the managed.turnVerdict mechanism
      }),
      stop: vi.fn(),
    };
    (KiroRunner.create as any).mockResolvedValue(mockRunner);

    await startSession(session.id);
    await new Promise((r) => setTimeout(r, 200));

    // Inspector without a verdict in the else branch: for inspectors the git
    // check should NOT apply (they are exempt — they don't produce file changes)
    // The hasLocalGitChanges function should not be called for inspectors
    expect(mockHasLocalGitChanges).not.toHaveBeenCalled();
  });
});
