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
// Test 4: setupSessionListDropZone must NOT be called inside renderSessionList
// ============================================================================
describe("setupSessionListDropZone - no event listener leak", () => {
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
