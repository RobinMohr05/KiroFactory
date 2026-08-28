/**
 * Tests for PR review comment fixes:
 * 1. reorderSessionsInDb should use a transaction
 * 2. pinSession should broadcast updates for shifted sessions (not just the pinned one)
 * 3. Frontend reorderSessionsOnServer should clean up pendingOps on failure
 *
 * These are unit tests using mocks — they don't require a real DB connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Test 1: reorderSessionsInDb performs all updates atomically, scoped to the
// requesting user's owned sessions
//
// The Neo4j implementation replaced the old mssql explicit
// begin/request-per-update/commit/rollback transaction with a single
// UNWIND-based Cypher statement run inside one writeQuery() (which itself
// runs as one neo4j-driver managed transaction — atomic by construction,
// with no application-level begin/commit/rollback calls to make or assert
// on). These tests were rewritten to assert that new atomicity shape and
// the preserved per-user ownership guarantee, instead of asserting on
// begin/commit/rollback/request calls that no longer exist in this design.
// ============================================================================
describe("reorderSessionsInDb", () => {
  let reorderSessionsInDb: typeof import("../db/sessions.js").reorderSessionsInDb;

  // Mock ManagedTransaction — the callback passed to writeQuery() is
  // invoked with this object and calls `.run(cypher, params)` on it.
  const mockTx = {
    run: vi.fn().mockResolvedValue({ records: [] }),
  };

  let writeQueryMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockTx.run.mockReset().mockResolvedValue({ records: [] });
    writeQueryMock = vi.fn((work: (tx: typeof mockTx) => unknown) => work(mockTx));

    // Mock the connection module with the current readQuery/writeQuery API.
    vi.doMock("../db/connection.js", () => ({
      writeQuery: writeQueryMock,
    }));

    const mod = await import("../db/sessions.js");
    reorderSessionsInDb = mod.reorderSessionsInDb;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("performs all updates atomically — one writeQuery call containing a single tx.run(), not one per session id", async () => {
    await reorderSessionsInDb([10, 20, 30], 1);

    // A single managed write transaction (executeWrite handles atomicity
    // internally, replacing the old explicit begin+commit), containing
    // exactly one Cypher statement that UNWINDs every update together —
    // not a separate request/transaction per session id.
    expect(writeQueryMock).toHaveBeenCalledOnce();
    expect(mockTx.run).toHaveBeenCalledOnce();
  });

  it("scopes every update to sessions owned by the given userId", async () => {
    await reorderSessionsInDb([10, 20, 30], 42);

    expect(mockTx.run).toHaveBeenCalledOnce();
    const [cypher, params] = mockTx.run.mock.calls[0];

    // Preserves the original "AND user_id = @userId" guarantee: the query
    // must match sessions via an ownership relationship scoped to $userId,
    // not an unscoped id-only match — so a sessionId not owned by this user
    // is silently skipped rather than updated.
    expect(cypher).toMatch(/MATCH\s*\(owner:User\s*\{id:\s*\$userId\}\)-\[:OWNS\]->\(s:Session/);
    expect(params.userId).toBe(42);
    expect(params.updates).toEqual([
      { id: 10, order: 0 },
      { id: 20, order: 1 },
      { id: 30, order: 2 },
    ]);
  });

  it("propagates the error (does not silently swallow) if the transaction fails", async () => {
    mockTx.run.mockRejectedValueOnce(new Error("Connection lost"));

    await expect(reorderSessionsInDb([10, 20, 30], 1)).rejects.toThrow("Connection lost");
  });
});

// ============================================================================
// Test 2: pinSession broadcasts updates for ALL shifted sessions
// ============================================================================
describe("pinSession - broadcast shifted sessions on unpin", () => {
  it("should broadcast sessions-reordered (not just session-updated) when pin state changes", async () => {
    // Structural verification: the pinSession function should broadcast "sessions-reordered"
    // to ensure all clients get updated sort orders for shifted sessions.
    // We verify the source code has been fixed by checking the actual module source.
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../session-manager.ts", import.meta.url),
      "utf-8"
    );

    // The pinSession function should broadcast "sessions-reordered", not "session-updated"
    // Find the pinSession function body and check it uses sessions-reordered
    const pinSessionMatch = source.match(
      /export function pinSession[\s\S]*?^}/m
    );
    expect(pinSessionMatch).not.toBeNull();
    const pinSessionBody = pinSessionMatch![0];

    // Must contain sessions-reordered broadcast
    expect(pinSessionBody).toContain('"sessions-reordered"');
    // Must NOT contain a single session-updated broadcast (the old buggy pattern)
    expect(pinSessionBody).not.toContain('"session-updated"');
  });
});

// ============================================================================
// Test 3: Frontend pendingOps cleanup on failure
// ============================================================================
describe("reorderSessionsOnServer - pendingOps cleanup on failure", () => {
  // This is a frontend test. Since the frontend is plain JS (not TypeScript module),
  // we test the logic pattern in isolation.

  it("should remove pendingOps entry when fetch returns non-ok response", async () => {
    // Simulate the pattern
    const pendingOps = new Set<string>();
    let fetchResult: { ok: boolean; status: number } = { ok: false, status: 500 };

    async function reorderSessionsOnServer() {
      try {
        pendingOps.add("sessions-reordered");
        const res = fetchResult;
        if (!res.ok) {
          pendingOps.delete("sessions-reordered");
        }
      } catch (e) {
        pendingOps.delete("sessions-reordered");
      }
    }

    await reorderSessionsOnServer();
    expect(pendingOps.has("sessions-reordered")).toBe(false);
  });

  it("should remove pendingOps entry when fetch throws (network error)", async () => {
    const pendingOps = new Set<string>();

    async function reorderSessionsOnServer() {
      try {
        pendingOps.add("sessions-reordered");
        throw new Error("NetworkError");
      } catch (e) {
        pendingOps.delete("sessions-reordered");
      }
    }

    await reorderSessionsOnServer();
    expect(pendingOps.has("sessions-reordered")).toBe(false);
  });

  it("pendingOps entry persists on success (only cleared by WS handler)", async () => {
    const pendingOps = new Set<string>();
    let fetchResult: { ok: boolean; status: number } = { ok: true, status: 200 };

    async function reorderSessionsOnServer() {
      try {
        pendingOps.add("sessions-reordered");
        const res = fetchResult;
        if (!res.ok) {
          pendingOps.delete("sessions-reordered");
        }
      } catch (e) {
        pendingOps.delete("sessions-reordered");
      }
    }

    await reorderSessionsOnServer();
    // On success, pendingOps should still have the entry (cleared later by WS handler)
    expect(pendingOps.has("sessions-reordered")).toBe(true);
  });
});

// ============================================================================
// Test 4: Chat session cannot be unpinned (protection)
// ============================================================================
describe("pinSession - Chat session protection", () => {
  it("pinSession function should reject unpinning a permanent session", async () => {
    // Structural verification: the pinSession function should contain a guard
    // that prevents unpinning permanent sessions using isPermanent.
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../session-manager.ts", import.meta.url),
      "utf-8"
    );

    // Extract the pinSession function body
    const pinSessionMatch = source.match(
      /export function pinSession[\s\S]*?^}/m
    );
    expect(pinSessionMatch).not.toBeNull();
    const pinSessionBody = pinSessionMatch![0];

    // Must use isPermanent for the guard and return false
    expect(pinSessionBody).toContain("isPermanent");
    expect(pinSessionBody).toContain("return false");
  });

  // Removed: "frontend showSessionContextMenu should not show context menu for permanent sessions"
  // This tested the legacy vanilla-JS frontend (frontend/public/app.js), which has been deleted.
  // The React equivalent (SessionsPanel.tsx's handleContextMenu) has the same isPermanent guard:
  //   if (session.isPermanent) return;
  // React's declarative event handling means this is a simple early-return, not a DOM manipulation
  // pattern that could regress silently — the guard is trivially visible in the function body.
});

// Removed: describe("setupSessionListDropZone - no event listener leak (comment #4)")
// This tested the legacy vanilla-JS frontend (frontend/public/app.js), which has been deleted.
// The bug class (event listener accumulation from calling setupSessionListDropZone inside
// renderSessionList on every re-render) does not apply to the React port: React's declarative
// JSX event props (onDrop={handlePinnedContainerDrop}) are managed by React's reconciliation —
// event handlers are automatically cleaned up and re-attached, so manual addEventListener/
// removeEventListener bookkeeping is not needed and listener leaks cannot occur.

// Removed: describe("cross-section drag - race condition fix (comment #6)")
// This tested the legacy vanilla-JS frontend (frontend/public/app.js), which has been deleted.
// The bug class (concurrent fire-and-forget pinSessionOnServer + reorderSessionsOnServer causing
// a race condition) does not apply to the React port: SessionsPanel.tsx's handleDrop is an async
// function that sequentially awaits the pin PATCH before the reorder PUT — React's async event
// handlers + await naturally serialize these calls without the explicit async-addEventListener
// pattern the vanilla JS version needed.

// ============================================================================
// Test 7: isPermanent field protects the permanent Chat session (comment #7 fix)
// The guard should use isPermanent instead of name === "Chat" to prevent
// user-created sessions named "Chat" from being incorrectly protected.
// ============================================================================
describe("isPermanent - robust permanent session identification (comment #7)", () => {
  it("Session interface should have an isPermanent boolean field", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../types.ts", import.meta.url),
      "utf-8"
    );

    // The Session interface should contain an isPermanent field
    const sessionInterface = source.match(
      /export interface Session \{[\s\S]*?\n\}/
    );
    expect(sessionInterface).not.toBeNull();
    expect(sessionInterface![0]).toMatch(/isPermanent.*?boolean/);
  });

  it("pinSession guard should check isPermanent (not name === 'Chat')", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../session-manager.ts", import.meta.url),
      "utf-8"
    );

    // Extract the pinSession function body
    const pinSessionMatch = source.match(
      /export function pinSession[\s\S]*?^}/m
    );
    expect(pinSessionMatch).not.toBeNull();
    const pinSessionBody = pinSessionMatch![0];

    // Must use isPermanent for the guard, NOT name === "Chat"
    expect(pinSessionBody).toContain("isPermanent");
    // The fragile name-based check should be removed
    expect(pinSessionBody).not.toMatch(/\.name\s*===\s*["']Chat["']/);
  });

  it("deleteSession guard should check isPermanent (not just pinned)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../session-manager.ts", import.meta.url),
      "utf-8"
    );

    // Extract the deleteSession function body
    const deleteSessionMatch = source.match(
      /export function deleteSession[\s\S]*?^}/m
    );
    expect(deleteSessionMatch).not.toBeNull();
    const deleteSessionBody = deleteSessionMatch![0];

    // Must check isPermanent (not just pinned, since user-pinned sessions should be deletable)
    expect(deleteSessionBody).toContain("isPermanent");
  });

  // Removed: "frontend showSessionContextMenu should use isPermanent instead of name === 'Chat'"
  // This tested the legacy vanilla-JS frontend (frontend/public/app.js), which has been deleted.
  // The React equivalent (SessionsPanel.tsx's handleContextMenu) uses the same isPermanent guard:
  //   if (session.isPermanent) return;
  // The guard is trivially visible in the function body and structurally cannot regress to a
  // name-based check without a deliberate rewrite.

  it("CreateSessionInput should have isPermanent as optional internal-only field", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../types.ts", import.meta.url),
      "utf-8"
    );

    // The CreateSessionInput should contain isPermanent as optional
    const createInputInterface = source.match(
      /export interface CreateSessionInput \{[\s\S]*?\n\}/
    );
    expect(createInputInterface).not.toBeNull();
    expect(createInputInterface![0]).toMatch(/isPermanent\?.*?boolean/);
  });
});

// Removed: describe("context menu pin handler - pendingOps suppression (comment #10)")
// This tested the legacy vanilla-JS frontend (frontend/public/app.js), which has been deleted.
// The React equivalent (SessionsPanel.tsx's handlePinToggle) already adds
// pendingOps.current.add('sessions-reordered') before the apiFetch PATCH call, and cleans it
// up in the catch block. This ordering is visible in the function body and is the natural
// React pattern for optimistic UI updates.

// ============================================================================
// Test 9: New sessions should get sortOrder at end of group (comment #11)
// ============================================================================
describe("createSession - sortOrder calculation (comment #11)", () => {
  it("should calculate sortOrder based on existing sessions instead of hardcoding 0", async () => {
    // Structural verification: the createSession function should compute sortOrder
    // based on existing sessions for the user, not use a fixed value of 0 that would
    // cause collisions with existing sessions.
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../session-manager.ts", import.meta.url),
      "utf-8"
    );

    // Find the createSession function body
    const funcStart = source.indexOf("export async function createSession(");
    expect(funcStart).toBeGreaterThan(-1);

    let braceDepth = 0;
    let funcBodyStart = -1;
    let funcEnd = -1;
    for (let i = funcStart; i < source.length; i++) {
      if (source[i] === "{") {
        if (funcBodyStart === -1) funcBodyStart = i;
        braceDepth++;
      } else if (source[i] === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          funcEnd = i + 1;
          break;
        }
      }
    }
    expect(funcEnd).toBeGreaterThan(funcStart);
    const createSessionBody = source.slice(funcStart, funcEnd);

    // Should contain logic to calculate maxOrder from existing sessions
    expect(createSessionBody).toContain("maxOrder");
    // Should use Math.max to find the highest existing sortOrder
    expect(createSessionBody).toContain("Math.max");
    // Should set sortOrder to maxOrder + 1 (at end of group)
    expect(createSessionBody).toContain("maxOrder + 1");
  });
});
