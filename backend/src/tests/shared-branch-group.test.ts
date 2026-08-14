/**
 * Tests for shared branch/PR support for grouped tasks (task #163).
 *
 * Tasks that share the same `branch` value should be worked on in the same
 * git branch and PR instead of each creating their own.
 */

import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module from worker/ (no type declarations; runs fine at test time)
import { buildGroupPrContent, findGroupBranchFromSiblings, findSiblingPrUrl } from "../../../worker/shared-branch-utils.js";

describe("shared branch group - buildGroupPrContent", () => {
  // Tests AC5: PR title/body should reference all tasks in the group

  it("should build PR content referencing a single task when no siblings", () => {
    const result = buildGroupPrContent(
      { id: 10, title: "Add login page", type: "feature", description: "Build a login UI" },
      [] // no siblings
    );

    expect(result.title).toContain("Add login page");
    expect(result.title).toContain("#10");
    expect(result.body).toContain("Add login page");
    expect(result.body).toContain("Build a login UI");
  });

  it("should build PR content referencing all tasks in a group", () => {
    const currentTask = { id: 12, title: "Add logout button", type: "feature", description: "A logout button" };
    const siblings = [
      { id: 10, title: "Add login page", type: "feature", description: "Build a login UI" },
      { id: 11, title: "Add session management", type: "feature", description: "Handle sessions" },
    ];

    const result = buildGroupPrContent(currentTask, siblings);

    // Title should reference the group, not just one task
    expect(result.title).toContain("#10");
    expect(result.title).toContain("#11");
    expect(result.title).toContain("#12");
    // Body should list all tasks
    expect(result.body).toContain("Add login page");
    expect(result.body).toContain("Add session management");
    expect(result.body).toContain("Add logout button");
  });

  it("should sort tasks by ID in the title", () => {
    const currentTask = { id: 15, title: "Task C", type: "bug", description: "desc" };
    const siblings = [
      { id: 20, title: "Task D", type: "feature", description: "desc" },
      { id: 5, title: "Task A", type: "improvement", description: "desc" },
    ];

    const result = buildGroupPrContent(currentTask, siblings);

    // IDs should appear in ascending order in the title
    const titleIds = result.title.match(/#\d+/g) || [];
    expect(titleIds).toEqual(["#5", "#15", "#20"]);
  });

  it("should produce consistent format for single task (backward compatible)", () => {
    const result = buildGroupPrContent(
      { id: 42, title: "Fix bug", type: "bug", description: "Fix it" },
      []
    );

    // Should match the existing worker.js buildPrContent() output format
    expect(result.title).toBe("Fix bug [KiroFactory #42]");
    expect(result.body).toContain("## Task");
    expect(result.body).toContain("**Title:** Fix bug");
    expect(result.body).toContain("**Type:** bug");
    expect(result.body).toContain("**ID:** 42");
    expect(result.body).toContain("## Description");
    expect(result.body).toContain("Fix it");
    expect(result.body).toContain("*Created automatically by KiroFactory*");
  });

  it("should handle tasks with empty descriptions", () => {
    const result = buildGroupPrContent(
      { id: 1, title: "Task", type: "feature", description: "" },
      [{ id: 2, title: "Other", type: "bug", description: "" }]
    );

    expect(result.body).toContain("_(no description provided)_");
  });
});

describe("shared branch group - findGroupBranchFromSiblings", () => {
  // Tests AC2: looking up the shared branch name from sibling tasks

  it("should return null when siblings array is empty", () => {
    const result = findGroupBranchFromSiblings([]);
    expect(result).toBeNull();
  });

  it("should return null when no siblings have a branch", () => {
    const siblings = [
      { branch: null, pullRequestUrl: null },
      { branch: null, pullRequestUrl: null },
    ];

    const result = findGroupBranchFromSiblings(siblings);
    expect(result).toBeNull();
  });

  it("should return the branch from a sibling that has one", () => {
    const siblings = [
      { branch: "feature/#10_add-login-page", pullRequestUrl: "https://github.com/org/repo/pull/5" },
      { branch: null, pullRequestUrl: null },
    ];

    const result = findGroupBranchFromSiblings(siblings);
    expect(result).toEqual({
      branch: "feature/#10_add-login-page",
      pullRequestUrl: "https://github.com/org/repo/pull/5",
    });
  });

  it("should prefer a sibling with both branch and PR URL", () => {
    const siblings = [
      { branch: "feature/#10_add-login-page", pullRequestUrl: null },
      { branch: "feature/#10_add-login-page", pullRequestUrl: "https://github.com/org/repo/pull/5" },
    ];

    const result = findGroupBranchFromSiblings(siblings);
    expect(result).toEqual({
      branch: "feature/#10_add-login-page",
      pullRequestUrl: "https://github.com/org/repo/pull/5",
    });
  });

  it("should return branch without PR URL when none have PR URL", () => {
    const siblings = [
      { branch: null, pullRequestUrl: null },
      { branch: "feature/#7_setup-auth", pullRequestUrl: null },
    ];

    const result = findGroupBranchFromSiblings(siblings);
    expect(result).toEqual({
      branch: "feature/#7_setup-auth",
      pullRequestUrl: null,
    });
  });
});

describe("shared branch group - findSiblingPrUrl", () => {
  // Tests that we can resolve a PR URL from sibling tasks when the current
  // task's own pullRequestUrl is null (review comment fix: second+ tasks in
  // a group don't have their own PR URL persisted).

  it("should return null when siblings array is empty", () => {
    const result = findSiblingPrUrl([]);
    expect(result).toBeNull();
  });

  it("should return null when no siblings have a pullRequestUrl", () => {
    const siblings = [
      { id: 10, title: "Task A", type: "feature", description: "a", pullRequestUrl: null },
      { id: 11, title: "Task B", type: "feature", description: "b", pullRequestUrl: null },
    ];
    const result = findSiblingPrUrl(siblings);
    expect(result).toBeNull();
  });

  it("should return the first sibling's pullRequestUrl when available", () => {
    const siblings = [
      { id: 10, title: "Task A", type: "feature", description: "a", pullRequestUrl: "https://github.com/org/repo/pull/5" },
      { id: 11, title: "Task B", type: "feature", description: "b", pullRequestUrl: null },
    ];
    const result = findSiblingPrUrl(siblings);
    expect(result).toBe("https://github.com/org/repo/pull/5");
  });

  it("should return the PR URL even if only one sibling has it", () => {
    const siblings = [
      { id: 10, title: "Task A", type: "feature", description: "a", pullRequestUrl: null },
      { id: 11, title: "Task B", type: "feature", description: "b", pullRequestUrl: null },
      { id: 12, title: "Task C", type: "feature", description: "c", pullRequestUrl: "https://github.com/org/repo/pull/7" },
    ];
    const result = findSiblingPrUrl(siblings);
    expect(result).toBe("https://github.com/org/repo/pull/7");
  });
});
