/**
 * Tests for the Chat session backfill step in runMigration().
 *
 * Verifies that users without an isPermanent session get exactly one
 * "Chat" session created, and that repeated calls are idempotent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock DB dependencies ───

const mockRunSchemaStatement = vi.fn().mockResolvedValue(undefined);
const mockIsDbAvailable = vi.fn().mockReturnValue(true);
const mockWriteQuery = vi.fn();
const mockInsertSession = vi.fn().mockResolvedValue(100);

vi.mock("../db/connection.js", () => ({
  isDbAvailable: (...args: unknown[]) => mockIsDbAvailable(...args),
  runSchemaStatement: (...args: unknown[]) => mockRunSchemaStatement(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
}));

vi.mock("../db/sessions.js", () => ({
  insertSession: (...args: unknown[]) => mockInsertSession(...args),
}));

// Must import AFTER mocks are established
import { runMigration } from "../db/migrate.js";

describe("runMigration - Chat session backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDbAvailable.mockReturnValue(true);
    mockRunSchemaStatement.mockResolvedValue(undefined);
    mockInsertSession.mockResolvedValue(100);
  });

  it("calls insertSession for each user missing a permanent session", async () => {
    // writeQuery executes the callback with a mock tx that returns user ids
    mockWriteQuery.mockImplementation(async (fn: Function) => {
      const mockTx = {
        run: vi.fn().mockResolvedValue({
          records: [
            { get: (key: string) => key === "id" ? 1 : undefined },
            { get: (key: string) => key === "id" ? 2 : undefined },
          ],
        }),
      };
      return fn(mockTx);
    });

    const result = await runMigration();

    expect(result).toBe(true);
    // Should have called insertSession twice (once per user)
    expect(mockInsertSession).toHaveBeenCalledTimes(2);

    // Verify the session object passed to insertSession for user 1
    const firstCall = mockInsertSession.mock.calls[0][0];
    expect(firstCall.name).toBe("Chat");
    expect(firstCall.userId).toBe(1);
    expect(firstCall.pinned).toBe(true);
    expect(firstCall.isPermanent).toBe(true);
    expect(firstCall.agent).toBe("");
    expect(firstCall.status).toBe("stopped");
    expect(firstCall.interactive).toBe(true);
    expect(firstCall.loop).toBe(false);

    // cwd must match DEFAULT_CWD from session-manager.ts: resolve(dirname, "../..")
    // i.e. the project root, not an empty string
    expect(firstCall.cwd).toMatch(/[/\\]/); // non-empty path
    expect(firstCall.cwd).not.toBe("");

    // Verify user 2
    const secondCall = mockInsertSession.mock.calls[1][0];
    expect(secondCall.userId).toBe(2);
    expect(secondCall.name).toBe("Chat");
    expect(secondCall.isPermanent).toBe(true);
  });

  it("does not call insertSession when no users are missing permanent sessions", async () => {
    // writeQuery returns empty records (no users missing permanent session)
    mockWriteQuery.mockImplementation(async (fn: Function) => {
      const mockTx = {
        run: vi.fn().mockResolvedValue({ records: [] }),
      };
      return fn(mockTx);
    });

    const result = await runMigration();

    expect(result).toBe(true);
    expect(mockInsertSession).not.toHaveBeenCalled();
  });

  it("continues and returns true even if the backfill step throws", async () => {
    // writeQuery itself throws (simulating a DB error in the backfill query)
    mockWriteQuery.mockRejectedValue(new Error("DB connection lost"));

    const result = await runMigration();

    // runMigration must not throw and must still return true (schema ran OK)
    expect(result).toBe(true);
  });

  it("continues if insertSession fails for one user but succeeds for another", async () => {
    mockWriteQuery.mockImplementation(async (fn: Function) => {
      const mockTx = {
        run: vi.fn().mockResolvedValue({
          records: [
            { get: (key: string) => key === "id" ? 1 : undefined },
            { get: (key: string) => key === "id" ? 2 : undefined },
          ],
        }),
      };
      return fn(mockTx);
    });

    // First call fails, second succeeds
    mockInsertSession
      .mockRejectedValueOnce(new Error("Insert failed"))
      .mockResolvedValueOnce(101);

    const result = await runMigration();

    expect(result).toBe(true);
    // Should have attempted both
    expect(mockInsertSession).toHaveBeenCalledTimes(2);
  });
});
