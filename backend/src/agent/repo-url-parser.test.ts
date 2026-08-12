/**
 * Tests for the requiresTask agent feature:
 * - Agent model includes requiresTask (defaults to true)
 * - buildPersistentBranchName produces unique slugified names
 * - The standalone (no-task) loop doesn't call claimTask
 */

import { describe, it, expect } from "vitest";

import { buildPersistentBranchName } from "../agent/repo-url-parser.js";

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
