import { Router, type Request, type Response } from "express";
import {
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  assignTaskToBoards,
  removeTaskFromBoard,
} from "../db/tasks.js";
import { broadcast } from "../websocket-handler.js";
import type { CreateTaskInput, UpdateTaskInput } from "../types.js";

const router = Router();

// GET /api/tasks — list tasks with optional filters
router.get("/", async (req: Request, res: Response) => {
  try {
    const { state, priority, boardId } = req.query;
    const tasks = await getAllTasks({
      state: state as string | undefined,
      priority: priority ? Number(priority) : undefined,
      boardId: boardId ? Number(boardId) : undefined,
    });
    res.json(tasks);
  } catch (err) {
    console.error("GET /api/tasks error:", err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

// POST /api/tasks — create a new task
router.post("/", async (req: Request, res: Response) => {
  try {
    const input: CreateTaskInput = req.body;
    if (!input.title || !input.priority || !input.type) {
      res.status(400).json({ error: "title, priority, and type are required" });
      return;
    }
    const task = await createTask(input);
    broadcast({ type: "task-created", task });
    res.status(201).json(task);
  } catch (err) {
    console.error("POST /api/tasks error:", err);
    res.status(500).json({ error: "Failed to create task" });
  }
});

// GET /api/tasks/:id — get a single task with boards
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }
    const task = await getTaskById(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  } catch (err) {
    console.error("GET /api/tasks/:id error:", err);
    res.status(500).json({ error: "Failed to fetch task" });
  }
});

// PUT /api/tasks/:id — update a task
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }
    const input: UpdateTaskInput = req.body;
    const task = await updateTask(id, input);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    broadcast({ type: "task-updated", task });
    res.json(task);
  } catch (err) {
    console.error("PUT /api/tasks/:id error:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

// DELETE /api/tasks/:id — delete a task
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }
    const deleted = await deleteTask(id);
    if (!deleted) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    broadcast({ type: "task-deleted", taskId: id });
    res.status(204).send();
  } catch (err) {
    console.error("DELETE /api/tasks/:id error:", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// POST /api/tasks/:id/boards — assign task to boards
router.post("/:id/boards", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }
    const { boardIds } = req.body as { boardIds: number[] };
    if (!Array.isArray(boardIds) || boardIds.length === 0) {
      res.status(400).json({ error: "boardIds must be a non-empty array" });
      return;
    }
    const task = await assignTaskToBoards(id, boardIds);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    broadcast({ type: "task-updated", task });
    res.json(task);
  } catch (err) {
    console.error("POST /api/tasks/:id/boards error:", err);
    res.status(500).json({ error: "Failed to assign boards" });
  }
});

// DELETE /api/tasks/:id/boards/:boardId — remove task from board
router.delete("/:id/boards/:boardId", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const boardId = Number(req.params.boardId);
    if (isNaN(id) || isNaN(boardId)) {
      res.status(400).json({ error: "Invalid task or board id" });
      return;
    }
    const task = await removeTaskFromBoard(id, boardId);
    if (!task) {
      res.status(404).json({ error: "Task or board assignment not found" });
      return;
    }
    broadcast({ type: "task-updated", task });
    res.json(task);
  } catch (err) {
    console.error("DELETE /api/tasks/:id/boards/:boardId error:", err);
    res.status(500).json({ error: "Failed to remove from board" });
  }
});

export default router;
