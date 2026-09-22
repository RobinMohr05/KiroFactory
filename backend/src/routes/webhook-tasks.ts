import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";
import { createTask } from "../db/tasks.js";
import { getTabById } from "../db/tabs.js";
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
 * Parses a tab id value into a positive integer, or null if it isn't one.
 * Accepts numbers and numeric strings (e.g. from an env var or JSON payload).
 */
function parseValidTabId(value: unknown): number | null {
  const num = Number(value);
  if (Number.isInteger(num) && num > 0) {
    return num;
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
    if (!headerSecret || typeof headerSecret !== "string") {
      res.status(401).json({ error: "Invalid or missing webhook secret" });
      return;
    }
    // Compare byte lengths (not string lengths) before calling timingSafeEqual.
    // String.prototype.length counts UTF-16 code units; Buffer.from(str) uses UTF-8,
    // so multibyte characters make the two measures differ. timingSafeEqual throws a
    // RangeError when buffer sizes don't match, so the guard must use byte length.
    const headerBuf = Buffer.from(headerSecret);
    const secretBuf = Buffer.from(webhookSecret);
    if (
      headerBuf.length !== secretBuf.length ||
      !timingSafeEqual(headerBuf, secretBuf)
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

    // A caller can explicitly route the task to a board via a top-level
    // `tabId` (works for both the generic and ADO payload shapes).
    const rawTabId = body.tabId;

    // 4. Validate title
    if (!title || (typeof title === "string" && title.trim() === "")) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    // 5. Default description and priority
    const priority = parseValidPriority(rawPriority) ?? 3;
    const desc = description ?? "";

    // 5b. Resolve the target tab.
    //   - An explicit `tabId` in the payload wins.
    //   - Otherwise fall back to WEBHOOK_DEFAULT_TAB_ID (per-deployment config),
    //     then to tab 2 (the KiroFactory/VCH board) to preserve prior behavior.
    // The resolved id must be a positive integer, and the tab must actually
    // exist — otherwise webhook tasks would silently orphan onto a missing or
    // renumbered tab (the bug this endpoint had). Both failure modes surface a
    // clear 400 to the caller instead.
    let tabId: number;
    if (rawTabId !== undefined && rawTabId !== null && rawTabId !== "") {
      // Explicitly supplied by the caller — validate strictly.
      const parsed = parseValidTabId(rawTabId);
      if (parsed === null) {
        res.status(400).json({ error: "tabId must be a positive integer" });
        return;
      }
      tabId = parsed;
    } else {
      // No explicit tab — resolve the default. If WEBHOOK_DEFAULT_TAB_ID is set
      // but malformed, that's an operator-facing server configuration error
      // (the caller's request is valid), so surface it as 500 — never 400 —
      // mirroring how an unset WEBHOOK_SECRET returns 503 rather than 401.
      const envDefault = process.env.WEBHOOK_DEFAULT_TAB_ID;
      if (envDefault !== undefined && envDefault !== "") {
        const parsed = parseValidTabId(envDefault);
        if (parsed === null) {
          res.status(500).json({
            error:
              "Server misconfiguration: WEBHOOK_DEFAULT_TAB_ID is not a valid positive integer",
          });
          return;
        }
        tabId = parsed;
      } else {
        tabId = 2;
      }
    }

    const tab = await getTabById(tabId);
    if (!tab) {
      res.status(400).json({ error: `Target tab ${tabId} does not exist` });
      return;
    }

    // 6. Build CreateTaskInput
    const input: CreateTaskInput = {
      title,
      description: desc,
      priority,
      type,
      files: [],
      origin: "ai",
      tabIds: [tabId],
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
