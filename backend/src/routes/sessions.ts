import { Router, type Request, type Response } from "express";
import {
  createSession,
  getSession,
  getSessionTurnCount,
  getAllSessions,
  getSessionOutput,
  deleteSession,
  startSession,
  stopSession,
  sendPrompt,
  updateSessionTabs,
  reorderSessions,
  pinSession,
  updateSessionFields,
} from "../session-manager.js";
import { requireAuth, getUserId } from "../middleware/auth.js";
import type { CreateSessionInput, UpdateSessionInput } from "../types.js";
import { log, toErrorFields } from "../logger.js";
import { sanitizeSessionForClient } from "../session-sanitize.js";
import { getTurnsBySession } from "../db/turns.js";

const router = Router();

// All session routes require authentication
router.use(requireAuth);

// Helper to extract :id param safely, parsed as a number.
// Returns null if the param is missing or not a valid integer.
function paramId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) ? id : null;
}

// GET /api/sessions — list all sessions for the authenticated user (without full output)
router.get("/", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessions = getAllSessions(userId);
    res.json(sessions);
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "GET",
      path: "/api/sessions",
      ...toErrorFields(err),
      msg: "Failed to fetch sessions",
    });
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// POST /api/sessions — create a new session (owned by authenticated user)
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const input: CreateSessionInput = req.body;
    if (!input.name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    // Force userId from auth context (ignore any userId in the body).
    // `pinned`, `isPermanent`, `forceLocal`, and `rawMcpServers` are internal-only
    // (set programmatically for planner sessions and permanent Chat sessions)
    // — never honor from a public request body.
    input.userId = userId;
    input.pinned = false;
    input.isPermanent = false;
    input.forceLocal = undefined;
    input.rawMcpServers = undefined;
    const session = await createSession(input);
    res.status(201).json(sanitizeSessionForClient(session));
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "POST",
      path: "/api/sessions",
      ...toErrorFields(err),
      msg: "Failed to create session",
    });
    res.status(500).json({ error: "Failed to create session" });
  }
});

// PUT /api/sessions/reorder — reorder sessions by setting sort_order based on array position
router.put("/reorder", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { sessionIds } = req.body;
    if (!Array.isArray(sessionIds) || sessionIds.some((id: unknown) => !Number.isInteger(id))) {
      res.status(400).json({ error: "sessionIds must be an array of integers" });
      return;
    }
    const ok = reorderSessions(sessionIds, userId);
    if (!ok) {
      res.status(400).json({ error: "One or more sessions not found or not owned by user" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "PUT",
      path: "/api/sessions/reorder",
      ...toErrorFields(err),
      msg: "Failed to reorder sessions",
    });
    res.status(500).json({ error: "Failed to reorder sessions" });
  }
});

// GET /api/sessions/:id — get session detail (must belong to authenticated user)
router.get("/:id", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ ...sanitizeSessionForClient(session), turnCount: getSessionTurnCount(id) });
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "GET",
      path: "/api/sessions/:id",
      ...toErrorFields(err),
      msg: "Failed to fetch session",
    });
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// GET /api/sessions/:id/output — get session output buffer (must belong to authenticated user)
router.get("/:id/output", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const output = getSessionOutput(id);
    res.json(output);
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "GET",
      path: "/api/sessions/:id/output",
      ...toErrorFields(err),
      msg: "Failed to fetch output",
    });
    res.status(500).json({ error: "Failed to fetch output" });
  }
});

// GET /api/sessions/:id/turns — get turn history for a session (must belong to authenticated user)
router.get("/:id/turns", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const turns = await getTurnsBySession(id);
    res.json(turns);
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "GET",
      path: "/api/sessions/:id/turns",
      ...toErrorFields(err),
      msg: "Failed to fetch turns",
    });
    res.status(500).json({ error: "Failed to fetch turns" });
  }
});

// POST /api/sessions/:id/start — start a session (must belong to authenticated user)
router.post("/:id/start", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const ok = await startSession(id);
    if (!ok) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "POST",
      path: "/api/sessions/:id/start",
      ...toErrorFields(err),
      msg: "Failed to start session",
    });
    res.status(500).json({ error: "Failed to start session" });
  }
});

// POST /api/sessions/:id/stop — stop a session (must belong to authenticated user)
router.post("/:id/stop", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const ok = await stopSession(id);
    if (!ok) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "POST",
      path: "/api/sessions/:id/stop",
      ...toErrorFields(err),
      msg: "Failed to stop session",
    });
    res.status(500).json({ error: "Failed to stop session" });
  }
});

// POST /api/sessions/:id/prompt — send a follow-up prompt (must belong to authenticated user)
router.post("/:id/prompt", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { text } = req.body;
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const ok = await sendPrompt(id, text);
    if (!ok) {
      res.status(400).json({ error: "Session not found or not running" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "POST",
      path: "/api/sessions/:id/prompt",
      ...toErrorFields(err),
      msg: "Failed to send prompt",
    });
    res.status(500).json({ error: "Failed to send prompt" });
  }
});

// PUT /api/sessions/:id/tabs — update session tab assignments (must belong to authenticated user)
router.put("/:id/tabs", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { tabIds } = req.body;
    if (!Array.isArray(tabIds)) {
      res.status(400).json({ error: "tabIds must be an array" });
      return;
    }
    const ok = updateSessionTabs(id, tabIds);
    if (!ok) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "PUT",
      path: "/api/sessions/:id/tabs",
      ...toErrorFields(err),
      msg: "Failed to update session tabs",
    });
    res.status(500).json({ error: "Failed to update session tabs" });
  }
});

// PATCH /api/sessions/:id/pin — toggle pin state (must belong to authenticated user)
router.patch("/:id/pin", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { pinned } = req.body;
    if (typeof pinned !== "boolean") {
      res.status(400).json({ error: "pinned must be a boolean" });
      return;
    }
    const ok = pinSession(id, pinned);
    if (!ok) {
      res.status(403).json({ error: "Cannot unpin a permanent session" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "PATCH",
      path: "/api/sessions/:id/pin",
      ...toErrorFields(err),
      msg: "Failed to update session pin state",
    });
    res.status(500).json({ error: "Failed to update session pin state" });
  }
});

// PATCH /api/sessions/:id — update editable session fields (must belong to authenticated user, must not be running)
router.patch("/:id", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Strip non-editable fields from the request body
    const { agent, id: _id, status, userId: _userId, createdAt, startedAt, currentTaskId, currentActivity, pinned, output, ...rest } = req.body;
    const updates: UpdateSessionInput = {};
    if (rest.name !== undefined) updates.name = rest.name;
    if (rest.prompt !== undefined) updates.prompt = rest.prompt;
    if (rest.cwd !== undefined) updates.cwd = rest.cwd;
    if (rest.model !== undefined) updates.model = rest.model;
    if (rest.timeoutSeconds !== undefined) updates.timeoutSeconds = rest.timeoutSeconds;
    if (rest.interactive !== undefined) updates.interactive = rest.interactive;
    if (rest.loop !== undefined) updates.loop = rest.loop;
    if (rest.runs !== undefined) updates.runs = rest.runs;
    if (rest.intervalSeconds !== undefined) updates.intervalSeconds = rest.intervalSeconds;
    if (rest.mcpServers !== undefined) updates.mcpServers = rest.mcpServers;
    if (rest.mcpConfigOverride !== undefined) updates.mcpConfigOverride = rest.mcpConfigOverride;
    if (rest.tabIds !== undefined) updates.tabIds = rest.tabIds;

    const result = updateSessionFields(id, updates);
    if (!result) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!result.success) {
      if (result.reason === "running") {
        res.status(409).json({ error: "Cannot edit a running session. Stop the session first." });
        return;
      }
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "PATCH",
      path: "/api/sessions/:id",
      ...toErrorFields(err),
      msg: "Failed to update session",
    });
    res.status(500).json({ error: "Failed to update session" });
  }
});

// DELETE /api/sessions/:id — delete a session (must belong to authenticated user)
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = paramId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = getSession(id);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.isPermanent) {
      res.status(403).json({ error: "Permanent sessions cannot be deleted" });
      return;
    }
    const ok = deleteSession(id);
    if (!ok) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "sessions",
      method: "DELETE",
      path: "/api/sessions/:id",
      ...toErrorFields(err),
      msg: "Failed to delete session",
    });
    res.status(500).json({ error: "Failed to delete session" });
  }
});

export default router;
