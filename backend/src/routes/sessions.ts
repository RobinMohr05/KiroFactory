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
import type { CreateSessionInput } from "../types.js";

const router = Router();

// Helper to extract :id param safely
function paramId(req: Request): string {
  return req.params.id as string;
}

// GET /api/sessions — list all sessions (without full output)
router.get("/", (_req: Request, res: Response) => {
  try {
    const sessions = getAllSessions();
    res.json(sessions);
  } catch (err) {
    console.error("GET /api/sessions error:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// POST /api/sessions — create a new session
router.post("/", (req: Request, res: Response) => {
  try {
    const input: CreateSessionInput = req.body;
    if (!input.name || !input.agent) {
      res.status(400).json({ error: "name and agent are required" });
      return;
    }
    const session = createSession(input);
    res.status(201).json(session);
  } catch (err) {
    console.error("POST /api/sessions error:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// GET /api/sessions/:id — get session detail
router.get("/:id", (req: Request, res: Response) => {
  try {
    const session = getSession(paramId(req));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  } catch (err) {
    console.error("GET /api/sessions/:id error:", err);
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// GET /api/sessions/:id/output — get session output buffer
router.get("/:id/output", (req: Request, res: Response) => {
  try {
    const session = getSession(paramId(req));
    if (!session) {
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

// POST /api/sessions/:id/start — start a session
router.post("/:id/start", async (req: Request, res: Response) => {
  try {
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

// POST /api/sessions/:id/stop — stop a session
router.post("/:id/stop", async (req: Request, res: Response) => {
  try {
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

// POST /api/sessions/:id/prompt — send a follow-up prompt
router.post("/:id/prompt", async (req: Request, res: Response) => {
  try {
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

// DELETE /api/sessions/:id — delete a session
router.delete("/:id", async (req: Request, res: Response) => {
  try {
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
