import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";
import { createTask } from "../db/tasks.js";
import { notifyTaskAvailable } from "../agent/task-claimer.js";
import type { CreateTaskInput } from "../types.js";
import { DependencyCycleError } from "../types.js";
import { log, toErrorFields } from "../logger.js";

const router = Router();

/**
 * Validates that a priority value is a valid 1–4 integer.
 * Returns the number if valid, or null if not.
 */
function parseValidPriority(value: unknown): 1 | 2 | 3 | 4 | null {
  const num = Number(value);
  if (Number.isInteger(num) && num >= 1 && num <= 4) {
    return num as 1 | 2 | 3 | 4;
  }
  return null;
}

/**
 * Maps an Azure DevOps work item type string to a KiroFactory task type.
 */
function mapAdoWorkItemType(workItemType: string | undefined): CreateTaskInput["type"] {
  if (workItemType === "Bug") return "bug";
  if (workItemType === "Product Backlog Item") return "feature";
  return "improvement";
}

// POST /api/webhooks/tasks — create a task from an external webhook call
router.post("/", async (req: Request, res: Response) => {
  try {
    // 1. Check that WEBHOOK_SECRET is configured
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (!webhookSecret) {
      res.status(503).json({ error: "Webhook endpoint not configured" });
      return;
    }

    // 2. Validate the shared secret header (timing-safe to prevent timing attacks)
    const headerSecret = req.headers["x-webhook-secret"];
    if (
      !headerSecret ||
      typeof headerSecret !== "string" ||
      headerSecret.length !== webhookSecret.length ||
      !timingSafeEqual(Buffer.from(headerSecret), Buffer.from(webhookSecret))
    ) {
      res.status(401).json({ error: "Invalid or missing webhook secret" });
      return;
    }

    // 3. Extract fields — auto-detect ADO vs generic shape
    const body = req.body;
    let title: string | undefined;
    let description: string | undefined;
    let rawPriority: unknown;
    let type: CreateTaskInput["type"];

    if (body.resource?.fields) {
      // Azure DevOps service-hook payload
      const fields = body.resource.fields;
      title = fields["System.Title"];
      description = fields["System.Description"];
      rawPriority = fields["Microsoft.VSTS.Common.Priority"];
      type = mapAdoWorkItemType(fields["System.WorkItemType"]);
    } else {
      // Generic flat payload
      title = body.title;
      description = body.description;
      rawPriority = body.priority;
      type = "improvement";
    }

    // 4. Validate title
    if (!title || (typeof title === "string" && title.trim() === "")) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    // 5. Default description and priority
    const priority = parseValidPriority(rawPriority) ?? 3;
    const desc = description ?? "";

    // 6. Build CreateTaskInput
    const input: CreateTaskInput = {
      title,
      description: desc,
      priority,
      type,
      files: [],
      origin: "ai",
      tabIds: [2],
      dependsOn: [],
      groupId: null,
    };

    // 7. Create the task
    const task = await createTask(input);
    notifyTaskAvailable();
    res.status(201).json(task);
  } catch (err) {
    if (err instanceof DependencyCycleError) {
      res.status(409).json({ error: err.message, fromId: err.fromId, toId: err.toId });
      return;
    }
    log.error("route-error", {
      component: "webhook-tasks",
      method: "POST",
      path: "/api/webhooks/tasks",
      ...toErrorFields(err),
      msg: "Failed to create task",
    });
    res.status(500).json({ error: "Failed to create task" });
  }
});

export default router;
