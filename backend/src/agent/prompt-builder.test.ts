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
  describe("BRANCH SETUP section", () => {
    it("includes BRANCH SETUP section with the task branch name when branch is set", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("## BRANCH SETUP");
      expect(prompt).toContain("feature/#100_test-task");
    });

    it("includes instructions to check if branch exists remotely", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("git ls-remote --heads origin feature/#100_test-task");
    });

    it("includes instructions to checkout and merge develop if branch exists", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("git fetch origin feature/#100_test-task");
      expect(prompt).toContain("git checkout -B feature/#100_test-task origin/feature/#100_test-task");
      expect(prompt).toContain("git merge origin/develop");
    });

    it("includes instructions to create a new branch if it does not exist", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).toContain("git checkout -B feature/#100_test-task");
    });

    it("does NOT include BRANCH SETUP section when branch is null", () => {
      const task = makeTask({ branch: null });
      const prompt = buildDevPrompt(task, "/workspace");
      expect(prompt).not.toContain("## BRANCH SETUP");
    });

    it("does NOT tell the agent to avoid ALL git commands in BRANCH SETUP mode", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      // When branch setup is active, the blanket "Do NOT run any git commands at all"
      // prohibition should be replaced with a more nuanced rule that allows branch operations
      expect(prompt).not.toMatch(/Do NOT run any git commands at all[^]*?The orchestrator manages ALL git operations\.\s*\n- Do NOT create/);
    });

    it("still tells the agent not to commit or push (orchestrator handles that)", () => {
      const task = makeTask({ branch: "feature/#100_test-task" });
      const prompt = buildDevPrompt(task, "/workspace");
      // Should still prohibit commit/push for implementation work
      expect(prompt).toContain("Do NOT run `git commit` for your own implementation work");
      expect(prompt).toContain("git push");
      expect(prompt).toContain("orchestrator");
    });
  });
});