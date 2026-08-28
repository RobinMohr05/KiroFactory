import { describe, it, expect } from "vitest";

/**
 * Tests for the dependency combobox search/filter logic used by TaskModal's
 * getFilteredTasks(). The matching logic lives inline inside a useCallback in
 * TaskModal.tsx, so we mirror the core predicate here to verify edge cases.
 *
 * Ported from backend/src/tests/dependency-search-logic.test.ts, which tested
 * the equivalent logic from the now-deleted frontend/public/app.js (legacy
 * vanilla-JS UI). The matching predicate is identical in the React version:
 *   t.title.toLowerCase().includes(q) || String(t.id).includes(idQuery)
 * where idQuery strips a leading '#' from the query.
 *
 * Keep this in sync with TaskModal.tsx's getFilteredTasks().
 */

// Mirror of the matching predicate from TaskModal.tsx's getFilteredTasks()
function matchesQuery(
  task: { id: number; title: string },
  query: string
): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return false;
  const idQuery = q.startsWith("#") ? q.slice(1) : q;
  return (
    task.title.toLowerCase().includes(q) || String(task.id).includes(idQuery)
  );
}

describe("dependency combobox getFilteredTasks logic (TaskModal.tsx)", () => {
  it("matches task by title substring (case-insensitive)", () => {
    const task = { id: 42, title: "Fix login page" };
    expect(matchesQuery(task, "login")).toBe(true);
    expect(matchesQuery(task, "LOGIN")).toBe(true);
    expect(matchesQuery(task, "fix")).toBe(true);
  });

  it("does NOT match unrelated queries", () => {
    const task = { id: 42, title: "Fix login page" };
    expect(matchesQuery(task, "signup")).toBe(false);
    expect(matchesQuery(task, "99")).toBe(false);
  });

  it("matches task by numeric ID without # prefix", () => {
    const task = { id: 42, title: "Fix login page" };
    expect(matchesQuery(task, "42")).toBe(true);
    expect(matchesQuery(task, "4")).toBe(true); // partial ID match
  });

  it("matches task by ID with # prefix (as shown in placeholder)", () => {
    const task = { id: 42, title: "Fix login page" };
    expect(matchesQuery(task, "#42")).toBe(true);
    expect(matchesQuery(task, "#4")).toBe(true); // partial match
  });

  it("does NOT match wrong ID with # prefix", () => {
    const task = { id: 42, title: "Fix login page" };
    expect(matchesQuery(task, "#99")).toBe(false);
    expect(matchesQuery(task, "#5")).toBe(false);
  });

  it("returns false for empty query", () => {
    const task = { id: 42, title: "Fix login page" };
    expect(matchesQuery(task, "")).toBe(false);
    expect(matchesQuery(task, "   ")).toBe(false);
  });

  it("handles # alone as query gracefully", () => {
    // "#" alone: q = "#", idQuery = "" — String.includes("") is always true
    // This is acceptable — "#" alone effectively shows all results
    const task = { id: 42, title: "Fix login page" };
    expect(matchesQuery(task, "#")).toBe(true);
  });
});
