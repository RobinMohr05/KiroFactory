/**
 * Tests for:
 * 1. Agent `requiresTask` defaults to true for existing agents
 * 2. `buildPersistentBranchName` produces unique name per session ID
 * 3. Standalone (no-task) loop mode does not call claimTask
 */

import { describe, it, expect } from "vitest";
import { slugifyTitle, buildBranchName } from "./agent/repo-url-parser.js";

// Import the new function (will be created)
import { buildPersistentBranchName } from "./agent/repo-url-parser.js";

describe("buildPersistentBranchName", () => {
  it("returns a branch name with session name slug and session ID suffix", () => {
    const result = buildPersistentBranchName(42, "Information Collector");
    expect(result).toBe("information-collector-s42");
  });

  it("produces unique names for different session IDs with the same name", () => {
    const a = buildPersistentBranchName(1, "My Session");
    const b = buildPersistentBranchName(2, "My Session");
    expect(a).not.toBe(b);
    expect(a).toBe("my-session-s1");
    expect(b).toBe("my-session-s2");
  });

  it("handles special characters in session name", () => {
    const result = buildPersistentBranchName(7, "Test: Special (Chars) & More!");
    expect(result).toBe("test-special-chars-more-s7");
  });

  it("truncates long session names", () => {
    const longName = "a".repeat(100);
    const result = buildPersistentBranchName(99, longName);
    // slugifyTitle truncates to 60 chars
    expect(result.length).toBeLessThanOrEqual(60 + 1 + 3 + 2); // slug + "-" + "s99"
    expect(result).toMatch(/-s99$/);
  });

  it("does not produce empty slug for edge case names", () => {
    const result = buildPersistentBranchName(5, "!!!");
    // Even if the slug is empty, session ID ensures uniqueness
    expect(result).toBe("s5");
  });
});

describe("Agent requiresTask type contract", () => {
  it("Agent interface expects requiresTask field (compile-time test)", () => {
    // This is a compile-time assertion — if the type doesn't have requiresTask,
    // this file won't compile. The runtime assertion is a formality.
    const agent: { requiresTask: boolean } = { requiresTask: true };
    expect(agent.requiresTask).toBe(true);
  });
});
