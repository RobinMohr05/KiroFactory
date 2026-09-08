/**
 * REST routes for AutoScaler management — auto-scaling session pools.
 *
 * Follows the same route shape as agents.ts and sessions.ts.
 */

import { Router, type Request, type Response } from "express";
import { requireAuth, getUserId } from "../middleware/auth.js";
import { createAutoScalerRecord, getAllAutoScalers, startAutoScaler, stopAutoScaler, deleteAutoScalerRecord, updateAutoScalerRecord, getAutoScalerSessionCounts } from "../autoscaler-manager.js";
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

// PATCH /api/autoscalers/:id — edit an existing autoScaler's configuration.
router.patch("/:id", async (req: Request, res: Response) => {
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

    if (existing.status === "running") {
      res.status(409).json({ error: "Cannot edit a running auto-scaler. Stop it first." });
      return;
    }

    const { name, agentName, tabIds, model, maxConcurrency, idleTimeoutSeconds } = req.body;

    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    if (agentName !== undefined && (typeof agentName !== "string" || agentName.trim() === "")) {
      res.status(400).json({ error: "agentName must be a non-empty string" });
      return;
    }
    if (tabIds !== undefined && (!Array.isArray(tabIds) || tabIds.length === 0)) {
      res.status(400).json({ error: "tabIds must be a non-empty array" });
      return;
    }
    if (maxConcurrency !== undefined && typeof maxConcurrency !== "number") {
      res.status(400).json({ error: "maxConcurrency must be a number" });
      return;
    }
    if (idleTimeoutSeconds !== undefined && typeof idleTimeoutSeconds !== "number") {
      res.status(400).json({ error: "idleTimeoutSeconds must be a number" });
      return;
    }
    if (model !== undefined && model !== null && typeof model !== "string") {
      res.status(400).json({ error: "model must be a string or null" });
      return;
    }

    const fields: Partial<{
      name: string;
      agentName: string;
      tabIds: number[];
      model: string | null;
      maxConcurrency: number;
      idleTimeoutSeconds: number;
    }> = {};
    if (name !== undefined) fields.name = name;
    if (agentName !== undefined) fields.agentName = agentName;
    if (tabIds !== undefined) fields.tabIds = tabIds;
    if (model !== undefined) fields.model = model;
    if (maxConcurrency !== undefined) fields.maxConcurrency = maxConcurrency;
    if (idleTimeoutSeconds !== undefined) fields.idleTimeoutSeconds = idleTimeoutSeconds;

    if (Object.keys(fields).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const updated = await updateAutoScalerRecord(id, fields);
    if (!updated) {
      res.status(404).json({ error: "AutoScaler not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    log.error("route-error", {
      component: "autoscalers",
      method: "PATCH",
      path: "/api/autoscalers/:id",
      ...toErrorFields(err),
      msg: "Failed to update autoScaler",
    });
    res.status(500).json({ error: "Failed to update autoScaler" });
  }
});

export default router;
