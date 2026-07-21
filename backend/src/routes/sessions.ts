import { Router, type Request, type Response } from "express";
import {
  createSession,
  getSession,
  getAllSessions,
  getSessionOutput,
  deleteSession,
  startSession,
  stopSession,
  sendPrompt,
} from "../session-manager.js";
import { requireAuth, getUserId } from "../middleware/auth.js";
import type { CreateSessionInput } from "../types.js";

const router = Router();

// All session routes require authentication
router.use(requireAuth);

// Helper to extract :id param safely
function paramId(req: Request): string {
  return req.params.id as string;
}

// GET /api/sessions — list all sessions for the authenticated user (without full output)
router.get("/", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessions = getAllSessions(userId);
    res.json(sessions);
  } catch (err) {
    console.error("GET /api/sessions error:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// POST /api/sessions — create a new session (owned by authenticated user)
router.post("/", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const input: CreateSessionInput = req.body;
    if (!input.name || !input.agent) {
      res.status(400).json({ error: "name and agent are required" });
      return;
    }
    // Force userId from auth context (ignore any userId in the body)
    input.userId = userId;
    const session = createSession(input);
    res.status(201).json(session);
  } catch (err) {
    console.error("POST /api/sessions error:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// GET /api/sessions/:id — get session detail (must belong to authenticated user)
router.get("/:id", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const session = getSession(paramId(req));
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  } catch (err) {
    console.error("GET /api/sessions/:id error:", err);
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// GET /api/sessions/:id/output — get session output buffer (must belong to authenticated user)
router.get("/:id/output", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const session = getSession(paramId(req));
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const output = getSessionOutput(paramId(req));
    res.json(output);
  } catch (err) {
    console.error("GET /api/sessions/:id/output error:", err);
    res.status(500).json({ error: "Failed to fetch output" });
  }
});

// POST /api/sessions/:id/start — start a session (must belong to authenticated user)
router.post("/:id/start", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const session = getSession(paramId(req));
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const ok = await startSession(paramId(req));
    if (!ok) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/sessions/:id/start error:", err);
    res.status(500).json({ error: "Failed to start session" });
  }
});

// POST /api/sessions/:id/stop — stop a session (must belong to authenticated user)
router.post("/:id/stop", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const session = getSession(paramId(req));
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const ok = await stopSession(paramId(req));
    if (!ok) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/sessions/:id/stop error:", err);
    res.status(500).json({ error: "Failed to stop session" });
  }
});

// POST /api/sessions/:id/prompt — send a follow-up prompt (must belong to authenticated user)
router.post("/:id/prompt", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const session = getSession(paramId(req));
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { text } = req.body;
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const ok = await sendPrompt(paramId(req), text);
    if (!ok) {
      res.status(400).json({ error: "Session not found or not running" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/sessions/:id/prompt error:", err);
    res.status(500).json({ error: "Failed to send prompt" });
  }
});

// DELETE /api/sessions/:id — delete a session (must belong to authenticated user)
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const session = getSession(paramId(req));
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const ok = deleteSession(paramId(req));
    if (!ok) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/sessions/:id error:", err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

export default router;
