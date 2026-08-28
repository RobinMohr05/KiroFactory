/**
 * Tests for local-mode git-delivery MCP wiring in runLoopMode().
 *
 * Verifies that when an editor-kind agent runs locally with a resolved git
 * context (tab -> repositoryUrl -> provider -> PAT), the git-delivery MCP
 * server is injected per claimed task via KiroRunner.newSession()'s
 * override, and that the delivery result it writes (DELIVERY_RESULT_PATH)
 * is read back and used to (a) satisfy the local commit gate and (b)
 * persist branch/PR info onto the task via resolveTask.
 *
 * Companion to local-commit-gate.test.ts, which covers the git-changes-only
 * (no git-delivery configured) path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// ─── Mock all external dependencies (same pattern as local-commit-gate.test.ts) ───

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

const mockGetDecryptedCredential = vi.fn();
vi.mock("../db/credentials.js", () => ({
  getAllDecryptedCredentials: vi.fn().mockResolvedValue({}),
  getDecryptedCredential: (...args: unknown[]) => mockGetDecryptedCredential(...args),
}));

const mockGetTabById = vi.fn();
vi.mock("../db/tabs.js", () => ({
  getAgentTabs: vi.fn().mockResolvedValue([]),
  getTabById: (...args: unknown[]) => mockGetTabById(...args),
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
  createTurn: vi.fn().mockResolvedValue({ number: 1, sessionId: 1, startedAt: "2026-08-27T10:00:00.000Z" }),
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
  buildLocalMcpServerEntries: vi.fn().mockReturnValue([]),
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

// hasLocalGitChanges always false here — these tests exist specifically to
// prove the delivery-result read-back satisfies the commit gate WITHOUT
// relying on a raw git-status check.
vi.mock("../agent/local-git-check.js", () => ({
  hasLocalGitChanges: vi.fn().mockReturnValue(false),
}));

// Import after all mocks are registered
import { createSession, startSession } from "../session-manager.js";
import type { CreateSessionInput } from "../types.js";

function deliveryResultPathFor(sessionId: number): string {
  return resolve(tmpdir(), `kirofactory-delivery-result-${sessionId}.json`);
}

describe("local-mode git-delivery MCP wiring (runLoopMode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTask.mockResolvedValue(undefined);
    mockResetTask.mockResolvedValue(undefined);
    mockGetTabById.mockResolvedValue({
      id: 1,
      name: "Main",
      repositoryUrl: "https://github.com/acme/widgets",
      gitProvider: "github",
      mcpConfig: { atlassian: false, azureDevops: false, awsApi: false, awsDocs: false },
    });
    mockGetDecryptedCredential.mockResolvedValue("fake-pat-123");
  });

  afterEach(() => {
    // Best-effort cleanup of any delivery result file a test wrote/left behind.
    try {
      const path = deliveryResultPathFor(1);
      if (existsSync(path)) unlinkSync(path);
    } catch { /* ignore */ }
  });

  it("injects a git-delivery MCP server into newSession() when a tab repo is configured", async () => {
    mockClaimTask
      .mockResolvedValueOnce({
        id: 598,
        title: "Local-mode pipeline has no commit gate",
        type: "bug",
        priority: 1,
        description: "Fix it",
        pullRequestUrl: null,
      })
      .mockResolvedValue(null);

    const input: CreateSessionInput = {
      name: "Dev Loop",
      agent: "developer-agent",
      prompt: "",
      interactive: false,
      loop: true,
      runs: 1,
      intervalSeconds: 0,
      userId: 1,
      tabIds: [1],
      // forceLocal: this test exercises runLoopMode()'s (KiroRunner-based)
      // git-delivery MCP wiring directly. Without this, startSession() now
      // routes non-forceLocal sessions through runSessionAca() (container
      // worker, ACA or WSL/Docker) instead — see ARCHITECTURE.md §12.
      forceLocal: true,
    };
    const session = await createSession(input);

    const { KiroRunner } = await import("../agent/kiro-runner.js");
    const newSessionSpy = vi.fn().mockResolvedValue(undefined);
    const mockRunner = {
      isAlive: true,
      pid: 12345,
      lastTurnCredits: 0,
      mcpServerInitFailures: [],
      newSession: newSessionSpy,
      prompt: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "Implemented the fix." };
      }),
      stop: vi.fn(),
    };
    (KiroRunner.create as any).mockResolvedValue(mockRunner);

    await startSession(session.id);
    await new Promise((r) => setTimeout(r, 300));

    // newSession should have been called with an override server list
    // containing a "git-delivery" entry for this task.
    expect(newSessionSpy).toHaveBeenCalled();
    const [, overrideServers] = newSessionSpy.mock.calls[newSessionSpy.mock.calls.length - 1];
    expect(Array.isArray(overrideServers)).toBe(true);
    expect(overrideServers.some((s: any) => s.name === "git-delivery")).toBe(true);

    // The branch name env var should follow the deterministic [type]/#[id]_[slug] format
    const gitDelivery = overrideServers.find((s: any) => s.name === "git-delivery");
    const branchEnv = gitDelivery.env.find((e: any) => e.name === "TASK_BRANCH_NAME");
    expect(branchEnv.value).toBe("bug/#598_local-mode-pipeline-has-no-commit-gate");
  });

  it("also injects pr-review when the claimed task already has a PR URL (rework pass)", async () => {
    mockClaimTask
      .mockResolvedValueOnce({
        id: 42,
        title: "Some task",
        type: "feature",
        priority: 2,
        description: "desc",
        pullRequestUrl: "https://github.com/acme/widgets/pull/7",
      })
      .mockResolvedValue(null);

    const input: CreateSessionInput = {
      name: "Dev Loop",
      agent: "developer-agent",
      prompt: "",
      interactive: false,
      loop: true,
      runs: 1,
      intervalSeconds: 0,
      userId: 1,
      tabIds: [1],
      // forceLocal: this test exercises runLoopMode()'s (KiroRunner-based)
      // git-delivery MCP wiring directly. Without this, startSession() now
      // routes non-forceLocal sessions through runSessionAca() (container
      // worker, ACA or WSL/Docker) instead — see ARCHITECTURE.md §12.
      forceLocal: true,
    };
    const session = await createSession(input);

    const { KiroRunner } = await import("../agent/kiro-runner.js");
    const newSessionSpy = vi.fn().mockResolvedValue(undefined);
    const mockRunner = {
      isAlive: true,
      pid: 12345,
      lastTurnCredits: 0,
      mcpServerInitFailures: [],
      newSession: newSessionSpy,
      prompt: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "Addressed review comments." };
      }),
      stop: vi.fn(),
    };
    (KiroRunner.create as any).mockResolvedValue(mockRunner);

    await startSession(session.id);
    await new Promise((r) => setTimeout(r, 300));

    const [, overrideServers] = newSessionSpy.mock.calls[newSessionSpy.mock.calls.length - 1];
    expect(overrideServers.some((s: any) => s.name === "pr-review")).toBe(true);
  });

  it("reads back the delivery result and resolves the task with branch/PR info, satisfying the commit gate", async () => {
    mockClaimTask
      .mockResolvedValueOnce({
        id: 598,
        title: "Local-mode pipeline has no commit gate",
        type: "bug",
        priority: 1,
        description: "Fix it",
        pullRequestUrl: null,
      })
      .mockResolvedValue(null);

    const input: CreateSessionInput = {
      name: "Dev Loop",
      agent: "developer-agent",
      prompt: "",
      interactive: false,
      loop: true,
      runs: 1,
      intervalSeconds: 0,
      userId: 1,
      tabIds: [1],
      // forceLocal: this test exercises runLoopMode()'s (KiroRunner-based)
      // git-delivery MCP wiring directly. Without this, startSession() now
      // routes non-forceLocal sessions through runSessionAca() (container
      // worker, ACA or WSL/Docker) instead — see ARCHITECTURE.md §12.
      forceLocal: true,
    };
    const session = await createSession(input);

    const { KiroRunner } = await import("../agent/kiro-runner.js");
    const mockRunner = {
      isAlive: true,
      pid: 12345,
      lastTurnCredits: 0,
      mcpServerInitFailures: [],
      newSession: vi.fn().mockImplementation(async () => {
        // Simulate the agent calling submit_task_changes during the turn by
        // writing the delivery result file the git-delivery MCP server would
        // have written, keyed by this session's ID (session.id === 1 here).
        writeFileSync(
          deliveryResultPathFor(session.id),
          JSON.stringify({
            committed: true,
            pushed: true,
            branchName: "bug/#598_local-mode-pipeline-has-no-commit-gate",
            prUrl: "https://github.com/acme/widgets/pull/99",
            prCreated: true,
          })
        );
      }),
      prompt: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "Implemented and delivered the fix." };
      }),
      stop: vi.fn(),
    };
    (KiroRunner.create as any).mockResolvedValue(mockRunner);

    await startSession(session.id);
    await new Promise((r) => setTimeout(r, 300));

    // Despite hasLocalGitChanges() being mocked to false, the delivery result
    // (committed: true, pushed: true) should satisfy the commit gate and the
    // task should be RESOLVED with the branch/PR info from the delivery result.
    expect(mockResetTask).not.toHaveBeenCalled();
    expect(mockResolveTask).toHaveBeenCalledWith(
      598,
      "developed",
      "bug/#598_local-mode-pipeline-has-no-commit-gate",
      "https://github.com/acme/widgets/pull/99"
    );
  });

  it("still resets the task when no delivery result exists and there are no git changes (commit gate holds)", async () => {
    mockClaimTask
      .mockResolvedValueOnce({
        id: 598,
        title: "Local-mode pipeline has no commit gate",
        type: "bug",
        priority: 1,
        description: "Fix it",
        pullRequestUrl: null,
      })
      .mockResolvedValue(null);

    const input: CreateSessionInput = {
      name: "Dev Loop",
      agent: "developer-agent",
      prompt: "",
      interactive: false,
      loop: true,
      runs: 1,
      intervalSeconds: 0,
      userId: 1,
      tabIds: [1],
      // forceLocal: this test exercises runLoopMode()'s (KiroRunner-based)
      // git-delivery MCP wiring directly. Without this, startSession() now
      // routes non-forceLocal sessions through runSessionAca() (container
      // worker, ACA or WSL/Docker) instead — see ARCHITECTURE.md §12.
      forceLocal: true,
    };
    const session = await createSession(input);

    const { KiroRunner } = await import("../agent/kiro-runner.js");
    const mockRunner = {
      isAlive: true,
      pid: 12345,
      lastTurnCredits: 0,
      mcpServerInitFailures: [],
      // Never writes a delivery result file — agent didn't call submit_task_changes.
      newSession: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "I looked around but didn't change anything." };
      }),
      stop: vi.fn(),
    };
    (KiroRunner.create as any).mockResolvedValue(mockRunner);

    await startSession(session.id);
    await new Promise((r) => setTimeout(r, 300));

    expect(mockResetTask).toHaveBeenCalledWith(598, "todo");
    expect(mockResolveTask).not.toHaveBeenCalled();
  });
});
