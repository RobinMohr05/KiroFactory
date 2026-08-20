/**
 * Usage API routes — provides aggregated credit/cost data for the dashboard.
 *
 * GET /api/usage?from=&to=&tabId= — returns aggregated usage
 *   (total credits/EUR, daily breakdown, per-session breakdown)
 *   for the authenticated user within a date range, optionally filtered by tab.
 * GET /api/usage/current-month — current month total (for the header badge)
 */

import { Router, type Request, type Response } from "express";
import { requireAuth, getUserId } from "../middleware/auth.js";
import { getTurnsByUserAndPeriod, getCurrentMonthCredits } from "../db/turns.js";
import { log, toErrorFields } from "../logger.js";

const router = Router();

router.use(requireAuth);

// GET /api/usage?from=&to=&tabId= — aggregated usage for the authenticated user
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    if (!from || !to) {
      res.status(400).json({ error: "from and to query parameters are required (ISO date strings)" });
      return;
    }

    // Validate ISO date format (YYYY-MM-DD with optional time component)
    const isoDateish = /^\d{4}-\d{2}-\d{2}/;
    if (!isoDateish.test(from) || !isoDateish.test(to)) {
      res.status(400).json({ error: "from and to must be ISO date strings (YYYY-MM-DD...)" });
      return;
    }

    // Normalize date-only values to full ISO datetime strings so that the
    // Cypher string comparison (t.startedAt >= $from AND t.startedAt <= $to)
    // correctly includes all turns on the boundary dates.
    const normalizedFrom = from.length === 10 ? `${from}T00:00:00.000Z` : from;
    const normalizedTo = to.length === 10 ? `${to}T23:59:59.999Z` : to;

    const tabId = req.query.tabId ? Number(req.query.tabId) : undefined;
    if (req.query.tabId && (!Number.isInteger(tabId) || tabId! < 1)) {
      res.status(400).json({ error: "tabId must be a positive integer" });
      return;
    }

    const breakdown = await getTurnsByUserAndPeriod(userId, normalizedFrom, normalizedTo, tabId);

    // Compute aggregates from the breakdown
    let totalCredits = 0;
    let totalCostEur = 0;
    let totalTurns = 0;
    const dailyMap = new Map<string, { credits: number; costEur: number; turnCount: number }>();
    const sessionMap = new Map<number, { sessionId: number; sessionName: string; credits: number; costEur: number; turnCount: number }>();

    for (const entry of breakdown) {
      totalCredits += entry.totalCredits;
      totalCostEur += entry.totalCostEur;
      totalTurns += entry.turnCount;

      // Daily aggregation
      const existing = dailyMap.get(entry.date);
      if (existing) {
        existing.credits += entry.totalCredits;
        existing.costEur += entry.totalCostEur;
        existing.turnCount += entry.turnCount;
      } else {
        dailyMap.set(entry.date, {
          credits: entry.totalCredits,
          costEur: entry.totalCostEur,
          turnCount: entry.turnCount,
        });
      }

      // Per-session aggregation
      const sessionEntry = sessionMap.get(entry.sessionId);
      if (sessionEntry) {
        sessionEntry.credits += entry.totalCredits;
        sessionEntry.costEur += entry.totalCostEur;
        sessionEntry.turnCount += entry.turnCount;
      } else {
        sessionMap.set(entry.sessionId, {
          sessionId: entry.sessionId,
          sessionName: entry.sessionName,
          credits: entry.totalCredits,
          costEur: entry.totalCostEur,
          turnCount: entry.turnCount,
        });
      }
    }

    const daily = Array.from(dailyMap.entries()).map(([date, data]) => ({
      date,
      ...data,
    }));

    const sessions = Array.from(sessionMap.values());

    res.json({
      totalCredits,
      totalCostEur,
      totalTurns,
      daily,
      sessions,
    });
  } catch (err) {
    log.error("route-error", {
      component: "usage",
      method: "GET",
      path: "/api/usage",
      ...toErrorFields(err),
      msg: "Failed to fetch usage data",
    });
    res.status(500).json({ error: "Failed to fetch usage data" });
  }
});

/**
 * GET /api/usage/current-month
 * Returns the current month's total credits (for the header badge).
 */
router.get("/current-month", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const totalCredits = await getCurrentMonthCredits(userId);
    res.json({ totalCredits, totalCostEur: totalCredits * 0.04 });
  } catch (err) {
    log.error("route-error", {
      component: "usage",
      method: "GET",
      path: "/api/usage/current-month",
      ...toErrorFields(err),
      msg: "Failed to fetch current month credits",
    });
    res.status(500).json({ error: "Failed to fetch current month credits" });
  }
});

export default router;
