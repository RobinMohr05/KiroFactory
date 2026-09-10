/**
 * Tests for db/sessions.ts's getAllSessionsFromDb() pooled-session exclusion
 * (task #1680): sessions owned by an AutoScaler (an incoming
 * (:AutoScaler)-[:OWNS_SESSION]->(:Session) edge) must be excluded from the
 * default query, but included when `{ includePooled: true }` is passed
 * (used only by session-manager.ts's initSessions() on boot).
 *
 * Follows the same mocked-connection pattern as db/turns.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./connection.js", () => ({
  readQuery: vi.fn(),
  writeQuery: vi.fn(),
}));

vi.mock("./id-counter.js", () => ({
  getNextId: vi.fn().mockResolvedValue(100),
}));

import { readQuery } from "./connection.js";
import { getAllSessionsFromDb } from "./sessions.js";

function emptyRunMock() {
  return vi.fn().mockResolvedValue({ records: [] });
}

describe("db/sessions — getAllSessionsFromDb pooled-session exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a WHERE NOT (:AutoScaler)-[:OWNS_SESSION]->(s) guard by default", async () => {
    const runMock = emptyRunMock();
    (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

    await getAllSessionsFromDb();

    const [query] = runMock.mock.calls[0];
    expect(query).toContain("WHERE NOT (:AutoScaler)-[:OWNS_SESSION]->(s)");
  });

  it("also applies the guard when scoped to a specific userId", async () => {
    const runMock = emptyRunMock();
    (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

    await getAllSessionsFromDb(1);

    const [query] = runMock.mock.calls[0];
    expect(query).toContain("MATCH (u:User {id: $userId})-[:OWNS]->(s:Session)");
    expect(query).toContain("WHERE NOT (:AutoScaler)-[:OWNS_SESSION]->(s)");
  });

  it("omits the guard when includePooled: true is passed", async () => {
    const runMock = emptyRunMock();
    (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

    await getAllSessionsFromDb(undefined, { includePooled: true });

    const [query] = runMock.mock.calls[0];
    expect(query).not.toContain("WHERE NOT (:AutoScaler)-[:OWNS_SESSION]->(s)");
  });
});
