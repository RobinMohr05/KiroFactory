/**
 * Tests for buildReviewPrompt — auto-merge prompt section.
 */

import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "./prompt-builder.js";
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
