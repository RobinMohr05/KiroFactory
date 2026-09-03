/**
 * Tests for the usage API routes (GET /api/usage, GET /api/usage/current-month).
 *
 * Verifies:
 * - Requires from and to query parameters
 * - Returns aggregated usage data with session details (agent, tabName, firstTurn, lastTurn)
 * - Handles tabId filter
 * - Returns proper error for invalid params
 * - Validates ISO date format for from/to
 * - Normalizes date-only values to full ISO datetime strings
 * - Current-month endpoint returns total and EUR cost
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock dependencies
vi.mock("../db/turns.js", () => ({
  getUsage: vi.fn(),
  getCurrentMonthCredits: vi.fn(),
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

import { getUsage, getCurrentMonthCredits } from "../db/turns.js";
import usageRouter from "./usage.js";

// Create a minimal Express app for route testing
function createApp() {
  const app = express();
  app.use("/api/usage", usageRouter);
  return app;
}

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
    (getUsage as any).mockResolvedValue({
      totalCredits: 0,
      totalCostEur: 0,
      dailyBreakdown: [],
      sessionBreakdown: [],
    });

    await request(app).get("/api/usage?from=2026-08-20&to=2026-08-20");

    // Should have been called with normalized datetime strings
    expect(getUsage).toHaveBeenCalledWith({
      userId: 1,
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-20T23:59:59.999Z",
      tabId: null,
    });
  });

  it("passes full datetime strings through unchanged", async () => {
    const app = createApp();
    (getUsage as any).mockResolvedValue({
      totalCredits: 0,
      totalCostEur: 0,
      dailyBreakdown: [],
      sessionBreakdown: [],
    });

    await request(app).get("/api/usage?from=2026-08-20T06:00:00.000Z&to=2026-08-21T18:00:00.000Z");

    expect(getUsage).toHaveBeenCalledWith({
      userId: 1,
      from: "2026-08-20T06:00:00.000Z",
      to: "2026-08-21T18:00:00.000Z",
      tabId: null,
    });
  });

  it("returns 400 for invalid tabId", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage?from=2026-08-20&to=2026-08-21&tabId=abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tabId/i);
  });

  it("passes valid tabId as number", async () => {
    const app = createApp();
    (getUsage as any).mockResolvedValue({
      totalCredits: 0,
      totalCostEur: 0,
      dailyBreakdown: [],
      sessionBreakdown: [],
    });

    await request(app).get("/api/usage?from=2026-08-20&to=2026-08-21&tabId=2");

    expect(getUsage).toHaveBeenCalledWith({
      userId: 1,
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-21T23:59:59.999Z",
      tabId: 2,
    });
  });
});

describe("GET /api/usage — response shape matches frontend expectations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns dailyBreakdown and sessionBreakdown fields", async () => {
    (getUsage as any).mockResolvedValue({
      totalCredits: 1.5,
      totalCostEur: 0.06,
      dailyBreakdown: [{ date: "2026-08-20", credits: 1.5, costEur: 0.06 }],
      sessionBreakdown: [
        {
          sessionId: 1,
          sessionName: "Dev Agent",
          agent: "developer-agent",
          tabName: "VCH",
          credits: 1.5,
          costEur: 0.06,
          turns: 10,
          firstTurn: "2026-08-20T06:00:00.000Z",
          lastTurn: "2026-08-20T18:00:00.000Z",
        },
      ],
    });

    const app = createApp();
    const res = await request(app).get("/api/usage?from=2026-08-20&to=2026-08-21");
    expect(res.status).toBe(200);

    // The frontend (UsagePanel.tsx) expects these exact field names
    expect(res.body).toHaveProperty("dailyBreakdown");
    expect(res.body).toHaveProperty("sessionBreakdown");
    expect(res.body).toHaveProperty("totalCredits");
    expect(res.body).toHaveProperty("totalCostEur");

    // Must NOT have the old field names that cause the frontend to crash
    expect(res.body).not.toHaveProperty("daily");
    expect(res.body).not.toHaveProperty("sessions");
  });

  it("dailyBreakdown items have date, credits, and costEur fields", async () => {
    (getUsage as any).mockResolvedValue({
      totalCredits: 1.5,
      totalCostEur: 0.06,
      dailyBreakdown: [{ date: "2026-08-20", credits: 1.5, costEur: 0.06 }],
      sessionBreakdown: [],
    });

    const app = createApp();
    const res = await request(app).get("/api/usage?from=2026-08-20&to=2026-08-21");
    expect(res.status).toBe(200);

    expect(res.body.dailyBreakdown).toHaveLength(1);
    expect(res.body.dailyBreakdown[0]).toHaveProperty("date", "2026-08-20");
    expect(res.body.dailyBreakdown[0]).toHaveProperty("credits");
    expect(res.body.dailyBreakdown[0]).toHaveProperty("costEur");
  });

  it("sessionBreakdown items include agent, tabName, firstTurn, lastTurn for frontend rendering", async () => {
    (getUsage as any).mockResolvedValue({
      totalCredits: 1.5,
      totalCostEur: 0.06,
      dailyBreakdown: [{ date: "2026-08-20", credits: 1.5, costEur: 0.06 }],
      sessionBreakdown: [
        {
          sessionId: 1,
          sessionName: "Dev Agent",
          agent: "developer-agent",
          tabName: "VCH",
          credits: 1.5,
          costEur: 0.06,
          turns: 10,
          firstTurn: "2026-08-20T06:00:00.000Z",
          lastTurn: "2026-08-20T18:00:00.000Z",
        },
      ],
    });

    const app = createApp();
    const res = await request(app).get("/api/usage?from=2026-08-20&to=2026-08-21");
    expect(res.status).toBe(200);

    expect(res.body.sessionBreakdown).toHaveLength(1);
    const session = res.body.sessionBreakdown[0];
    expect(session).toHaveProperty("sessionId", 1);
    expect(session).toHaveProperty("sessionName", "Dev Agent");
    expect(session).toHaveProperty("agent", "developer-agent");
    expect(session).toHaveProperty("tabName", "VCH");
    expect(session).toHaveProperty("credits");
    expect(session).toHaveProperty("costEur");
    expect(session).toHaveProperty("turns");
    expect(session).toHaveProperty("firstTurn", "2026-08-20T06:00:00.000Z");
    expect(session).toHaveProperty("lastTurn", "2026-08-20T18:00:00.000Z");
  });

  it("returns totalTurns as sum of all session turns", async () => {
    (getUsage as any).mockResolvedValue({
      totalCredits: 2.5,
      totalCostEur: 0.10,
      dailyBreakdown: [],
      sessionBreakdown: [
        { sessionId: 1, sessionName: "A", agent: "dev", tabName: null, credits: 1.5, costEur: 0.06, turns: 10, firstTurn: "2026-08-20T06:00:00.000Z", lastTurn: "2026-08-20T18:00:00.000Z" },
        { sessionId: 2, sessionName: "B", agent: "review", tabName: null, credits: 1.0, costEur: 0.04, turns: 8, firstTurn: "2026-08-20T06:00:00.000Z", lastTurn: "2026-08-20T18:00:00.000Z" },
      ],
    });

    const app = createApp();
    const res = await request(app).get("/api/usage?from=2026-08-20&to=2026-08-21");
    expect(res.status).toBe(200);
    expect(res.body.totalTurns).toBe(18);
  });
});

describe("GET /api/usage/monthly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every per-month getUsage call resolves with an empty summary by default.
    (getUsage as any).mockResolvedValue({
      totalCredits: 0,
      totalCostEur: 0,
      dailyBreakdown: [],
      sessionBreakdown: [],
    });
  });

  it("returns exactly 12 month entries", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage/monthly");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("months");
    expect(Array.isArray(res.body.months)).toBe(true);
    expect(res.body.months).toHaveLength(12);
    // One getUsage call per month.
    expect(getUsage).toHaveBeenCalledTimes(12);
  });

  it("orders months oldest -> newest", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage/monthly");
    expect(res.status).toBe(200);

    const months = res.body.months as Array<{ year: number; month: number; from: string }>;
    for (let i = 1; i < months.length; i++) {
      const prev = months[i - 1];
      const curr = months[i];
      const prevKey = prev.year * 12 + prev.month;
      const currKey = curr.year * 12 + curr.month;
      expect(currKey).toBeGreaterThan(prevKey);
      expect(new Date(curr.from).getTime()).toBeGreaterThan(new Date(prev.from).getTime());
    }
  });

  it("each entry has the documented fields", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage/monthly");
    expect(res.status).toBe(200);

    for (const entry of res.body.months) {
      expect(entry).toHaveProperty("year");
      expect(typeof entry.year).toBe("number");
      expect(entry).toHaveProperty("month");
      expect(entry.month).toBeGreaterThanOrEqual(1);
      expect(entry.month).toBeLessThanOrEqual(12);
      expect(entry).toHaveProperty("monthLabel");
      expect(typeof entry.monthLabel).toBe("string");
      expect(entry).toHaveProperty("from");
      expect(entry.from).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
      expect(entry).toHaveProperty("to");
      expect(entry.to).toMatch(/^\d{4}-\d{2}-\d{2}T23:59:59\.999Z$/);
      expect(entry).toHaveProperty("totalCredits");
      expect(entry).toHaveProperty("totalCostEur");
      expect(entry).toHaveProperty("totalTurns");
      expect(entry).toHaveProperty("dailyBreakdown");
      expect(Array.isArray(entry.dailyBreakdown)).toBe(true);
      expect(entry).toHaveProperty("sessionBreakdown");
      expect(Array.isArray(entry.sessionBreakdown)).toBe(true);
    }
  });

  it("computes totalTurns from the session breakdown per month", async () => {
    (getUsage as any).mockResolvedValue({
      totalCredits: 3.0,
      totalCostEur: 0.12,
      dailyBreakdown: [],
      sessionBreakdown: [
        { sessionId: 1, sessionName: "A", agent: "dev", tabId: 2, tabName: "VCH", credits: 2, costEur: 0.08, turns: 5, firstTurn: "x", lastTurn: "y" },
        { sessionId: 2, sessionName: "B", agent: "rev", tabId: null, tabName: null, credits: 1, costEur: 0.04, turns: 3, firstTurn: "x", lastTurn: "y" },
      ],
    });

    const app = createApp();
    const res = await request(app).get("/api/usage/monthly");
    expect(res.status).toBe(200);
    for (const entry of res.body.months) {
      expect(entry.totalTurns).toBe(8);
      expect(entry.totalCredits).toBe(3.0);
      expect(entry.totalCostEur).toBe(0.12);
    }
  });

  it("sessionBreakdown entries include tabId", async () => {
    (getUsage as any).mockResolvedValue({
      totalCredits: 1.5,
      totalCostEur: 0.06,
      dailyBreakdown: [],
      sessionBreakdown: [
        {
          sessionId: 1,
          sessionName: "Dev Agent",
          agent: "developer-agent",
          tabId: 2,
          tabName: "VCH",
          credits: 1.5,
          costEur: 0.06,
          turns: 10,
          firstTurn: "2026-08-20T06:00:00.000Z",
          lastTurn: "2026-08-20T18:00:00.000Z",
        },
      ],
    });

    const app = createApp();
    const res = await request(app).get("/api/usage/monthly");
    expect(res.status).toBe(200);

    const nonEmpty = res.body.months.find((m: any) => m.sessionBreakdown.length > 0);
    expect(nonEmpty).toBeTruthy();
    const session = nonEmpty.sessionBreakdown[0];
    expect(session).toHaveProperty("tabId", 2);
    expect(session).toHaveProperty("tabName", "VCH");
  });

  it("always requests all-tabs data (tabId null) even if tabId query param is provided", async () => {
    const app = createApp();
    await request(app).get("/api/usage/monthly?tabId=2");
    for (const call of (getUsage as any).mock.calls) {
      expect(call[0].tabId).toBeNull();
    }
  });

  it("clamps months param to a max of 12", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage/monthly?months=48");
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(12);
    expect(getUsage).toHaveBeenCalledTimes(12);
  });

  it("returns fewer months when a smaller months param is given", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage/monthly?months=3");
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(3);
    expect(getUsage).toHaveBeenCalledTimes(3);
  });

  it("returns 500 on DB error", async () => {
    (getUsage as any).mockRejectedValue(new Error("DB down"));
    const app = createApp();
    const res = await request(app).get("/api/usage/monthly");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to fetch monthly usage/i);
  });
});

describe("GET /api/usage/current-month", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns current month total credits and EUR cost", async () => {
    (getCurrentMonthCredits as any).mockResolvedValue(25.5);

    const app = createApp();
    const res = await request(app).get("/api/usage/current-month");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalCredits: 25.5,
      totalCostEur: 25.5 * 0.04,
    });
  });

  it("returns zero when no usage this month", async () => {
    (getCurrentMonthCredits as any).mockResolvedValue(0);

    const app = createApp();
    const res = await request(app).get("/api/usage/current-month");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalCredits: 0,
      totalCostEur: 0,
    });
  });

  it("returns 500 on DB error", async () => {
    (getCurrentMonthCredits as any).mockRejectedValue(new Error("DB down"));

    const app = createApp();
    const res = await request(app).get("/api/usage/current-month");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to fetch current month credits/);
  });
});
