/**
 * Tests for the turns DB module (db/turns.ts).
 *
 * Tests the createTurn, completeTurn, getTurnsBySession, getTurnsByUserAndPeriod,
 * createErrorEvent, getErrorsBySession functions against a mocked Neo4j layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB connection module
vi.mock("./connection.js", () => ({
  readQuery: vi.fn(),
  writeQuery: vi.fn(),
}));

import { readQuery, writeQuery } from "./connection.js";
import {
  createTurn,
  completeTurn,
  getTurnsBySession,
  getTurnsByUserAndPeriod,
  getMaxTurnNumber,
  createErrorEvent,
  getErrorsBySession,
} from "./turns.js";
import type { TurnRecord, ErrorEventRecord } from "./turns.js";

describe("db/turns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createTurn", () => {
    it("should create a Turn node linked to a Session", async () => {
      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  const data: Record<string, any> = {
                    number: 1,
                    startedAt: "2026-08-20T06:00:00.000Z",
                    sessionId: 5,
                  };
                  return data[key];
                },
              },
            ],
          }),
        };
        return fn(mockTx);
      });

      const result = await createTurn({
        sessionId: 5,
        number: 1,
        startedAt: "2026-08-20T06:00:00.000Z",
        taskId: 42,
        taskTitle: "Fix the bug",
      });

      expect(result).toBeDefined();
      expect(result.number).toBe(1);
      expect(result.sessionId).toBe(5);
      expect(writeQuery).toHaveBeenCalledOnce();
    });

    it("should handle creation without taskId/taskTitle", async () => {
      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  const data: Record<string, any> = {
                    number: 2,
                    startedAt: "2026-08-20T07:00:00.000Z",
                    sessionId: 3,
                  };
                  return data[key];
                },
              },
            ],
          }),
        };
        return fn(mockTx);
      });

      const result = await createTurn({
        sessionId: 3,
        number: 2,
        startedAt: "2026-08-20T07:00:00.000Z",
      });

      expect(result.number).toBe(2);
      expect(result.sessionId).toBe(3);
    });
  });

  describe("completeTurn", () => {
    it("should update a Turn node with end-of-turn summary", async () => {
      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  const data: Record<string, any> = {
                    number: 1,
                    startedAt: "2026-08-20T06:00:00.000Z",
                    endedAt: "2026-08-20T06:05:00.000Z",
                    credits: 0.12,
                    costEur: 0.0048,
                    verdict: "resolved",
                    durationMs: 300000,
                    toolCallCount: 15,
                    hasChanges: true,
                    prUrl: "https://github.com/org/repo/pull/1",
                    branchName: "feature/#42_fix-bug",
                    sessionId: 5,
                  };
                  return data[key];
                },
              },
            ],
          }),
        };
        return fn(mockTx);
      });

      const result = await completeTurn({
        sessionId: 5,
        number: 1,
        endedAt: "2026-08-20T06:05:00.000Z",
        credits: 0.12,
        costEur: 0.0048,
        verdict: "resolved",
        durationMs: 300000,
        toolCallCount: 15,
        hasChanges: true,
        prUrl: "https://github.com/org/repo/pull/1",
        branchName: "feature/#42_fix-bug",
      });

      expect(result).toBeDefined();
      expect(result!.credits).toBe(0.12);
      expect(result!.costEur).toBe(0.0048);
      expect(result!.verdict).toBe("resolved");
      expect(result!.hasChanges).toBe(true);
      expect(writeQuery).toHaveBeenCalledOnce();
    });
  });

  describe("getTurnsBySession", () => {
    it("should return turns for a session ordered by number", async () => {
      const mockTurns = [
        { number: 1, startedAt: "2026-08-20T06:00:00.000Z", endedAt: "2026-08-20T06:05:00.000Z", credits: 0.1, costEur: 0.004, verdict: "resolved", taskId: 42, taskTitle: "Fix bug", toolCallCount: 10, hasChanges: true, prUrl: null, branchName: "feature/fix", durationMs: 300000 },
        { number: 2, startedAt: "2026-08-20T06:10:00.000Z", endedAt: null, credits: 0, costEur: 0, verdict: null, taskId: null, taskTitle: null, toolCallCount: 0, hasChanges: false, prUrl: null, branchName: null, durationMs: 0 },
      ];

      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: mockTurns.map((t) => ({
              get: (key: string) => (t as any)[key],
            })),
          }),
        };
        return fn(mockTx);
      });

      const result = await getTurnsBySession(5);

      expect(result).toHaveLength(2);
      expect(result[0].number).toBe(1);
      expect(result[0].credits).toBe(0.1);
      expect(result[1].number).toBe(2);
      expect(readQuery).toHaveBeenCalledOnce();
    });

    it("should return empty array when no turns exist", async () => {
      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({ records: [] }),
        };
        return fn(mockTx);
      });

      const result = await getTurnsBySession(999);
      expect(result).toEqual([]);
    });
  });

  describe("getTurnsByUserAndPeriod", () => {
    it("should return aggregated usage data for a user and period", async () => {
      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  const data: Record<string, any> = {
                    sessionId: 1,
                    sessionName: "Dev Agent",
                    date: "2026-08-20",
                    totalCredits: 1.5,
                    totalCostEur: 0.06,
                    turnCount: 10,
                  };
                  return data[key];
                },
              },
            ],
          }),
        };
        return fn(mockTx);
      });

      const result = await getTurnsByUserAndPeriod(
        1,
        "2026-08-01T00:00:00.000Z",
        "2026-08-31T23:59:59.999Z"
      );

      expect(result).toHaveLength(1);
      expect(result[0].totalCredits).toBe(1.5);
      expect(result[0].totalCostEur).toBe(0.06);
      expect(readQuery).toHaveBeenCalledOnce();
    });

    it("should filter by tabId when provided", async () => {
      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({ records: [] }),
        };
        return fn(mockTx);
      });

      await getTurnsByUserAndPeriod(1, "2026-08-01", "2026-08-31", 2);
      expect(readQuery).toHaveBeenCalledOnce();
    });
  });

  describe("getMaxTurnNumber", () => {
    it("should return the max turn number for a session", async () => {
      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  if (key === "maxNumber") return 5;
                  return null;
                },
              },
            ],
          }),
        };
        return fn(mockTx);
      });

      const result = await getMaxTurnNumber(1);
      expect(result).toBe(5);
      expect(readQuery).toHaveBeenCalledOnce();
    });

    it("should return 0 when no turns exist", async () => {
      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  if (key === "maxNumber") return null;
                  return null;
                },
              },
            ],
          }),
        };
        return fn(mockTx);
      });

      const result = await getMaxTurnNumber(999);
      expect(result).toBe(0);
    });
  });

  describe("createErrorEvent", () => {
    it("should create an ErrorEvent node linked to a Session", async () => {
      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  const data: Record<string, any> = {
                    id: "err-123",
                    timestamp: "2026-08-20T06:10:00.000Z",
                    message: "Build failed",
                    taskId: 42,
                    taskTitle: "Fix bug",
                    sessionId: 5,
                  };
                  return data[key];
                },
              },
            ],
          }),
        };
        return fn(mockTx);
      });

      const result = await createErrorEvent({
        sessionId: 5,
        timestamp: "2026-08-20T06:10:00.000Z",
        message: "Build failed",
        taskId: 42,
        taskTitle: "Fix bug",
      });

      expect(result).toBeDefined();
      expect(result.message).toBe("Build failed");
      expect(result.sessionId).toBe(5);
      expect(writeQuery).toHaveBeenCalledOnce();
    });
  });

  describe("getErrorsBySession", () => {
    it("should return errors for a session ordered by timestamp", async () => {
      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  const data: Record<string, any> = {
                    id: "err-1",
                    timestamp: "2026-08-20T06:00:00.000Z",
                    message: "Error 1",
                    taskId: 10,
                    taskTitle: "Task A",
                    sessionId: 5,
                  };
                  return data[key];
                },
              },
            ],
          }),
        };
        return fn(mockTx);
      });

      const result = await getErrorsBySession(5);
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("Error 1");
      expect(readQuery).toHaveBeenCalledOnce();
    });
  });
});
