/**
 * Tests for prompt-builder — buildDevPrompt and buildReviewPrompt.
 */

import { describe, it, expect } from "vitest";
import { buildDevPrompt, buildReviewPrompt } from "./prompt-builder.js";
import type { ClaimedTask } from "./task-claimer.js";

function makeTask(overrides: Partial<ClaimedTask> = {}): ClaimedTask {
  return {
    id: 100,
    title: "Test task",
    description: "A test description",
    priority: 3,
    type: "feature",
    files: ["src/foo.ts"],
    origin: "user",
    branch: "feature/#100_test-task",
    pullRequestUrl: "https://github.com/org/repo/pull/42",
    groupId: null,
    repositoryUrl: "https://github.com/org/repo",
    userId: 1,
    ...overrides,
  };
}

describe("buildReviewPrompt", () => {
  describe("autoMergePrs parameter", () => {
    it("includes AUTO-MERGE ENABLED section when autoMergePrs is true", () => {
      const prompt = buildReviewPrompt(makeTask(), "/workspace", true);
      expect(prompt).toContain("## AUTO-MERGE ENABLED");
      expect(prompt).toContain("complete_pull_request");
      expect(prompt).toContain("report_verdict");
    });

    it("does NOT include AUTO-MERGE ENABLED section when autoMergePrs is false", () => {
      const prompt = buildReviewPrompt(makeTask(), "/workspace", false);
      expect(prompt).not.toContain("## AUTO-MERGE ENABLED");
      expect(prompt).not.toContain("complete_pull_request");
    });

    it("does NOT include AUTO-MERGE ENABLED section when autoMergePrs is omitted", () => {
      const prompt = buildReviewPrompt(makeTask(), "/workspace");
      expect(prompt).not.toContain("## AUTO-MERGE ENABLED");
      expect(prompt).not.toContain("complete_pull_request");
    });

    it("includes merge_conflict handling instructions when autoMergePrs is true", () => {
      const prompt = buildReviewPrompt(makeTask(), "/workspace", true);
      expect(prompt).toContain("merge_conflict");
      expect(prompt).toContain("changes_requested");
    });

    it("includes deferred handling instructions when autoMergePrs is true", () => {
      const prompt = buildReviewPrompt(makeTask(), "/workspace", true);
      expect(prompt).toContain("deferred");
      expect(prompt).toContain("sibling tasks not yet complete");
    });

    it("still includes standard review instructions regardless of autoMergePrs", () => {
      const promptWithMerge = buildReviewPrompt(makeTask(), "/workspace", true);
      const promptWithout = buildReviewPrompt(makeTask(), "/workspace", false);

      // Both should have the standard review content
      expect(promptWithMerge).toContain("TASK BEING REVIEWED");
      expect(promptWithMerge).toContain("report_verdict");
      expect(promptWithout).toContain("TASK BEING REVIEWED");
      expect(promptWithout).toContain("report_verdict");
    });
  });
});

describe("buildDevPrompt", () => {
  describe("BRANCH SYNC & DELIVERY section", () => {
    it("includes BRANCH SYNC & DELIVERY section with MCP tool instructions", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("## BRANCH SYNC & DELIVERY (MCP tools)");
      expect(prompt).toContain("sync_task_branch");
      expect(prompt).toContain("submit_task_changes");
    });

    it("includes instructions for conflict resolution via finalize_branch_sync", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("hadConflicts: true");
      expect(prompt).toContain("finalize_branch_sync");
    });

    it("includes conventional-commit format guidance for submit_task_changes", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("conventional-commit");
      expect(prompt).toContain("feat:");
      expect(prompt).toContain("fix:");
    });

    it("tells the agent NOT to add the Vibecode Heaven suffix manually", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("Do NOT add a `[Vibecode Heaven #id]` suffix");
    });

    it("also includes BRANCH SYNC & DELIVERY section when branch is null (tools handle creation)", () => {
      const task = makeTask({ branch: null });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("## BRANCH SYNC & DELIVERY (MCP tools)");
    });

    it("tells the agent not to run git commands manually and to use MCP tools exclusively", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("Do NOT run git commit, git push, or create pull requests manually");
      expect(prompt).toContain("MCP tools exclusively");
    });

    it("tells the agent to use MCP tools even when branch is not yet set", () => {
      const task = makeTask({ branch: null });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("Do NOT run git commit, git push, or create pull requests manually");
      expect(prompt).toContain("MCP tools exclusively");
      expect(prompt).toContain("Do NOT run git commands that change repository state");
    });
  });
});