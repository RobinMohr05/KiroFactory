import { Router, type Request, type Response } from "express";
import {
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  assignTaskToTabs,
  removeTaskFromTab,
  isTaskOwnedByUser,
} from "../db/tasks.js";
import { getAllTabs } from "../db/tabs.js";
import { broadcastToUser } from "../websocket-handler.js";
import { notifyTaskAvailable } from "../agent/task-claimer.js";
import { requireAuth, getUserId } from "../middleware/auth.js";
import type { CreateTaskInput, UpdateTaskInput } from "../types.js";
import { log, toErrorFields } from "../logger.js";

const router = Router();

// All task routes require authentication
router.use(requireAuth);

// GET /api/tasks — list tasks with optional filters (scoped to user's tabs)
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { state, priority, tabId } = req.query;

    // If filtering by tabId, verify the tab belongs to the user
    if (tabId) {
      const userTabs = await getAllTabs(userId);
      const tabIdNum = Number(tabId);
      if (!userTabs.some((t) => t.id === tabIdNum)) {
        res.json([]); // Tab doesn't belong to user — return empty
        return;
      }
    }

    const tasks = await getAllTasks({
      state: state as string | undefined,
      priority: priority ? Number(priority) : undefined,
      tabId: tabId ? Number(tabId) : undefined,
      userId,
    });
    res.json(tasks);
  } catch (err) {
    log.error("route-error", {
      component: "tasks",
      method: "GET",
      path: "/api/tasks",
      ...toErrorFields(err),
      msg: "Failed to fetch tasks",
    });
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

// POST /api/tasks — create a new task (verify tabIds belong to user)
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const input: CreateTaskInput = req.body;
    if (!input.title || !input.priority || !input.type) {
      res.status(400).json({ error: "title, priority, and type are required" });
      return;
    }

    // Verify all provided tabIds belong to the authenticated user
    if (input.tabIds && input.tabIds.length > 0) {
      const userTabs = await getAllTabs(userId);
      const userTabIds = new Set(userTabs.map((t) => t.id));
      const unauthorized = input.tabIds.filter((id) => !userTabIds.has(id));
      if (unauthorized.length > 0) {
        res.status(403).json({ error: "Cannot assign task to tabs you do not own" });
        return;
      }
    } else {
      // No tabIds provided — assign to the user's first tab so the task is owned
      const userTabs = await getAllTabs(userId);
      if (userTabs.length > 0) {
        input.tabIds = [userTabs[0].id];
      }
    }

    const task = await createTask(input);
    broadcastToUser(userId, { type: "task-created", task });
    notifyTaskAvailable(); // wake any idle loop sessions immediately
    res.status(201).json(task);
  } catch (err) {
    log.error("route-error", {
      component: "tasks",
      method: "POST",
      path: "/api/tasks",
      ...toErrorFields(err),
      msg: "Failed to create task",
    });
    res.status(500).json({ error: "Failed to create task" });
  }
});

// GET /api/tasks/:id — get a single task with tabs (verify ownership)
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }

    // Verify task belongs to a tab owned by the user
    const owned = await isTaskOwnedByUser(id, userId);
    if (!owned) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const task = await getTaskById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  } catch (err) {
    log.error("route-error", {
      component: "tasks",
      method: "GET",
      path: "/api/tasks/:id",
      ...toErrorFields(err),
      msg: "Failed to fetch task",
    });
    res.status(500).json({ error: "Failed to fetch task" });
  }
});

// PUT /api/tasks/:id — update a task (verify ownership)
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }

    // Verify task belongs to a tab owned by the user
    const owned = await isTaskOwnedByUser(id, userId);
    if (!owned) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const input: UpdateTaskInput = req.body;
    const task = await updateTask(id, input);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    broadcastToUser(userId, { type: "task-updated", task });
    res.json(task);
  } catch (err) {
    log.error("route-error", {
      component: "tasks",
      method: "PUT",
      path: "/api/tasks/:id",
      ...toErrorFields(err),
      msg: "Failed to update task",
    });
    res.status(500).json({ error: "Failed to update task" });
  }
});

// DELETE /api/tasks/:id — delete a task (verify ownership)
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }

    // Verify task belongs to a tab owned by the user
    const owned = await isTaskOwnedByUser(id, userId);
    if (!owned) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const deleted = await deleteTask(id);
    if (!deleted) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    broadcastToUser(userId, { type: "task-deleted", taskId: id });
    res.status(204).send();
  } catch (err) {
    log.error("route-error", {
      component: "tasks",
      method: "DELETE",
      path: "/api/tasks/:id",
      ...toErrorFields(err),
      msg: "Failed to delete task",
    });
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// POST /api/tasks/:id/tabs — assign task to tabs (verify ownership of both task and target tabs)
router.post("/:id/tabs", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }
    const { tabIds } = req.body as { tabIds: number[] };
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      res.status(400).json({ error: "tabIds must be a non-empty array" });
      return;
    }

    // Verify task belongs to a tab owned by the user
    const owned = await isTaskOwnedByUser(id, userId);
    if (!owned) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Verify all target tabs belong to the user
    const userTabs = await getAllTabs(userId);
    const userTabIds = new Set(userTabs.map((t) => t.id));
    const unauthorized = tabIds.filter((tid) => !userTabIds.has(tid));
    if (unauthorized.length > 0) {
      res.status(403).json({ error: "Cannot assign task to tabs you do not own" });
      return;
    }

    const task = await assignTaskToTabs(id, tabIds);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    broadcastToUser(userId, { type: "task-updated", task });
    res.json(task);
  } catch (err) {
    log.error("route-error", {
      component: "tasks",
      method: "POST",
      path: "/api/tasks/:id/tabs",
      ...toErrorFields(err),
      msg: "Failed to assign tabs",
    });
    res.status(500).json({ error: "Failed to assign tabs" });
  }
});

// DELETE /api/tasks/:id/tabs/:tabId — remove task from tab (verify ownership)
router.delete("/:id/tabs/:tabId", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    const tabId = Number(req.params.tabId);
    if (isNaN(id) || isNaN(tabId)) {
      res.status(400).json({ error: "Invalid task or tab id" });
      return;
    }

    // Verify task belongs to a tab owned by the user
    const owned = await isTaskOwnedByUser(id, userId);
    if (!owned) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Verify the target tab belongs to the user
    const userTabs = await getAllTabs(userId);
    if (!userTabs.some((t) => t.id === tabId)) {
      res.status(403).json({ error: "Cannot modify tabs you do not own" });
      return;
    }

    const task = await removeTaskFromTab(id, tabId);
    if (!task) {
      res.status(404).json({ error: "Task or tab assignment not found" });
      return;
    }
    broadcastToUser(userId, { type: "task-updated", task });
    res.json(task);
  } catch (err) {
    log.error("route-error", {
      component: "tasks",
      method: "DELETE",
      path: "/api/tasks/:id/tabs/:tabId",
      ...toErrorFields(err),
      msg: "Failed to remove from tab",
    });
    res.status(500).json({ error: "Failed to remove from tab" });
  }
});

export default router;
