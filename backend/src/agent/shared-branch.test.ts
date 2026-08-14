/**
 * Tests for shared branch/PR support for grouped tasks.
 *
 * Tests the logic for:
 * - Checking out an existing branch instead of creating a new one
 * - Finding sibling tasks that share the same branch
 * - Detecting existing PRs for a branch
 * - Updating PR body with multiple task references
 * - Building grouped PR body/title
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildGroupedPrBody,
  buildGroupedPrTitle,
  findExistingPrForBranch,
  updatePullRequestBody,
} from "./github-pr.js";
import { checkoutExistingBranch, pushBranch } from "./git-workspace.js";
import { getTasksByBranch, findSharedBranchInTab } from "./task-claimer.js";

// Mock child_process for git operations
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock the DB connection for task-claimer
vi.mock("../db/connection.js", () => ({
  getPool: vi.fn(),
  sql: {
    Int: "Int",
    VarChar: vi.fn((n: number) => `VarChar(${n})`),
    NVarChar: vi.fn((n: number) => `NVarChar(${n})`),
  },
}));

describe("buildGroupedPrBody", () => {
  it("should build a PR body referencing multiple tasks", () => {
    const tasks = [
      { id: 10, title: "First task", type: "feature", priority: 2 as const, description: "Do first" },
      { id: 11, title: "Second task", type: "feature", priority: 2 as const, description: "Do second" },
    ];

    const body = buildGroupedPrBody(tasks);

    expect(body).toContain("First task");
    expect(body).toContain("Second task");
    expect(body).toContain("#10");
    expect(body).toContain("#11");
    expect(body).toContain("Do first");
    expect(body).toContain("Do second");
  });

  it("should build a body for a single task (same as group of one)", () => {
    const tasks = [
      { id: 5, title: "Solo task", type: "bug", priority: 1 as const, description: "Fix it" },
    ];

    const body = buildGroupedPrBody(tasks);

    expect(body).toContain("Solo task");
    expect(body).toContain("#5");
    expect(body).toContain("Fix it");
  });

  it("should handle tasks with empty descriptions", () => {
    const tasks = [
      { id: 1, title: "Task A", type: "improvement", priority: 3 as const, description: "" },
      { id: 2, title: "Task B", type: "improvement", priority: 3 as const, description: "Has desc" },
    ];

    const body = buildGroupedPrBody(tasks);

    expect(body).toContain("Task A");
    expect(body).toContain("Task B");
    expect(body).toContain("Has desc");
  });
});

describe("buildGroupedPrTitle", () => {
  it("should build a title referencing multiple task IDs", () => {
    const tasks = [
      { id: 10, title: "First task" },
      { id: 11, title: "Second task" },
    ];

    const title = buildGroupedPrTitle(tasks);

    expect(title).toContain("#10");
    expect(title).toContain("#11");
  });

  it("should use single task title for a group of one", () => {
    const tasks = [
      { id: 5, title: "Solo task" },
    ];

    const title = buildGroupedPrTitle(tasks);

    expect(title).toContain("Solo task");
    expect(title).toContain("#5");
  });
});

describe("findExistingPrForBranch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return PR info when a PR exists for the branch", async () => {
    // Mock global fetch
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => [
        { html_url: "https://github.com/owner/repo/pull/42", number: 42, body: "existing body" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await findExistingPrForBranch({
      owner: "owner",
      repo: "repo",
      pat: "token123",
      head: "feature/#10_my-task",
    });

    expect(result).not.toBeNull();
    expect(result!.prUrl).toBe("https://github.com/owner/repo/pull/42");
    expect(result!.prNumber).toBe(42);
    expect(result!.body).toBe("existing body");
  });

  it("should return null when no PR exists for the branch", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await findExistingPrForBranch({
      owner: "owner",
      repo: "repo",
      pat: "token123",
      head: "feature/#99_nonexistent",
    });

    expect(result).toBeNull();
  });
});

describe("updatePullRequestBody", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should update the PR body and title via PATCH", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ html_url: "https://github.com/owner/repo/pull/42", number: 42 }),
    };
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchMock);

    const result = await updatePullRequestBody({
      owner: "owner",
      repo: "repo",
      pat: "token123",
      prNumber: 42,
      title: "Updated title",
      body: "Updated body",
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/42",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining("Updated body"),
      })
    );
  });

  it("should return failure when the API returns an error", async () => {
    const mockResponse = {
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await updatePullRequestBody({
      owner: "owner",
      repo: "repo",
      pat: "token123",
      prNumber: 999,
      title: "title",
      body: "body",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Not Found");
  });
});

describe("checkoutExistingBranch", () => {
  it("should be exported from git-workspace", () => {
    expect(typeof checkoutExistingBranch).toBe("function");
  });

  it("should verify remote branch exists via rev-parse before attempting checkout", async () => {
    const { execFile } = await import("node:child_process");
    const mockExecFile = vi.mocked(execFile);

    // Track all git commands called
    const calledCommands: string[][] = [];
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
      calledCommands.push(args as string[]);
      const callback = typeof _opts === "function" ? _opts : cb;
      if (callback) callback(null, "", "");
      return {} as any;
    });

    await checkoutExistingBranch("/workspace", "feature/shared-branch");

    // Should have: fetch, rev-parse --verify, checkout, reset --hard
    expect(calledCommands[0]).toEqual(["fetch", "origin"]);
    expect(calledCommands[1]).toEqual(["rev-parse", "--verify", "origin/feature/shared-branch"]);
  });

  it("should throw early if branch does not exist on remote (rev-parse fails)", async () => {
    const { execFile } = await import("node:child_process");
    const mockExecFile = vi.mocked(execFile);

    let callCount = 0;
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
      callCount++;
      const callback = typeof _opts === "function" ? _opts : cb;
      if (callCount === 1) {
        // fetch succeeds
        if (callback) callback(null, "", "");
      } else if (callCount === 2) {
        // rev-parse --verify fails (branch doesn't exist on remote)
        if (callback) callback(new Error("fatal: Needed a single revision"), "", "");
      }
      return {} as any;
    });

    await expect(checkoutExistingBranch("/workspace", "nonexistent-branch"))
      .rejects.toThrow("does not exist on remote");
  });

  it("should throw a descriptive error (used by dev-agent to detect checkout failure and fall through to create)", async () => {
    // The dev-agent catches this specific error to fall through to createFeatureBranch
    // instead of infinitely retrying a stale branch. This test documents the error message
    // contract that the dev-agent's catch block relies on.
    const { execFile } = await import("node:child_process");
    const mockExecFile = vi.mocked(execFile);

    let callCount = 0;
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
      callCount++;
      const callback = typeof _opts === "function" ? _opts : cb;
      if (callCount === 1) {
        if (callback) callback(null, "", "");
      } else if (callCount === 2) {
        if (callback) callback(new Error("fatal: Needed a single revision"), "", "");
      }
      return {} as any;
    });

    try {
      await checkoutExistingBranch("/workspace", "deleted-branch");
      expect.fail("Should have thrown");
    } catch (err: any) {
      // The error message must include the branch name and "does not exist on remote"
      // so the dev-agent's log output is meaningful
      expect(err.message).toContain("deleted-branch");
      expect(err.message).toContain("does not exist on remote");
    }
  });
});

describe("getTasksByBranch", () => {
  it("should be exported from task-claimer", () => {
    expect(typeof getTasksByBranch).toBe("function");
  });
});

describe("resolveBranchForTask", () => {
  it("should be exported from dev-agent-helpers", async () => {
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");
    expect(typeof resolveBranchForTask).toBe("function");
  });

  it("should return existing branch when task.branch is set", async () => {
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");

    const result = resolveBranchForTask({
      id: 10,
      title: "My task",
      type: "feature",
      branch: "feature/#5_shared-branch",
      pullRequestUrl: null,
    });

    expect(result.branchName).toBe("feature/#5_shared-branch");
    expect(result.isExisting).toBe(true);
  });

  it("should return null branchName when task has no branch", async () => {
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");

    const result = resolveBranchForTask({
      id: 10,
      title: "My task",
      type: "feature",
      branch: null,
      pullRequestUrl: null,
    });

    expect(result.branchName).toBeNull();
    expect(result.isExisting).toBe(false);
  });

  it("should return siblingBranch when task has no branch but siblingBranch is provided", async () => {
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");

    const result = resolveBranchForTask(
      {
        id: 10,
        title: "My task",
        type: "feature",
        branch: null,
        pullRequestUrl: null,
      },
      "feature/#5_shared-branch"
    );

    expect(result.branchName).toBe("feature/#5_shared-branch");
    expect(result.isExisting).toBe(true);
  });

  it("should prefer task.branch over siblingBranch", async () => {
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");

    const result = resolveBranchForTask(
      {
        id: 10,
        title: "My task",
        type: "feature",
        branch: "feature/#10_my-own-branch",
        pullRequestUrl: null,
      },
      "feature/#5_shared-branch"
    );

    expect(result.branchName).toBe("feature/#10_my-own-branch");
    expect(result.isExisting).toBe(true);
  });
});

describe("resolveBranchForTask — branch persistence ordering contract", () => {
  it("should return isExisting=false for new branches (caller must persist AFTER push, not before)", async () => {
    // Race condition protection: when a new branch is created (isExisting=false),
    // the caller MUST NOT persist the branch name to the DB until AFTER the branch
    // has been pushed to the remote. If persisted before push, a concurrent agent
    // could discover the branch via findSharedBranchInTab, try to checkout from
    // remote, and fail because the branch doesn't exist on the remote yet.
    //
    // This test documents the contract: isExisting=false means "branch is local only,
    // not yet on remote" → the caller should defer setTaskBranchAndPr until after pushBranch.
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");

    const result = resolveBranchForTask({
      id: 10,
      title: "New task",
      type: "feature",
      branch: null,
      pullRequestUrl: null,
    });

    // isExisting=false signals: branch is new, not yet on remote
    // Caller contract: persist to DB only AFTER push succeeds
    expect(result.isExisting).toBe(false);
    expect(result.branchName).toBeNull();
  });

  it("should return isExisting=true for pre-set branches (safe to persist immediately)", async () => {
    // When task.branch is already set, the branch exists on remote (it was
    // previously pushed). Safe to persist/use immediately without push-first constraint.
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");

    const result = resolveBranchForTask({
      id: 10,
      title: "Existing task",
      type: "feature",
      branch: "feature/#5_shared-branch",
      pullRequestUrl: null,
    });

    expect(result.isExisting).toBe(true);
    expect(result.branchName).toBe("feature/#5_shared-branch");
  });

  it("should return isExisting=true for sibling branches (already on remote, safe to persist)", async () => {
    // When a sibling branch is discovered, it was already pushed by a previous task.
    // Safe to persist immediately.
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");

    const result = resolveBranchForTask(
      { id: 10, title: "Sibling task", type: "feature", branch: null, pullRequestUrl: null },
      "feature/#5_shared-branch"
    );

    expect(result.isExisting).toBe(true);
    expect(result.branchName).toBe("feature/#5_shared-branch");
  });
});

describe("resolveBranchForTask — AC#2 sibling lookup integration", () => {
  it("should use siblingBranch from findSharedBranchInTab when task.branch is null (AC#2)", async () => {
    // This tests the expected orchestration: when task.branch is null, the dev-agent
    // should call findSharedBranchInTab to discover a sibling branch and pass it
    // as the siblingBranch param to resolveBranchForTask.
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");

    // Simulate the orchestration flow: task has no branch, but a sibling branch was found
    const task = {
      id: 20,
      title: "New task in group",
      type: "feature",
      branch: null,
      pullRequestUrl: null,
    };

    // The dev-agent should call findSharedBranchInTab(task.id) and get back a branch
    const siblingBranch = "feature/#15_shared-group-branch";

    // Then pass it to resolveBranchForTask
    const result = resolveBranchForTask(task, siblingBranch);

    expect(result.branchName).toBe("feature/#15_shared-group-branch");
    expect(result.isExisting).toBe(true);
  });

  it("should NOT use siblingBranch when task already has its own branch (AC#1 takes precedence)", async () => {
    const { resolveBranchForTask } = await import("./dev-agent-helpers.js");

    const task = {
      id: 20,
      title: "Task with own branch",
      type: "feature",
      branch: "feature/#20_my-own-branch",
      pullRequestUrl: null,
    };

    const siblingBranch = "feature/#15_different-group";

    const result = resolveBranchForTask(task, siblingBranch);

    // task.branch takes precedence over siblingBranch
    expect(result.branchName).toBe("feature/#20_my-own-branch");
    expect(result.isExisting).toBe(true);
  });
});

describe("findSharedBranchInTab", () => {
  it("should be exported from task-claimer", () => {
    expect(typeof findSharedBranchInTab).toBe("function");
  });

  it("should return a branch shared by multiple tasks in the same tab", async () => {
    const { getPool } = await import("../db/connection.js");
    const mockGetPool = vi.mocked(getPool);

    // Mock: task 10 belongs to tab 2, and there are two tasks sharing "feature/shared"
    const mockRequest = {
      input: vi.fn().mockReturnThis(),
      query: vi.fn(),
    };
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ tab_id: 2 }] }) // tab lookup
      .mockResolvedValueOnce({ recordset: [{ branch: "feature/shared" }] }); // shared branch query with HAVING

    mockGetPool.mockResolvedValue({ request: () => mockRequest } as any);

    const result = await findSharedBranchInTab(10);

    expect(result).toBe("feature/shared");
  });

  it("should return null when no branch is shared by multiple tasks", async () => {
    const { getPool } = await import("../db/connection.js");
    const mockGetPool = vi.mocked(getPool);

    const mockRequest = {
      input: vi.fn().mockReturnThis(),
      query: vi.fn(),
    };
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ tab_id: 2 }] }) // tab lookup
      .mockResolvedValueOnce({ recordset: [] }); // no branches shared by multiple tasks

    mockGetPool.mockResolvedValue({ request: () => mockRequest } as any);

    const result = await findSharedBranchInTab(10);

    expect(result).toBeNull();
  });

  it("should return null when task has no tab associations", async () => {
    const { getPool } = await import("../db/connection.js");
    const mockGetPool = vi.mocked(getPool);

    const mockRequest = {
      input: vi.fn().mockReturnThis(),
      query: vi.fn(),
    };
    mockRequest.query.mockResolvedValueOnce({ recordset: [] }); // no tabs

    mockGetPool.mockResolvedValue({ request: () => mockRequest } as any);

    const result = await findSharedBranchInTab(10);

    expect(result).toBeNull();
  });

  it("should return null when multiple different branches are each shared (ambiguous)", async () => {
    const { getPool } = await import("../db/connection.js");
    const mockGetPool = vi.mocked(getPool);

    const mockRequest = {
      input: vi.fn().mockReturnThis(),
      query: vi.fn(),
    };
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ tab_id: 2 }] }) // tab lookup
      .mockResolvedValueOnce({ recordset: [{ branch: "feature/a" }, { branch: "feature/b" }] }); // multiple shared branches

    mockGetPool.mockResolvedValue({ request: () => mockRequest } as any);

    const result = await findSharedBranchInTab(10);

    expect(result).toBeNull();
  });

  it("should use provided tabIds instead of looking them up", async () => {
    const { getPool } = await import("../db/connection.js");
    const mockGetPool = vi.mocked(getPool);

    const mockRequest = {
      input: vi.fn().mockReturnThis(),
      query: vi.fn(),
    };
    // Only one query (the shared branch query) — no tab lookup needed
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ branch: "feature/shared" }] });

    mockGetPool.mockResolvedValue({ request: () => mockRequest } as any);

    const result = await findSharedBranchInTab(10, [2, 3]);

    expect(result).toBe("feature/shared");
    // Should NOT have queried for tabs (only 1 query call, not 2)
    expect(mockRequest.query).toHaveBeenCalledTimes(1);
  });

  it("should find a branch even when only one sibling task has it (AC#2 primary scenario)", async () => {
    // Scenario: Task A (id=5) created branch "feature/#5_shared". Task B (id=10) has no branch.
    // findSharedBranchInTab(10) should discover "feature/#5_shared" from Task A,
    // even though only ONE other task has that branch (not multiple).
    const { getPool } = await import("../db/connection.js");
    const mockGetPool = vi.mocked(getPool);

    const mockRequest = {
      input: vi.fn().mockReturnThis(),
      query: vi.fn(),
    };
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ tab_id: 2 }] }) // tab lookup for task 10
      .mockResolvedValueOnce({ recordset: [{ branch: "feature/#5_shared" }] }); // single sibling branch found

    mockGetPool.mockResolvedValue({ request: () => mockRequest } as any);

    const result = await findSharedBranchInTab(10);

    expect(result).toBe("feature/#5_shared");
  });

  it("should only find branches from tasks in non-terminal states (todo/in-progress)", async () => {
    // Branches from tasks that are already 'done' or 'developed' should not be discovered
    // as shared branches. Only truly active tasks (todo/in-progress) represent ongoing
    // grouped work that a new task should join. This prevents false matches where a
    // completed task's branch accidentally pulls in unrelated new tasks.
    const { getPool } = await import("../db/connection.js");
    const mockGetPool = vi.mocked(getPool);

    const mockRequest = {
      input: vi.fn().mockReturnThis(),
      query: vi.fn(),
    };
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ tab_id: 2 }] }) // tab lookup
      .mockResolvedValueOnce({ recordset: [] }); // no active branches found (all are done/developed)

    mockGetPool.mockResolvedValue({ request: () => mockRequest } as any);

    const result = await findSharedBranchInTab(10);

    expect(result).toBeNull();

    // Verify the query filters by state — should only include 'todo' and 'in-progress',
    // NOT 'developed' (developed tasks have finished their work and shouldn't attract
    // unrelated new tasks to their branch)
    const queryCall = mockRequest.query.mock.calls[1][0] as string;
    expect(queryCall).toContain("state");
    expect(queryCall).toContain("'todo'");
    expect(queryCall).toContain("'in-progress'");
    expect(queryCall).not.toContain("'developed'");
    expect(queryCall).not.toContain("HAVING COUNT");
  });
});

describe("pushBranch — retry with rebase", () => {
  it("should attempt git pull --rebase between push retry attempts", async () => {
    const { execFile } = await import("node:child_process");
    const mockExecFile = vi.mocked(execFile);

    const calledCommands: string[][] = [];
    let pushCallCount = 0;

    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
      calledCommands.push(args as string[]);
      const callback = typeof _opts === "function" ? _opts : cb;

      if ((args as string[])[0] === "push") {
        pushCallCount++;
        if (pushCallCount === 1) {
          // First push fails (non-fast-forward)
          if (callback) callback(Object.assign(new Error("non-fast-forward"), { stderr: "rejected non-fast-forward" }), "", "rejected non-fast-forward");
        } else {
          // Second push succeeds (after rebase)
          if (callback) callback(null, "", "");
        }
      } else if ((args as string[])[0] === "pull") {
        // Rebase succeeds
        if (callback) callback(null, "", "");
      } else {
        if (callback) callback(null, "", "");
      }
      return {} as any;
    });

    const { pushBranch } = await import("./git-workspace.js");
    await pushBranch("/workspace", "feature/shared-branch", 2, 0);

    // Should have: push (fail), pull --rebase, push (success)
    expect(calledCommands).toEqual([
      ["push", "-u", "origin", "feature/shared-branch"],
      ["pull", "--rebase", "origin", "feature/shared-branch"],
      ["push", "-u", "origin", "feature/shared-branch"],
    ]);
  });

  it("should not attempt rebase if first push succeeds", async () => {
    const { execFile } = await import("node:child_process");
    const mockExecFile = vi.mocked(execFile);

    const calledCommands: string[][] = [];

    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
      calledCommands.push(args as string[]);
      const callback = typeof _opts === "function" ? _opts : cb;
      if (callback) callback(null, "", "");
      return {} as any;
    });

    const { pushBranch } = await import("./git-workspace.js");
    await pushBranch("/workspace", "feature/my-branch", 2, 0);

    // Only one push — no rebase needed
    expect(calledCommands).toEqual([
      ["push", "-u", "origin", "feature/my-branch"],
    ]);
  });

  it("should throw after all retry attempts fail even with rebase", async () => {
    const { execFile } = await import("node:child_process");
    const mockExecFile = vi.mocked(execFile);

    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
      const callback = typeof _opts === "function" ? _opts : cb;

      if ((args as string[])[0] === "push") {
        // All pushes fail
        if (callback) callback(Object.assign(new Error("conflict"), { stderr: "merge conflict" }), "", "merge conflict");
      } else if ((args as string[])[0] === "pull") {
        // Rebase also fails (conflict)
        if (callback) callback(new Error("rebase conflict"), "", "");
      } else {
        if (callback) callback(null, "", "");
      }
      return {} as any;
    });

    const { pushBranch } = await import("./git-workspace.js");
    await expect(pushBranch("/workspace", "feature/conflicting", 2, 0))
      .rejects.toThrow("Push failed after 2 attempts");
  });
});
