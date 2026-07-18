import { Router, type Request, type Response } from "express";
import { getAllErrors, getErrorById, markErrorTaskCreated, clearErrors } from "../error-store.js";
import { createTask } from "../db/tasks.js";
import { broadcast } from "../websocket-handler.js";
import { markTaskBroadcast } from "../broadcast-tracker.js";
import { isDbAvailable } from "../db/connection.js";

const router = Router();

// GET /api/errors — list all agent errors (newest first)
router.get("/", (_req: Request, res: Response) => {
  try {
    const errors = getAllErrors();
    res.json(errors);
  } catch (err) {
    console.error("GET /api/errors error:", err);
    res.status(500).json({ error: "Failed to fetch errors" });
  }
});

// POST /api/errors/:id/create-task — create a bug task from an error
router.post("/:id/create-task", async (req: Request, res: Response) => {
  try {
    const errorId = req.params.id as string;
    const agentError = getErrorById(errorId);

    if (!agentError) {
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

    // Allow caller to override boardIds
    const { boardIds } = req.body as { boardIds?: number[] };

    const task = await createTask({
      title: title.substring(0, 200),
      priority: 2, // High priority for agent errors
      type: "bug",
      description,
      origin: "ai",
      boardIds: boardIds,
    });

    // Mark the error as having a task created
    markErrorTaskCreated(errorId, task.id);

    // Broadcast the new task
    broadcast({ type: "task-created", task });
    markTaskBroadcast(task.id);

    res.status(201).json({ task, errorId });
  } catch (err) {
    console.error("POST /api/errors/:id/create-task error:", err);
    res.status(500).json({ error: "Failed to create bug task" });
  }
});

// DELETE /api/errors — clear all errors
router.delete("/", (_req: Request, res: Response) => {
  try {
    clearErrors();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/errors error:", err);
    res.status(500).json({ error: "Failed to clear errors" });
  }
});

export default router;
