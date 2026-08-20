/**
 * Usage API — read-only credit consumption data.
 *
 * GET /api/usage?from=&to=&tabId=  — aggregated usage for a date range
 * GET /api/usage/current-month     — current month total (for the header badge)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getUsage, getCurrentMonthCredits } from "../db/turns.js";

const router = Router();

/**
 * GET /api/usage?from=&to=&tabId=
 * Returns aggregated usage data with daily and session breakdowns.
 */
router.get("/", async (req: Request, res: Response) => {
  const userId = (req as any).userId as number;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { from, to, tabId } = req.query;

  if (!from || !to) {
    res.status(400).json({ error: "Missing required query params: from, to (ISO date strings)" });
    return;
  }

  // Validate date format
  const fromDate = new Date(from as string);
  const toDate = new Date(to as string);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    res.status(400).json({ error: "Invalid date format. Use ISO date strings." });
    return;
  }

  try {
    const usage = await getUsage({
      from: from as string,
      to: to as string,
      tabId: tabId ? Number(tabId) : null,
      userId,
    });
    res.json(usage);
  } catch (err) {
    console.error("Failed to fetch usage:", err);
    res.status(500).json({ error: "Failed to fetch usage data" });
  }
});

/**
 * GET /api/usage/current-month
 * Returns the current month's total credits (for the header badge).
 */
router.get("/current-month", async (req: Request, res: Response) => {
  const userId = (req as any).userId as number;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const totalCredits = await getCurrentMonthCredits(userId);
    res.json({ totalCredits, totalCostEur: totalCredits * 0.04 });
  } catch (err) {
    console.error("Failed to fetch current month credits:", err);
    res.status(500).json({ error: "Failed to fetch current month credits" });
  }
});

export default router;
