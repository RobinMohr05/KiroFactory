import { Router, type Request, type Response } from "express";
import {
  getAllAgents,
  getAgentById,
  createAgent,
  updateAgent,
  deleteAgent,
} from "../db/agents.js";
import { broadcastToUser } from "../websocket-handler.js";
import type { CreateAgentInput, UpdateAgentInput } from "../types.js";
import { requireAuth, getUserId } from "../middleware/auth.js";
import { log, toErrorFields } from "../logger.js";

const router = Router();

// All agent routes require authentication
router.use(requireAuth);

// GET /api/agents — list all agents (filtered by authenticated user)
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const agents = await getAllAgents(userId);
    res.json(agents);
  } catch (err) {
    log.error("route-error", {
      component: "agents",
      method: "GET",
      path: "/api/agents",
      ...toErrorFields(err),
      msg: "Failed to list agents",
    });
    res.status(500).json({ error: "Failed to list agents" });
  }
});

// GET /api/agents/:id — get a single agent by numeric ID (verify ownership)
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid agent id" });
      return;
    }
    const agent = await getAgentById(id);
    if (!agent || agent.userId !== userId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(agent);
  } catch (err) {
    log.error("route-error", {
      component: "agents",
      method: "GET",
      path: "/api/agents/:id",
      ...toErrorFields(err),
      msg: "Failed to read agent",
    });
    res.status(500).json({ error: "Failed to read agent" });
  }
});

// POST /api/agents — create a new agent (owned by authenticated user)
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const input: CreateAgentInput = req.body;

    if (!input.name || typeof input.name !== "string" || input.name.trim().length === 0) {
      res.status(400).json({ error: "Agent name is required" });
      return;
    }

    const agent = await createAgent({ ...input, name: input.name.trim(), userId });
    broadcastToUser(userId, { type: "agent-created", agent });
    res.status(201).json(agent);
  } catch (err) {
    log.error("route-error", {
      component: "agents",
      method: "POST",
      path: "/api/agents",
      ...toErrorFields(err),
      msg: "Failed to create agent",
    });
    res.status(500).json({ error: "Failed to create agent" });
  }
});

// PUT /api/agents/:id — update an existing agent (verify ownership)
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid agent id" });
      return;
    }
    const input: UpdateAgentInput = req.body;

    // Verify ownership before allowing update
    const existing = await getAgentById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const agent = await updateAgent(id, input);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    broadcastToUser(userId, { type: "agent-updated", agent });
    res.json(agent);
  } catch (err) {
    log.error("route-error", {
      component: "agents",
      method: "PUT",
      path: "/api/agents/:id",
      ...toErrorFields(err),
      msg: "Failed to update agent",
    });
    res.status(500).json({ error: "Failed to update agent" });
  }
});

// DELETE /api/agents/:id — delete an agent (verify ownership)
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid agent id" });
      return;
    }

    // Verify ownership before allowing delete
    const existing = await getAgentById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const deleted = await deleteAgent(id);
    if (!deleted) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    broadcastToUser(userId, { type: "agent-deleted", agentId: id });
    res.json({ success: true });
  } catch (err) {
    log.error("route-error", {
      component: "agents",
      method: "DELETE",
      path: "/api/agents/:id",
      ...toErrorFields(err),
      msg: "Failed to delete agent",
    });
    res.status(500).json({ error: "Failed to delete agent" });
  }
});

// POST /api/agents/:id/tabs — assign agent to tabs (verify ownership)
router.post("/:id/tabs", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid agent id" });
      return;
    }
    const { tabIds } = req.body as { tabIds: number[] };

    if (!Array.isArray(tabIds)) {
      res.status(400).json({ error: "tabIds array is required" });
      return;
    }

    // Verify ownership before allowing tab assignment
    const agent = await getAgentById(id);
    if (!agent || agent.userId !== userId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updated = await updateAgent(id, { tabIds });
    broadcastToUser(userId, { type: "agent-updated", agent: updated! });
    res.json(updated);
  } catch (err) {
    log.error("route-error", {
      component: "agents",
      method: "POST",
      path: "/api/agents/:id/tabs",
      ...toErrorFields(err),
      msg: "Failed to assign agent to tabs",
    });
    res.status(500).json({ error: "Failed to assign agent to tabs" });
  }
});

export default router;
