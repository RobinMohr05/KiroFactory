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
import { getUsage, getCurrentMonthCredits, type UsageSummary } from "../db/turns.js";
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

    const usageSummary = await getUsage({
      userId,
      from: normalizedFrom,
      to: normalizedTo,
      tabId: tabId ?? null,
    });

    res.json({
      totalCredits: usageSummary.totalCredits,
      totalCostEur: usageSummary.totalCostEur,
      totalTurns: usageSummary.sessionBreakdown.reduce((sum, s) => sum + s.turns, 0),
      dailyBreakdown: usageSummary.dailyBreakdown,
      sessionBreakdown: usageSummary.sessionBreakdown,
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
 * A single calendar month's aggregated usage.
 */
interface MonthUsage {
  year: number;
  month: number; // 1-12
  monthLabel: string; // e.g. "August 2026"
  from: string; // ISO — first day 00:00:00.000Z
  to: string; // ISO — last day 23:59:59.999Z
  totalCredits: number;
  totalCostEur: number;
  totalTurns: number;
  dailyBreakdown: { date: string; credits: number; costEur: number }[];
  sessionBreakdown: UsageSummary["sessionBreakdown"];
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MAX_MONTHS = 12;

/**
 * GET /api/usage/monthly?months=
 * Returns usage aggregated per calendar month for the current month plus the
 * preceding months (12 total by default), ordered oldest -> newest.
 *
 * The `tabId` query param is intentionally NOT applied server-side — this
 * endpoint always returns all-tabs data so the frontend can filter locally.
 * The `months` param defaults to 12 and is clamped to a max of 12.
 */
router.get("/monthly", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);

    let months = req.query.months ? Number(req.query.months) : MAX_MONTHS;
    if (!Number.isInteger(months) || months < 1) {
      months = MAX_MONTHS;
    }
    if (months > MAX_MONTHS) {
      months = MAX_MONTHS;
    }

    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth(); // 0-11

    const result: MonthUsage[] = [];

    // Iterate oldest -> newest. Offset 0 is the current month, so the oldest is
    // (months - 1) months back.
    for (let offset = months - 1; offset >= 0; offset--) {
      // Compute year/month for this offset using a UTC date to avoid TZ drift.
      const anchor = new Date(Date.UTC(currentYear, currentMonth - offset, 1));
      const year = anchor.getUTCFullYear();
      const monthIndex = anchor.getUTCMonth(); // 0-11

      // First day 00:00:00.000Z and last day 23:59:59.999Z of this month.
      const from = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0)).toISOString();
      const to = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999)).toISOString();

      const usage = await getUsage({ userId, from, to, tabId: null });
      const totalTurns = usage.sessionBreakdown.reduce((sum, s) => sum + s.turns, 0);

      result.push({
        year,
        month: monthIndex + 1,
        monthLabel: `${MONTH_NAMES[monthIndex]} ${year}`,
        from,
        to,
        totalCredits: usage.totalCredits,
        totalCostEur: usage.totalCostEur,
        totalTurns,
        dailyBreakdown: usage.dailyBreakdown,
        sessionBreakdown: usage.sessionBreakdown,
      });
    }

    res.json({ months: result });
  } catch (err) {
    log.error("route-error", {
      component: "usage",
      method: "GET",
      path: "/api/usage/monthly",
      ...toErrorFields(err),
      msg: "Failed to fetch monthly usage",
    });
    res.status(500).json({ error: "Failed to fetch monthly usage" });
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
