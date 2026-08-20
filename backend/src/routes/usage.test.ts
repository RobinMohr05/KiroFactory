/**
 * Tests for GET /api/usage and GET /api/usage/current-month.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer
vi.mock("../db/turns.js", () => ({
  getUsage: vi.fn(),
  getCurrentMonthCredits: vi.fn(),
}));

vi.mock("../db/connection.js", () => ({
  isDbAvailable: vi.fn().mockReturnValue(true),
}));

import { getUsage, getCurrentMonthCredits } from "../db/turns.js";
import usageRouter from "./usage.js";
import express from "express";
import request from "supertest";

function createApp() {
  const app = express();
  app.use(express.json());
  // Simulate auth middleware attaching userId
  app.use((req, _res, next) => {
    (req as any).userId = 1;
    next();
  });
  app.use("/api/usage", usageRouter);
  return app;
}

describe("GET /api/usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when from/to query params are missing", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required query params/);
  });

  it("returns 400 when dates are invalid", async () => {
    const app = createApp();
    const res = await request(app).get("/api/usage?from=not-a-date&to=also-not");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid date format/);
  });

  it("returns usage data for valid date range", async () => {
    const mockUsage = {
      totalCredits: 10.5,
      totalCostEur: 0.42,
      dailyBreakdown: [
        { date: "2026-08-01", credits: 5.0, costEur: 0.20 },
        { date: "2026-08-02", credits: 5.5, costEur: 0.22 },
      ],
      sessionBreakdown: [
        {
          sessionId: 1,
          sessionName: "Dev Session",
          agent: "developer-agent",
          tabName: null,
          credits: 10.5,
          costEur: 0.42,
          turns: 3,
          firstTurn: "2026-08-01T10:00:00.000Z",
          lastTurn: "2026-08-02T15:00:00.000Z",
        },
      ],
    };
    vi.mocked(getUsage).mockResolvedValue(mockUsage);

    const app = createApp();
    const res = await request(app).get(
      "/api/usage?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z"
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockUsage);
    expect(getUsage).toHaveBeenCalledWith({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T23:59:59.999Z",
      tabId: null,
      userId: 1,
    });
  });

  it("passes tabId filter when provided", async () => {
    vi.mocked(getUsage).mockResolvedValue({
      totalCredits: 0,
      totalCostEur: 0,
      dailyBreakdown: [],
      sessionBreakdown: [],
    });

    const app = createApp();
    const res = await request(app).get(
      "/api/usage?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z&tabId=2"
    );
    expect(res.status).toBe(200);
    expect(getUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 2 })
    );
  });

  it("returns 500 when getUsage throws", async () => {
    vi.mocked(getUsage).mockRejectedValue(new Error("DB error"));

    const app = createApp();
    const res = await request(app).get(
      "/api/usage?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z"
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to fetch usage data/);
  });
});

describe("GET /api/usage/current-month", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns current month total credits and EUR cost", async () => {
    vi.mocked(getCurrentMonthCredits).mockResolvedValue(25.5);

    const app = createApp();
    const res = await request(app).get("/api/usage/current-month");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalCredits: 25.5,
      totalCostEur: 25.5 * 0.04,
    });
  });

  it("returns zero when no usage this month", async () => {
    vi.mocked(getCurrentMonthCredits).mockResolvedValue(0);

    const app = createApp();
    const res = await request(app).get("/api/usage/current-month");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalCredits: 0,
      totalCostEur: 0,
    });
  });

  it("returns 500 on DB error", async () => {
    vi.mocked(getCurrentMonthCredits).mockRejectedValue(new Error("DB down"));

    const app = createApp();
    const res = await request(app).get("/api/usage/current-month");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to fetch current month credits/);
  });

  it("returns 401 when userId is not set", async () => {
    const app = express();
    app.use(express.json());
    // No auth middleware — userId not set
    app.use("/api/usage", usageRouter);

    const res = await request(app).get("/api/usage/current-month");
    expect(res.status).toBe(401);
  });
});
