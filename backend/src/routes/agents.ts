import { Router, type Request, type Response } from "express";
import {
  getAllAgents,
  getAgentByName,
  createAgent,
  updateAgent,
  deleteAgent,
} from "../db/agents.js";
import { broadcast } from "../websocket-handler.js";
import type { CreateAgentInput, UpdateAgentInput } from "../types.js";
import { requireAuth, getUserId } from "../middleware/auth.js";

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
    console.error("GET /api/agents error:", err);
    res.status(500).json({ error: "Failed to list agents" });
  }
});

// GET /api/agents/:name — get a single agent by name (verify ownership)
router.get("/:name", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const name = req.params.name as string;
    const agent = await getAgentByName(name);
    if (!agent || agent.userId !== userId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(agent);
  } catch (err) {
    console.error("GET /api/agents/:name error:", err);
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

    // Check if agent already exists
    const existing = await getAgentByName(input.name.trim());
    if (existing) {
      res.status(409).json({ error: "An agent with this name already exists" });
      return;
    }

    const agent = await createAgent({ ...input, name: input.name.trim(), userId });
    broadcast({ type: "agent-created", agent });
    res.status(201).json(agent);
  } catch (err) {
    console.error("POST /api/agents error:", err);
    res.status(500).json({ error: "Failed to create agent" });
  }
});

// PUT /api/agents/:name — update an existing agent (verify ownership)
router.put("/:name", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const currentName = req.params.name as string;
    const input: UpdateAgentInput = req.body;

    // Verify ownership before allowing update
    const existing = await getAgentByName(currentName);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const agent = await updateAgent(currentName, input);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    broadcast({ type: "agent-updated", agent });
    res.json(agent);
  } catch (err: any) {
    if (err.message === "An agent with this name already exists") {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("PUT /api/agents/:name error:", err);
    res.status(500).json({ error: "Failed to update agent" });
  }
});

// DELETE /api/agents/:name — delete an agent (verify ownership)
router.delete("/:name", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const name = req.params.name as string;

    // Verify ownership before allowing delete
    const existing = await getAgentByName(name);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const deleted = await deleteAgent(name);
    if (!deleted) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    broadcast({ type: "agent-deleted", agentName: name });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/agents/:name error:", err);
    res.status(500).json({ error: "Failed to delete agent" });
  }
});

// POST /api/agents/:name/tabs — assign agent to tabs (verify ownership)
router.post("/:name/tabs", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const name = req.params.name as string;
    const { tabIds } = req.body as { tabIds: number[] };

    if (!Array.isArray(tabIds)) {
      res.status(400).json({ error: "tabIds array is required" });
      return;
    }

    // Verify ownership before allowing tab assignment
    const agent = await getAgentByName(name);
    if (!agent || agent.userId !== userId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updated = await updateAgent(name, { tabIds });
    broadcast({ type: "agent-updated", agent: updated! });
    res.json(updated);
  } catch (err) {
    console.error("POST /api/agents/:name/tabs error:", err);
    res.status(500).json({ error: "Failed to assign agent to tabs" });
  }
});

export default router;
