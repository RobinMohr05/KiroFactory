import { Router, type Request, type Response } from "express";
import { getErrorsByUserId, getErrorById, markErrorTaskCreated, dismissError, clearErrorsByUserId } from "../error-store.js";
import { getDiagnosticBuffer } from "../wsl-diagnostics-collector.js";
import { createTask } from "../db/tasks.js";
import { getAllTabs } from "../db/tabs.js";
import { broadcastToUser } from "../websocket-handler.js";
import { notifyTaskAvailable } from "../agent/task-claimer.js";
import { isDbAvailable } from "../db/connection.js";
import { requireAuth, getUserId } from "../middleware/auth.js";
import { log, toErrorFields } from "../logger.js";

const router = Router();

// All error routes require authentication
router.use(requireAuth);

// GET /api/errors/wsl-diagnostics — current WSL/Docker diagnostics ring buffer
// (docker events, dmesg, per-container log captures) for the "WSL/Docker Logs"
// sub-tab's initial load. Live updates after this arrive over the WebSocket
// as 'wsl-diagnostic-line' messages — see wsl-diagnostics-collector.ts.
// Deliberately placed BEFORE the "/:id" routes below so a literal path
// segment "wsl-diagnostics" is never captured by the ":id" param instead.
//
// Not scoped by userId — this is host-machine-level data (see
// broadcastToAll()'s doc comment), not per-account data. Still behind
// requireAuth like every other route in this file: any authenticated user of
// this backend can see it, but no anonymous access.
router.get("/wsl-diagnostics", (_req: Request, res: Response) => {
  try {
    res.json(getDiagnosticBuffer());
  } catch (err) {
    log.error("route-error", {
      component: "errors",
      method: "GET",
      path: "/api/errors/wsl-diagnostics",
      ...toErrorFields(err),
      msg: "Failed to fetch WSL diagnostics buffer",
    });
    res.status(500).json({ error: "Failed to fetch WSL diagnostics" });
  }
});

// GET /api/errors — list agent errors for the authenticated user (newest first)
router.get("/", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const errors = getErrorsByUserId(userId);
    res.json(errors);
  } catch (err) {
    log.error("route-error", {
      component: "errors",
      method: "GET",
      path: "/api/errors",
      ...toErrorFields(err),
      msg: "Failed to fetch errors",
    });
    res.status(500).json({ error: "Failed to fetch errors" });
  }
});

// POST /api/errors/:id/create-task — create a bug task from an error
router.post("/:id/create-task", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const errorId = req.params.id as string;
    const agentError = getErrorById(errorId);

    if (!agentError) {
      res.status(404).json({ error: "Error not found" });
      return;
    }

    // Ensure the error belongs to the authenticated user
    if (agentError.userId !== userId) {
      res.status(404).json({ error: "Error not found" });
      return;
    }

    if (agentError.taskCreated) {
      res.status(409).json({ error: "A bug task has already been created for this error" });
      return;
    }

    if (!isDbAvailable()) {
      res.status(503).json({ error: "Database is unavailable" });
      return;
    }

    // Build a descriptive bug task from the error
    const title = `[Agent Error] ${agentError.message.substring(0, 150)}`;
    const description = [
      `## Error Details`,
      ``,
      `**Agent:** ${agentError.agent}`,
      `**Session:** ${agentError.sessionName} (${agentError.sessionId})`,
      `**Time:** ${agentError.timestamp}`,
      agentError.taskTitle ? `**While working on:** ${agentError.taskTitle} (Task #${agentError.taskId})` : "",
      ``,
      `## Context`,
      ``,
      agentError.context,
      ``,
      `## Error Message`,
      ``,
      "```",
      agentError.message,
      "```",
    ]
      .filter(Boolean)
      .join("\n");

    // Allow caller to override tabIds, but verify ownership
    let { tabIds } = req.body as { tabIds?: number[] };

    if (tabIds && tabIds.length > 0) {
      const userTabs = await getAllTabs(userId);
      const userTabIds = new Set(userTabs.map((t) => t.id));
      const unauthorized = tabIds.filter((id) => !userTabIds.has(id));
      if (unauthorized.length > 0) {
        res.status(403).json({ error: "Cannot assign task to tabs you do not own" });
        return;
      }
    } else {
      // Default: assign to all user's tabs if none specified
      const userTabs = await getAllTabs(userId);
      if (userTabs.length > 0) {
        tabIds = [userTabs[0].id];
      }
    }

    const task = await createTask({
      title: title.substring(0, 200),
      priority: 2, // High priority for agent errors
      type: "bug",
      description,
      origin: "ai",
      tabIds,
    });

    // Mark the error as having a task created
    markErrorTaskCreated(errorId, task.id);

    // Broadcast the new task and wake any idle loop sessions
    broadcastToUser(userId, { type: "task-created", task });
    notifyTaskAvailable();

    res.status(201).json({ task, errorId });
  } catch (err) {
    log.error("route-error", {
      component: "errors",
      method: "POST",
      path: "/api/errors/:id/create-task",
      ...toErrorFields(err),
      msg: "Failed to create bug task",
    });
    res.status(500).json({ error: "Failed to create bug task" });
  }
});

// DELETE /api/errors/:id — dismiss a single error
router.delete("/:id", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const errorId = req.params.id as string;
    const error = getErrorById(errorId);

    if (!error) {
      res.status(404).json({ error: "Error not found" });
      return;
    }

    // Ensure the error belongs to the authenticated user
    if (error.userId !== userId) {
      res.status(404).json({ error: "Error not found" });
      return;
    }

    dismissError(errorId);

    // Broadcast dismissal so other open tabs/windows update
    broadcastToUser(userId, { type: "error-dismissed", errorId });

    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "errors",
      method: "DELETE",
      path: "/api/errors/:id",
      ...toErrorFields(err),
      msg: "Failed to dismiss error",
    });
    res.status(500).json({ error: "Failed to dismiss error" });
  }
});

// DELETE /api/errors — clear all errors for the authenticated user
router.delete("/", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    clearErrorsByUserId(userId);

    // Broadcast so other open tabs/windows update
    broadcastToUser(userId, { type: "errors-cleared" });

    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "errors",
      method: "DELETE",
      path: "/api/errors",
      ...toErrorFields(err),
      msg: "Failed to clear errors",
    });
    res.status(500).json({ error: "Failed to clear errors" });
  }
});

export default router;
