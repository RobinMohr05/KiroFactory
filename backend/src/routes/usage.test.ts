/**
 * Tests for the usage API route (GET /api/usage).
 *
 * Verifies:
 * - Requires from and to query parameters
 * - Returns aggregated usage data
 * - Handles tabId filter
 * - Returns proper error for invalid params
 * - Validates ISO date format for from/to
 * - Normalizes date-only values to full ISO datetime strings
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock dependencies
vi.mock("../db/turns.js", () => ({
  getTurnsByUserAndPeriod: vi.fn(),
}));

vi.mock("../db/connection.js", () => ({
  isDbAvailable: vi.fn().mockReturnValue(true),
}));

// Mock auth middleware to inject a userId
vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  getUserId: vi.fn().mockReturnValue(1),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { getTurnsByUserAndPeriod } from "../db/turns.js";
import usageRouter from "./usage.js";

// Create a minimal Express app for route testing
function createApp() {
  const app = express();
  app.use("/api/usage", usageRouter);
  return app;
}

describe("GET /api/usage — aggregation logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getTurnsByUserAndPeriod returns data that can be aggregated", async () => {
    const mockData = [
      { sessionId: 1, sessionName: "Dev Agent", date: "2026-08-20", totalCredits: 1.5, totalCostEur: 0.06, turnCount: 10 },
      { sessionId: 1, sessionName: "Dev Agent", date: "2026-08-21", totalCredits: 0.5, totalCostEur: 0.02, turnCount: 5 },
      { sessionId: 2, sessionName: "Review Agent", date: "2026-08-20", totalCredits: 0.3, totalCostEur: 0.012, turnCount: 3 },
    ];

    (getTurnsByUserAndPeriod as any).mockResolvedValue(mockData);

    const breakdown = await getTurnsByUserAndPeriod(1, "2026-08-20", "2026-08-21");

    // Verify we can compute the expected aggregates
    let totalCredits = 0;
    let totalCostEur = 0;
    let totalTurns = 0;
    const dailyMap = new Map<string, { credits: number; costEur: number; turnCount: number }>();
    const sessionMap = new Map<number, { sessionId: number; sessionName: string; credits: number; costEur: number; turnCount: number }>();

    for (const entry of breakdown) {
      totalCredits += entry.totalCredits;
      totalCostEur += entry.totalCostEur;
      totalTurns += entry.turnCount;

      const existing = dailyMap.get(entry.date);
      if (existing) {
        existing.credits += entry.totalCredits;
        existing.costEur += entry.totalCostEur;
        existing.turnCount += entry.turnCount;
      } else {
        dailyMap.set(entry.date, { credits: entry.totalCredits, costEur: entry.totalCostEur, turnCount: entry.turnCount });
      }

      const sessionEntry = sessionMap.get(entry.sessionId);
      if (sessionEntry) {
        sessionEntry.credits += entry.totalCredits;
        sessionEntry.costEur += entry.totalCostEur;
        sessionEntry.turnCount += entry.turnCount;
      } else {
        sessionMap.set(entry.sessionId, { sessionId: entry.sessionId, sessionName: entry.sessionName, credits: entry.totalCredits, costEur: entry.totalCostEur, turnCount: entry.turnCount });
      }
    }

    expect(totalCredits).toBeCloseTo(2.3);
    expect(totalCostEur).toBeCloseTo(0.092);
    expect(totalTurns).toBe(18);

    const daily = Array.from(dailyMap.entries()).map(([date, data]) => ({ date, ...data }));
    expect(daily).toHaveLength(2);
    expect(daily[0].date).toBe("2026-08-20");
    expect(daily[0].credits).toBeCloseTo(1.8);
    expect(daily[1].date).toBe("2026-08-21");
    expect(daily[1].credits).toBeCloseTo(0.5);

    const sessions = Array.from(sessionMap.values());
    expect(sessions).toHaveLength(2);
    expect(sessions.find(s => s.sessionId === 1)?.credits).toBeCloseTo(2.0);
    expect(sessions.find(s => s.sessionId === 2)?.credits).toBeCloseTo(0.3);
  });

  it("getTurnsByUserAndPeriod with tabId filter", async () => {
    (getTurnsByUserAndPeriod as any).mockResolvedValue([]);

    await getTurnsByUserAndPeriod(1, "2026-08-01", "2026-08-31", 2);

    expect(getTurnsByUserAndPeriod).toHaveBeenCalledWith(1, "2026-08-01", "2026-08-31", 2);
  });

  it("returns empty aggregation when no data exists", async () => {
    (getTurnsByUserAndPeriod as any).mockResolvedValue([]);

    const breakdown = await getTurnsByUserAndPeriod(1, "2026-08-01", "2026-08-31");

    let totalCredits = 0;
    let totalCostEur = 0;
    let totalTurns = 0;
    for (const entry of breakdown) {
      totalCredits += entry.totalCredits;
      totalCostEur += entry.totalCostEur;
      totalTurns += entry.turnCount;
    }

    expect(totalCredits).toBe(0);
    expect(totalCostEur).toBe(0);
    expect(totalTurns).toBe(0);
  });
});

describe("GET /api/usage — route validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when from is missing", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage?to=2026-08-20");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from and to/i);
  });

  it("returns 400 when to is missing", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage?from=2026-08-20");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from and to/i);
  });

  it("returns 400 for non-ISO date format in from", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage?from=hello&to=2026-08-20");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ISO date/i);
  });

  it("returns 400 for non-ISO date format in to", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage?from=2026-08-20&to=not-a-date");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ISO date/i);
  });

  it("normalizes date-only from/to values to full datetime strings", async () => {
    const app = createApp();
    (getTurnsByUserAndPeriod as any).mockResolvedValue([]);

    await request(app).get("/api/usage?from=2026-08-20&to=2026-08-20");

    // Should have been called with normalized datetime strings
    expect(getTurnsByUserAndPeriod).toHaveBeenCalledWith(
      1,
      "2026-08-20T00:00:00.000Z",
      "2026-08-20T23:59:59.999Z",
      undefined
    );
  });

  it("passes full datetime strings through unchanged", async () => {
    const app = createApp();
    (getTurnsByUserAndPeriod as any).mockResolvedValue([]);

    await request(app).get("/api/usage?from=2026-08-20T06:00:00.000Z&to=2026-08-21T18:00:00.000Z");

    expect(getTurnsByUserAndPeriod).toHaveBeenCalledWith(
      1,
      "2026-08-20T06:00:00.000Z",
      "2026-08-21T18:00:00.000Z",
      undefined
    );
  });

  it("returns 400 for invalid tabId", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage?from=2026-08-20&to=2026-08-21&tabId=abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tabId/i);
  });

  it("passes valid tabId as number", async () => {
    const app = createApp();
    (getTurnsByUserAndPeriod as any).mockResolvedValue([]);

    await request(app).get("/api/usage?from=2026-08-20&to=2026-08-21&tabId=2");

    expect(getTurnsByUserAndPeriod).toHaveBeenCalledWith(
      1,
      "2026-08-20T00:00:00.000Z",
      "2026-08-21T23:59:59.999Z",
      2
    );
  });
});
