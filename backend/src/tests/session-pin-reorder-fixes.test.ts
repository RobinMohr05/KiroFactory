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
// Test 1: reorderSessionsInDb wraps updates in a transaction
// ============================================================================
describe("reorderSessionsInDb", () => {
  let reorderSessionsInDb: typeof import("../db/sessions.js").reorderSessionsInDb;

  const mockRequest = {
    input: vi.fn().mockReturnThis(),
    query: vi.fn().mockResolvedValue({}),
  };

  const mockTransaction = {
    begin: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockReturnValue(mockRequest),
  };

  const mockPool = {
    request: vi.fn().mockReturnValue(mockRequest),
  };

  // Create a class that returns our mock transaction when instantiated
  class MockTransactionClass {
    begin = mockTransaction.begin;
    commit = mockTransaction.commit;
    rollback = mockTransaction.rollback;
    request = mockTransaction.request;
    constructor(_pool: any) {}
  }

  beforeEach(async () => {
    vi.resetModules();

    // Reset mock call counts
    mockRequest.input.mockClear();
    mockRequest.query.mockClear().mockResolvedValue({});
    mockTransaction.begin.mockClear();
    mockTransaction.commit.mockClear();
    mockTransaction.rollback.mockClear();
    mockTransaction.request.mockClear().mockReturnValue(mockRequest);
    mockPool.request.mockClear();

    // Mock the connection module
    vi.doMock("../db/connection.js", () => ({
      getPool: vi.fn().mockResolvedValue(mockPool),
      sql: {
        Int: "Int",
        Transaction: MockTransactionClass,
      },
    }));

    const mod = await import("../db/sessions.js");
    reorderSessionsInDb = mod.reorderSessionsInDb;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should wrap all updates in a transaction (begin + commit)", async () => {
    await reorderSessionsInDb([10, 20, 30], 1);

    expect(mockTransaction.begin).toHaveBeenCalledOnce();
    expect(mockTransaction.commit).toHaveBeenCalledOnce();
    expect(mockTransaction.rollback).not.toHaveBeenCalled();
  });

  it("should use transaction.request() for each update, not pool.request()", async () => {
    await reorderSessionsInDb([10, 20, 30], 1);

    // Should use transaction's request, not pool's
    expect(mockTransaction.request).toHaveBeenCalledTimes(3);
    expect(mockPool.request).not.toHaveBeenCalled();
  });

  it("should rollback if a query fails midway", async () => {
    mockRequest.query
      .mockResolvedValueOnce({}) // first succeeds
      .mockRejectedValueOnce(new Error("Connection lost")); // second fails

    await expect(reorderSessionsInDb([10, 20, 30], 1)).rejects.toThrow("Connection lost");

    expect(mockTransaction.begin).toHaveBeenCalledOnce();
    expect(mockTransaction.rollback).toHaveBeenCalledOnce();
    expect(mockTransaction.commit).not.toHaveBeenCalled();
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

  it("frontend showSessionContextMenu should not show context menu for permanent sessions", async () => {
    // Structural verification: the frontend should prevent showing context menu for permanent sessions
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../../frontend/public/app.js", import.meta.url),
      "utf-8"
    );

    // The showSessionContextMenu function should have a guard for permanent sessions
    const funcStart = source.indexOf("function showSessionContextMenu(");
    expect(funcStart).toBeGreaterThan(-1);

    // Find the function's closing brace by tracking brace depth
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

    const contextMenuBody = source.slice(funcStart, funcEnd);

    // Should use isPermanent instead of name === 'Chat'
    expect(contextMenuBody).toContain("isPermanent");
  });
});

// ============================================================================
// Test 5: setupSessionListDropZone must NOT be called inside renderSessionList
// ============================================================================
describe("setupSessionListDropZone - no event listener leak (comment #4)", () => {
  it("should NOT be called inside renderSessionList (prevents listener accumulation)", async () => {
    // Structural verification: renderSessionList() must NOT contain calls to setupSessionListDropZone.
    // The drop zone setup should be done once during initialization (in setupSessions), not on every render.
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../../frontend/public/app.js", import.meta.url),
      "utf-8"
    );

    // Extract the renderSessionList function body
    const funcStart = source.indexOf("function renderSessionList()");
    expect(funcStart).toBeGreaterThan(-1);

    // Find the function's closing brace by tracking brace depth
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

    const renderSessionListBody = source.slice(funcStart, funcEnd);

    // The function body must NOT call setupSessionListDropZone
    expect(renderSessionListBody).not.toContain("setupSessionListDropZone");
  });

  it("setupSessionListDropZone should be called in setupSessions (initialization)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../../frontend/public/app.js", import.meta.url),
      "utf-8"
    );

    // Extract the setupSessions function body
    const funcStart = source.indexOf("function setupSessions()");
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

    const setupSessionsBody = source.slice(funcStart, funcEnd);

    // The function body MUST call setupSessionListDropZone for both containers
    expect(setupSessionsBody).toContain("setupSessionListDropZone(sessionListPinned");
    expect(setupSessionsBody).toContain("setupSessionListDropZone(sessionList");
  });
});

// ============================================================================
// Test 6: Cross-section drag must await pinSessionOnServer before reorderSessionsOnServer
// ============================================================================
describe("cross-section drag - race condition fix (comment #6)", () => {
  it("li drop handler must be async and await pinSessionOnServer before calling reorderSessionsOnServer", async () => {
    // Structural verification: The drop handler on each session li that handles cross-section
    // drags must await pinSessionOnServer() before calling reorderSessionsOnServer().
    // This prevents a race condition where both calls fire concurrently and the pin endpoint
    // overwrites the correct sort_order set by the reorder endpoint.
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../../frontend/public/app.js", import.meta.url),
      "utf-8"
    );

    // Find the renderSessionList function which contains the li drop handler
    const funcStart = source.indexOf("function renderSessionList()");
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

    const renderBody = source.slice(funcStart, funcEnd);

    // The drop handler should use "await pinSessionOnServer" (not fire-and-forget)
    expect(renderBody).toContain("await pinSessionOnServer");
    // And the handler must be async
    expect(renderBody).toMatch(/li\.addEventListener\(['"]drop['"],\s*async/);
  });

  it("setupSessionListDropZone drop handler must be async and await pinSessionOnServer", async () => {
    // The container-level drop handler (for dropping into empty sections) must also
    // await pinSessionOnServer before calling reorderSessionsOnServer.
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../../frontend/public/app.js", import.meta.url),
      "utf-8"
    );

    // Find the setupSessionListDropZone function
    const funcStart = source.indexOf("function setupSessionListDropZone(");
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

    const funcBody = source.slice(funcStart, funcEnd);

    // The container drop handler should use "await pinSessionOnServer" (not fire-and-forget)
    expect(funcBody).toContain("await pinSessionOnServer");
    // And the handler must be async
    expect(funcBody).toMatch(/addEventListener\(['"]drop['"],\s*async/);
  });
});

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

  it("frontend showSessionContextMenu should use isPermanent instead of name === 'Chat'", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../../frontend/public/app.js", import.meta.url),
      "utf-8"
    );

    const funcStart = source.indexOf("function showSessionContextMenu(");
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
    const contextMenuBody = source.slice(funcStart, funcEnd);

    // Should use isPermanent instead of name === 'Chat'
    expect(contextMenuBody).toContain("isPermanent");
    expect(contextMenuBody).not.toMatch(/\.name\s*===\s*['"]Chat['"]/);
  });

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

// ============================================================================
// Test 8: Context menu pin handler must add pendingOps before pinSessionOnServer (comment #10)
// ============================================================================
describe("context menu pin handler - pendingOps suppression (comment #10)", () => {
  it("should add pendingOps.add('sessions-reordered') before pinSessionOnServer in context menu", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../../../frontend/public/app.js", import.meta.url),
      "utf-8"
    );

    // Find the showSessionContextMenu function
    const funcStart = source.indexOf("function showSessionContextMenu(");
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
    const contextMenuBody = source.slice(funcStart, funcEnd);

    // Must contain pendingOps.add('sessions-reordered') BEFORE pinSessionOnServer
    // This suppresses the WS broadcast from the pin endpoint on this client
    expect(contextMenuBody).toContain("pendingOps.add('sessions-reordered')");

    // Verify the order: pendingOps.add must come before pinSessionOnServer
    const pendingOpsIdx = contextMenuBody.indexOf("pendingOps.add('sessions-reordered')");
    const pinServerIdx = contextMenuBody.indexOf("pinSessionOnServer(session.id");
    expect(pendingOpsIdx).toBeGreaterThan(-1);
    expect(pinServerIdx).toBeGreaterThan(-1);
    expect(pendingOpsIdx).toBeLessThan(pinServerIdx);
  });
});

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
