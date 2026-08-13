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
import { checkoutExistingBranch } from "./git-workspace.js";
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
});
