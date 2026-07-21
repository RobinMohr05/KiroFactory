import { Router, type Request, type Response } from "express";
import {
  getAllTabs,
  getTabById,
  getTabWithTasks,
  createTab,
  updateTab,
  deleteTab,
  reorderTabs,
} from "../db/tabs.js";
import { broadcast } from "../websocket-handler.js";
import { requireAuth, getUserId } from "../middleware/auth.js";

const router = Router();

// All tab routes require authentication
router.use(requireAuth);

// GET /api/tabs — list all tabs (filtered by authenticated user)
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const tabs = await getAllTabs(userId);
    res.json(tabs);
  } catch (err) {
    console.error("GET /api/tabs error:", err);
    res.status(500).json({ error: "Failed to fetch tabs" });
  }
});

// POST /api/tabs — create a tab (owned by authenticated user)
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { name, repositoryUrl } = req.body as { name: string; repositoryUrl?: string };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const tab = await createTab({
      name: name.trim(),
      repositoryUrl: repositoryUrl?.trim() || undefined,
      userId,
    });
    broadcast({ type: "tab-created", tab });
    res.status(201).json(tab);
  } catch (err) {
    console.error("POST /api/tabs error:", err);
    res.status(500).json({ error: "Failed to create tab" });
  }
});

// PUT /api/tabs/reorder — reorder tabs (must be before /:id to avoid param conflict)
router.put("/reorder", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { tabIds } = req.body as { tabIds: number[] };
    if (!Array.isArray(tabIds) || tabIds.length === 0 || !tabIds.every((id) => typeof id === "number")) {
      res.status(400).json({ error: "tabIds must be a non-empty array of numbers" });
      return;
    }
    // Verify all tabIds belong to the authenticated user
    const userTabs = await getAllTabs(userId);
    const userTabIds = new Set(userTabs.map((t) => t.id));
    const unauthorized = tabIds.filter((id) => !userTabIds.has(id));
    if (unauthorized.length > 0) {
      res.status(403).json({ error: "Cannot reorder tabs you do not own" });
      return;
    }
    await reorderTabs(tabIds);
    const tabs = await getAllTabs(userId);
    broadcast({ type: "tabs-reordered", tabs });
    res.json(tabs);
  } catch (err) {
    console.error("PUT /api/tabs/reorder error:", err);
    res.status(500).json({ error: "Failed to reorder tabs" });
  }
});

// GET /api/tabs/:id — get tab with its tasks, sessions, agents, errors
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tab id" });
      return;
    }
    // Verify ownership before returning
    const tab = await getTabById(id);
    if (!tab) {
      res.status(404).json({ error: "Tab not found" });
      return;
    }
    if (tab.userId !== userId) {
      res.status(404).json({ error: "Tab not found" });
      return;
    }
    const fullTab = await getTabWithTasks(id);
    res.json(fullTab);
  } catch (err) {
    console.error("GET /api/tabs/:id error:", err);
    res.status(500).json({ error: "Failed to fetch tab" });
  }
});

// PUT /api/tabs/:id — update a tab
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tab id" });
      return;
    }
    // Verify ownership
    const existing = await getTabById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "Tab not found" });
      return;
    }
    const { name, repositoryUrl, mcpConfig } = req.body as {
      name: string;
      repositoryUrl?: string | null;
      mcpConfig?: { atlassian?: boolean; azureDevops?: boolean; awsApi?: boolean; awsDocs?: boolean } | null;
    };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    // Validate mcpConfig shape if provided
    let validatedMcpConfig: import("../types.js").TabMcpConfig | null = null;
    if (mcpConfig && typeof mcpConfig === "object") {
      validatedMcpConfig = {
        atlassian: mcpConfig.atlassian !== false,
        azureDevops: mcpConfig.azureDevops !== false,
        awsApi: mcpConfig.awsApi === true,
        awsDocs: mcpConfig.awsDocs !== false,
      };
    }
    const tab = await updateTab(id, name.trim(), repositoryUrl, validatedMcpConfig);
    if (!tab) {
      res.status(404).json({ error: "Tab not found" });
      return;
    }
    broadcast({ type: "tab-updated", tab });
    res.json(tab);
  } catch (err) {
    console.error("PUT /api/tabs/:id error:", err);
    res.status(500).json({ error: "Failed to update tab" });
  }
});

// DELETE /api/tabs/:id — delete a tab
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tab id" });
      return;
    }
    // Verify ownership
    const existing = await getTabById(id);
    if (!existing || existing.userId !== userId) {
      res.status(404).json({ error: "Tab not found" });
      return;
    }
    const deleted = await deleteTab(id);
    if (!deleted) {
      res.status(404).json({ error: "Tab not found" });
      return;
    }
    broadcast({ type: "tab-deleted", tabId: id });
    res.status(204).send();
  } catch (err) {
    console.error("DELETE /api/tabs/:id error:", err);
    res.status(500).json({ error: "Failed to delete tab" });
  }
});

export default router;
