/**
 * REST routes for Flock management — auto-scaling session pools.
 *
 * Follows the same route shape as agents.ts and sessions.ts.
 */

import { Router, type Request, type Response } from "express";
import { requireAuth, getUserId } from "../middleware/auth.js";
import { createFlockRecord, getAllFlocks, startFlock, stopFlock, deleteFlockRecord, getFlockSessionCounts } from "../flock-manager.js";
import { getFlockById } from "../db/flocks.js";
import { log, toErrorFields } from "../logger.js";

const router = Router();

// All flock routes require authentication.
router.use(requireAuth);

// GET /api/flocks — list all flocks for the authenticated user.
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const flockList = await getAllFlocks(userId);
    const counts = getFlockSessionCounts();
    const result = flockList.map((f) => ({
      ...f,
      runningSessionCount: counts.get(f.id) ?? 0,
    }));
    res.json(result);
  } catch (err) {
    log.error("route-error", {
      component: "flocks",
      method: "GET",
      path: "/api/flocks",
      ...toErrorFields(err),
      msg: "Failed to list flocks",
    });
    res.status(500).json({ error: "Failed to list flocks" });
  }
});

// POST /api/flocks — create a new flock (does not auto-start).
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

    const flock = await createFlockRecord({
      name,
      userId,
      agentName,
      tabIds,
      model: model || undefined,
      maxConcurrency: typeof maxConcurrency === "number" ? maxConcurrency : undefined,
      idleTimeoutSeconds: typeof idleTimeoutSeconds === "number" ? idleTimeoutSeconds : undefined,
    });

    res.status(201).json(flock);
  } catch (err) {
    log.error("route-error", {
      component: "flocks",
      method: "POST",
      path: "/api/flocks",
      ...toErrorFields(err),
      msg: "Failed to create flock",
    });
    res.status(500).json({ error: "Failed to create flock" });
  }
});

// POST /api/flocks/:id/start — start a flock.
router.post("/:id/start", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid flock id" });
      return;
    }

    // Verify ownership.
    const existing = await getFlockById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "Flock not found" });
      return;
    }

    const flock = await startFlock(id);
    if (!flock) {
      res.status(404).json({ error: "Flock not found" });
      return;
    }
    res.json(flock);
  } catch (err) {
    log.error("route-error", {
      component: "flocks",
      method: "POST",
      path: "/api/flocks/:id/start",
      ...toErrorFields(err),
      msg: "Failed to start flock",
    });
    res.status(500).json({ error: "Failed to start flock" });
  }
});

// POST /api/flocks/:id/stop — stop a flock.
router.post("/:id/stop", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid flock id" });
      return;
    }

    const existing = await getFlockById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "Flock not found" });
      return;
    }

    const flock = await stopFlock(id);
    if (!flock) {
      res.status(404).json({ error: "Flock not found" });
      return;
    }
    res.json(flock);
  } catch (err) {
    log.error("route-error", {
      component: "flocks",
      method: "POST",
      path: "/api/flocks/:id/stop",
      ...toErrorFields(err),
      msg: "Failed to stop flock",
    });
    res.status(500).json({ error: "Failed to stop flock" });
  }
});

// DELETE /api/flocks/:id — delete a flock.
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid flock id" });
      return;
    }

    const existing = await getFlockById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "Flock not found" });
      return;
    }

    const deleted = await deleteFlockRecord(id);
    if (!deleted) {
      res.status(404).json({ error: "Flock not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "flocks",
      method: "DELETE",
      path: "/api/flocks/:id",
      ...toErrorFields(err),
      msg: "Failed to delete flock",
    });
    res.status(500).json({ error: "Failed to delete flock" });
  }
});

export default router;
