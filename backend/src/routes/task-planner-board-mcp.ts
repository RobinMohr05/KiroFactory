/**
 * Task Planner Board MCP — Exposes MCP tools for reading tasks and writing
 * dependency links scoped to the planner session's own tab.
 *
 * This is NOT a general-purpose task API — it intentionally omits task
 * creation (which stays on the chat button flow) and cross-tab access.
 *
 * Two tools are exposed:
 *   - list_tasks: returns id, title, type, priority, state for every task
 *     in the current session's tab.
 *   - add_task_dependency: validates tab ownership, then writes dependencies
 *     via setTaskDependencies. Surfaces DependencyCycleError and missing-ID
 *     errors as tool-call errors.
 *
 * Auth: userId and tabId are embedded in the URL at session-start time
 * (not supplied by the LLM). The route validates that the tab belongs to
 * the user before processing any request.
 */

import { Router, type Request, type Response } from "express";
import { getAllTasks, setTaskDependencies } from "../db/tasks.js";
import { DependencyCycleError } from "../types.js";
import { requireAuth, getUserId } from "../middleware/auth.js";
import { log, toErrorFields } from "../logger.js";

import type { HttpMcpServerEntry } from "./task-planner-mcp.js";

// ---------------------------------------------------------------------------
// Public API — used by task-planner.ts to build the MCP entry at session start
// ---------------------------------------------------------------------------

/**
 * Build an HTTP MCP server entry pointing at this route, with userId and
 * tabId baked into the URL so the LLM never needs to supply them.
 */
export function buildPlannerBoardMcpServer(opts: {
  userId: number;
  tabId: number;
  baseUrl: string;
}): HttpMcpServerEntry {
  const params = new URLSearchParams({
    userId: String(opts.userId),
    tabId: String(opts.tabId),
  });
  return {
    type: "http",
    name: "task-board",
    url: `${opts.baseUrl}/api/task-planner-board-mcp/mcp?${params.toString()}`,
    headers: [],
  };
}

// ---------------------------------------------------------------------------
// Tool handlers — exported for unit testing
// ---------------------------------------------------------------------------

export async function handleListTasks(opts: {
  tabId: number;
  userId: number;
}): Promise<Array<{ id: number; title: string; type: string; priority: number; state: string }>> {
  const tasks = await getAllTasks({ tabId: opts.tabId, userId: opts.userId });
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    type: t.type,
    priority: t.priority,
    state: t.state,
  }));
}

export async function handleAddTaskDependency(opts: {
  tabId: number;
  userId: number;
  taskId: number;
  dependsOnTaskId: number[];
}): Promise<void> {
  // Verify all referenced task IDs belong to this tab
  const tabTasks = await getAllTasks({ tabId: opts.tabId, userId: opts.userId });
  const tabTaskIds = new Set(tabTasks.map((t) => t.id));

  if (!tabTaskIds.has(opts.taskId)) {
    throw new Error(`Task ${opts.taskId} not found in tab ${opts.tabId}`);
  }

  for (const depId of opts.dependsOnTaskId) {
    if (!tabTaskIds.has(depId)) {
      throw new Error(`Dependency task ${depId} not found in tab ${opts.tabId}`);
    }
  }

  // Merge existing dependencies with the new ones
  const existingTask = tabTasks.find((t) => t.id === opts.taskId);
  const existingDeps = existingTask?.dependsOn ?? [];
  const mergedDeps = Array.from(new Set([...existingDeps, ...opts.dependsOnTaskId]));

  await setTaskDependencies(opts.taskId, mergedDeps);
}

// ---------------------------------------------------------------------------
// Express route — MCP-protocol-shaped endpoint
// ---------------------------------------------------------------------------

const router = Router();

router.use(requireAuth);

/**
 * POST /api/task-planner-board-mcp/mcp
 *
 * Handles MCP tool calls. Expects a JSON body with:
 *   { method: "tools/call", params: { name: string, arguments: object } }
 * or:
 *   { method: "tools/list" }
 *
 * The userId and tabId are taken from query params (embedded in URL at
 * session-start time), NOT from the request body.
 */
router.post("/mcp", async (req: Request, res: Response) => {
  try {
    const authUserId = getUserId(req);
    const userId = Number(req.query.userId);
    const tabId = Number(req.query.tabId);

    if (isNaN(userId) || isNaN(tabId)) {
      res.status(400).json({ error: "userId and tabId query params are required" });
      return;
    }

    // Security: the authenticated user must match the userId in the URL
    if (authUserId !== userId) {
      res.status(403).json({ error: "Unauthorized — userId does not match authenticated user" });
      return;
    }

    const body = req.body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> }; id?: unknown };

    if (body.method === "tools/list") {
      res.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          tools: [
            {
              name: "list_tasks",
              description: "List all tasks in the current tab. Returns id, title, type, priority, and state for each task.",
              inputSchema: {
                type: "object",
                properties: {},
                required: [],
              },
            },
            {
              name: "add_task_dependency",
              description: "Add dependency links to a task. The task and all dependency targets must belong to the current tab.",
              inputSchema: {
                type: "object",
                properties: {
                  taskId: { type: "number", description: "The task to add dependencies to" },
                  dependsOnTaskId: {
                    type: "array",
                    items: { type: "number" },
                    description: "Array of task IDs that this task should depend on",
                  },
                },
                required: ["taskId", "dependsOnTaskId"],
              },
            },
          ],
        },
      });
      return;
    }

    if (body.method === "tools/call") {
      const toolName = body.params?.name;
      const toolArgs = body.params?.arguments ?? {};

      if (toolName === "list_tasks") {
        const tasks = await handleListTasks({ tabId, userId });
        res.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] },
        });
        return;
      }

      if (toolName === "add_task_dependency") {
        const taskId = toolArgs.taskId as number;
        const dependsOnTaskId = toolArgs.dependsOnTaskId as number[];

        if (typeof taskId !== "number" || !Array.isArray(dependsOnTaskId)) {
          res.json({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: {
              isError: true,
              content: [{ type: "text", text: "Invalid arguments: taskId (number) and dependsOnTaskId (number[]) are required" }],
            },
          });
          return;
        }

        try {
          await handleAddTaskDependency({ tabId, userId, taskId, dependsOnTaskId });
          res.json({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: { content: [{ type: "text", text: `Dependencies added to task ${taskId}` }] },
          });
        } catch (err) {
          const message = err instanceof DependencyCycleError
            ? `Dependency cycle detected: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
          res.json({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: {
              isError: true,
              content: [{ type: "text", text: message }],
            },
          });
        }
        return;
      }

      res.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        },
      });
      return;
    }

    // Unknown method
    res.status(400).json({ error: `Unknown method: ${body.method}` });
  } catch (err) {
    log.error("route-error", {
      component: "task-planner-board-mcp",
      method: "POST",
      path: "/api/task-planner-board-mcp/mcp",
      ...toErrorFields(err),
      msg: "Failed to handle board MCP request",
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
