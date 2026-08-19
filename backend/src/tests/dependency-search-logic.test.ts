import { describe, it, expect } from "vitest";

/**
 * Tests for the dependency combobox search logic (frontend/public/app.js).
 *
 * Since the frontend is vanilla JS (no modules), we replicate the core matching
 * logic here to verify it handles edge cases — particularly the #id prefix
 * format shown in the placeholder text ("Search by title or #id…").
 *
 * This function MUST be kept in sync with the actual logic in
 * `getFilteredTasks()` inside `populateTaskDependsOnSelect()` in app.js.
 * If the logic changes there, update this mirror.
 */

// ===== Mirror of getFilteredTasks matching logic from app.js =====
// This MUST match the implementation in frontend/public/app.js exactly.
// Update this when fixing the implementation.
function matchesQuery(
  task: { id: number; title: string },
  query: string
): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return false;
  // Strip leading # for ID matching (placeholder shows "#id" format)
  const idQuery = q.startsWith("#") ? q.slice(1) : q;
  return (
    task.title.toLowerCase().includes(q) || String(task.id).includes(idQuery)
  );
}

describe("dependency combobox getFilteredTasks logic", () => {
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
