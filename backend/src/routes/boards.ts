import { Router, type Request, type Response } from "express";
import {
  getAllBoards,
  getBoardById,
  getBoardWithTasks,
  createBoard,
  updateBoard,
  deleteBoard,
} from "../db/boards.js";
import { broadcast } from "../websocket-handler.js";

const router = Router();

// GET /api/boards — list all boards
router.get("/", async (_req: Request, res: Response) => {
  try {
    const boards = await getAllBoards();
    res.json(boards);
  } catch (err) {
    console.error("GET /api/boards error:", err);
    res.status(500).json({ error: "Failed to fetch boards" });
  }
});

// POST /api/boards — create a board
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name } = req.body as { name: string };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const board = await createBoard({ name: name.trim() });
    broadcast({ type: "board-created", board });
    res.status(201).json(board);
  } catch (err) {
    console.error("POST /api/boards error:", err);
    res.status(500).json({ error: "Failed to create board" });
  }
});

// GET /api/boards/:id — get board with its tasks
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid board id" });
      return;
    }
    const board = await getBoardWithTasks(id);
    if (!board) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    res.json(board);
  } catch (err) {
    console.error("GET /api/boards/:id error:", err);
    res.status(500).json({ error: "Failed to fetch board" });
  }
});

// PUT /api/boards/:id — update a board
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid board id" });
      return;
    }
    const { name } = req.body as { name: string };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const board = await updateBoard(id, name.trim());
    if (!board) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    broadcast({ type: "board-updated", board });
    res.json(board);
  } catch (err) {
    console.error("PUT /api/boards/:id error:", err);
    res.status(500).json({ error: "Failed to update board" });
  }
});

// DELETE /api/boards/:id — delete a board
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid board id" });
      return;
    }
    const deleted = await deleteBoard(id);
    if (!deleted) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    broadcast({ type: "board-deleted", boardId: id });
    res.status(204).send();
  } catch (err) {
    console.error("DELETE /api/boards/:id error:", err);
    res.status(500).json({ error: "Failed to delete board" });
  }
});

export default router;
