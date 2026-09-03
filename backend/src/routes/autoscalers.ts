/**
 * REST routes for AutoScaler management — auto-scaling session pools.
 *
 * Follows the same route shape as agents.ts and sessions.ts.
 */

import { Router, type Request, type Response } from "express";
import { requireAuth, getUserId } from "../middleware/auth.js";
import { createAutoScalerRecord, getAllAutoScalers, startAutoScaler, stopAutoScaler, deleteAutoScalerRecord, getAutoScalerSessionCounts } from "../autoscaler-manager.js";
import { getAutoScalerById } from "../db/autoscalers.js";
import { log, toErrorFields } from "../logger.js";

const router = Router();

// All autoScaler routes require authentication.
router.use(requireAuth);

// GET /api/autoscalers — list all autoScalers for the authenticated user.
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const autoScalerList = await getAllAutoScalers(userId);
    const counts = getAutoScalerSessionCounts();
    const result = autoScalerList.map((f) => ({
      ...f,
      runningSessionCount: counts.get(f.id) ?? 0,
    }));
    res.json(result);
  } catch (err) {
    log.error("route-error", {
      component: "autoscalers",
      method: "GET",
      path: "/api/autoscalers",
      ...toErrorFields(err),
      msg: "Failed to list autoScalers",
    });
    res.status(500).json({ error: "Failed to list autoScalers" });
  }
});

// POST /api/autoscalers — create a new autoScaler (does not auto-start).
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { name, agentName, tabIds, model, maxConcurrency, idleTimeoutSeconds } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!agentName || typeof agentName !== "string") {
      res.status(400).json({ error: "agentName is required" });
      return;
    }
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      res.status(400).json({ error: "tabIds is required and must be a non-empty array" });
      return;
    }

    const autoScaler = await createAutoScalerRecord({
      name,
      userId,
      agentName,
      tabIds,
      model: model || undefined,
      maxConcurrency: typeof maxConcurrency === "number" ? maxConcurrency : undefined,
      idleTimeoutSeconds: typeof idleTimeoutSeconds === "number" ? idleTimeoutSeconds : undefined,
    });

    res.status(201).json(autoScaler);
  } catch (err) {
    log.error("route-error", {
      component: "autoscalers",
      method: "POST",
      path: "/api/autoscalers",
      ...toErrorFields(err),
      msg: "Failed to create autoScaler",
    });
    res.status(500).json({ error: "Failed to create autoScaler" });
  }
});

// POST /api/autoscalers/:id/start — start a autoScaler.
router.post("/:id/start", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid autoScaler id" });
      return;
    }

    // Verify ownership.
    const existing = await getAutoScalerById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "AutoScaler not found" });
      return;
    }

    const autoScaler = await startAutoScaler(id);
    if (!autoScaler) {
      res.status(404).json({ error: "AutoScaler not found" });
      return;
    }
    res.json(autoScaler);
  } catch (err) {
    log.error("route-error", {
      component: "autoscalers",
      method: "POST",
      path: "/api/autoscalers/:id/start",
      ...toErrorFields(err),
      msg: "Failed to start autoScaler",
    });
    res.status(500).json({ error: "Failed to start autoScaler" });
  }
});

// POST /api/autoscalers/:id/stop — stop a autoScaler.
router.post("/:id/stop", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid autoScaler id" });
      return;
    }

    const existing = await getAutoScalerById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "AutoScaler not found" });
      return;
    }

    const autoScaler = await stopAutoScaler(id);
    if (!autoScaler) {
      res.status(404).json({ error: "AutoScaler not found" });
      return;
    }
    res.json(autoScaler);
  } catch (err) {
    log.error("route-error", {
      component: "autoscalers",
      method: "POST",
      path: "/api/autoscalers/:id/stop",
      ...toErrorFields(err),
      msg: "Failed to stop autoScaler",
    });
    res.status(500).json({ error: "Failed to stop autoScaler" });
  }
});

// DELETE /api/autoscalers/:id — delete a autoScaler.
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid autoScaler id" });
      return;
    }

    const existing = await getAutoScalerById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "AutoScaler not found" });
      return;
    }

    const deleted = await deleteAutoScalerRecord(id);
    if (!deleted) {
      res.status(404).json({ error: "AutoScaler not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "autoscalers",
      method: "DELETE",
      path: "/api/autoscalers/:id",
      ...toErrorFields(err),
      msg: "Failed to delete autoScaler",
    });
    res.status(500).json({ error: "Failed to delete autoScaler" });
  }
});

export default router;
