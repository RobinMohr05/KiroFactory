/**
 * Tests for deleteUser's account-deletion behavior (db/users.ts).
 *
 * Task #1972: DELETE /api/auth/me could never succeed because deleteUser
 * refused the delete whenever the user still owned ANYTHING via :OWNS. But
 * every registered user always owns at least their permanent "Chat" Session
 * (created at registration / backfilled by migrate.ts), so the guard could
 * never pass and the route always 404'd.
 *
 * The fix narrows the "block deletion" guard to node types that must NOT be
 * silently destroyed (Tab / Agent / AutoScaler), while cascade-cleaning the
 * safe-to-remove owned nodes (Sessions + their MCP config children,
 * PlannerConversations + their messages) as part of the delete.
 *
 * Neo4j is mocked the same way the other db/*.test.ts files mock it — no
 * live AuraDB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB connection module
vi.mock("./connection.js", () => ({
  readQuery: vi.fn(),
  writeQuery: vi.fn(),
}));

// Mock the id-counter module (imported transitively by users.ts)
vi.mock("./id-counter.js", () => ({
  getNextId: vi.fn().mockResolvedValue(100),
}));

import { writeQuery } from "./connection.js";
import { deleteUser } from "./users.js";

describe("db/users deleteUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the user (and cascades) even though they own a permanent Session", async () => {
    let capturedCypher = "";
    (writeQuery as any).mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockImplementation((cypher: string) => {
          capturedCypher = cypher;
          // Guarded node types (Tab/Agent/AutoScaler) not owned -> blocked=false;
          // the delete then reports a positive deletedCount.
          return {
            records: [
              {
                get: (k: string) => {
                  if (k === "blocked") return false;
                  if (k === "deletedCount") return 1;
                  return null;
                },
              },
            ],
          };
        }),
      };
      return fn(mockTx);
    });

    const ok = await deleteUser(1);
    expect(ok).toBe(true);
    // Sessions and PlannerConversations should be cascade-cleaned.
    expect(capturedCypher).toContain("DETACH DELETE");
    expect(capturedCypher).toContain("Session");
    expect(capturedCypher).toContain("PlannerConversation");
  });

  it("refuses to delete a user who still owns a Tab / Agent / AutoScaler", async () => {
    (writeQuery as any).mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockImplementation((cypher: string) => {
          // Only the guard query runs; it reports the user still owns a
          // protected node, so the delete must be refused.
          if (cypher.includes("blocked")) {
            return {
              records: [{ get: (k: string) => (k === "blocked" ? true : null) }],
            };
          }
          throw new Error("delete must not run when blocked");
        }),
      };
      return fn(mockTx);
    });

    const ok = await deleteUser(1);
    expect(ok).toBe(false);
  });

  it("returns false when the user does not exist", async () => {
    (writeQuery as any).mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockImplementation((cypher: string) => {
          if (cypher.includes("blocked")) {
            return {
              records: [{ get: (k: string) => (k === "blocked" ? false : null) }],
            };
          }
          // No user node matched -> nothing deleted.
          return {
            records: [{ get: (k: string) => (k === "deletedCount" ? 0 : null) }],
          };
        }),
      };
      return fn(mockTx);
    });

    const ok = await deleteUser(999);
    expect(ok).toBe(false);
  });
});
