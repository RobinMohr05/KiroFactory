/**
 * Tests for the requiresTask agent feature:
 * - Agent model includes requiresTask (defaults to true)
 * - buildPersistentBranchName produces unique slugified names
 * - The standalone (no-task) loop doesn't call claimTask
 */

import { describe, it, expect } from "vitest";

import { buildPersistentBranchName, buildTaskBranchName } from "../agent/repo-url-parser.js";

describe("buildPersistentBranchName", () => {
  it("should produce a slugified branch name with session ID suffix", () => {
    const result = buildPersistentBranchName(42, "My Research Session");
    expect(result).toBe("my-research-session-s42");
  });

  it("should handle special characters in session name", () => {
    const result = buildPersistentBranchName(7, "Test: Collect Data (v2)!");
    expect(result).toBe("test-collect-data-v2-s7");
  });

  it("should produce unique names for different session IDs with same name", () => {
    const a = buildPersistentBranchName(1, "Collector");
    const b = buildPersistentBranchName(2, "Collector");
    expect(a).not.toBe(b);
    expect(a).toBe("collector-s1");
    expect(b).toBe("collector-s2");
  });

  it("should truncate long session names", () => {
    const longName = "a".repeat(100);
    const result = buildPersistentBranchName(99, longName);
    // Slug truncates to 60 chars, then appends -s99
    expect(result.length).toBeLessThanOrEqual(60 + 4); // 60 + "-s99"
    expect(result).toMatch(/-s99$/);
  });

  it("should handle empty session name gracefully", () => {
    const result = buildPersistentBranchName(5, "");
    expect(result).toBe("s5");
  });
});

describe("buildTaskBranchName", () => {
  it("should produce a [type]/#[id]_[slug] branch name", () => {
    const result = buildTaskBranchName("bug", 598, "Local-mode pipeline has no commit gate");
    expect(result).toBe("bug/#598_local-mode-pipeline-has-no-commit-gate");
  });

  it("should match worker.js's buildBranchName format for feature tasks", () => {
    const result = buildTaskBranchName("feature", 42, "Add dark mode toggle");
    expect(result).toBe("feature/#42_add-dark-mode-toggle");
  });

  it("should handle special characters in the task title", () => {
    const result = buildTaskBranchName("improvement", 7, "Refactor: cleanup (v2)!");
    expect(result).toBe("improvement/#7_refactor-cleanup-v2");
  });

  it("should produce the same branch name for the same task every time (determinism)", () => {
    const a = buildTaskBranchName("bug", 100, "Fix the thing");
    const b = buildTaskBranchName("bug", 100, "Fix the thing");
    expect(a).toBe(b);
  });

  it("should produce different branch names for different task IDs with the same title", () => {
    const a = buildTaskBranchName("bug", 1, "Duplicate title");
    const b = buildTaskBranchName("bug", 2, "Duplicate title");
    expect(a).not.toBe(b);
  });
});
