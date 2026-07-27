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
import { log, toErrorFields } from "../logger.js";
import { GIT_PROVIDERS, isGitProvider, type GitProvider } from "../types.js";

const router = Router();

// All tab routes require authentication
router.use(requireAuth);

/** Sentinel distinguishing "invalid value supplied" from "explicitly cleared". */
const INVALID_PROVIDER = Symbol("invalid-git-provider");

/**
 * Normalise an incoming gitProvider value.
 * Empty string, null and "inherit" all mean "inherit" (stored as NULL).
 */
function parseGitProvider(value: unknown): GitProvider | null | typeof INVALID_PROVIDER {
  if (value === undefined || value === null || value === "" || value === "inherit") return null;
  if (isGitProvider(value)) return value;
  return INVALID_PROVIDER;
}

// GET /api/tabs — list all tabs (filtered by authenticated user)
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const tabs = await getAllTabs(userId);
    res.json(tabs);
  } catch (err) {
    log.error("route-error", {
      component: "tabs",
      method: "GET",
      path: "/api/tabs",
      ...toErrorFields(err),
      msg: "Failed to fetch tabs",
    });
    res.status(500).json({ error: "Failed to fetch tabs" });
  }
});

// POST /api/tabs — create a tab (owned by authenticated user)
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { name, repositoryUrl, gitProvider } = req.body as {
      name: string;
      repositoryUrl?: string;
      gitProvider?: string | null;
    };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const validatedProvider = parseGitProvider(gitProvider);
    if (validatedProvider === INVALID_PROVIDER) {
      res.status(400).json({ error: `gitProvider must be one of: ${GIT_PROVIDERS.join(", ")}, or null` });
      return;
    }
    const tab = await createTab({
      name: name.trim(),
      repositoryUrl: repositoryUrl?.trim() || undefined,
      gitProvider: validatedProvider,
      userId,
    });
    broadcast({ type: "tab-created", tab });
    res.status(201).json(tab);
  } catch (err) {
    log.error("route-error", {
      component: "tabs",
      method: "POST",
      path: "/api/tabs",
      ...toErrorFields(err),
      msg: "Failed to create tab",
    });
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
    log.error("route-error", {
      component: "tabs",
      method: "PUT",
      path: "/api/tabs/reorder",
      ...toErrorFields(err),
      msg: "Failed to reorder tabs",
    });
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
    log.error("route-error", {
      component: "tabs",
      method: "GET",
      path: "/api/tabs/:id",
      ...toErrorFields(err),
      msg: "Failed to fetch tab",
    });
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
    const { name, repositoryUrl, mcpConfig, gitProvider } = req.body as {
      name: string;
      repositoryUrl?: string | null;
      mcpConfig?: { atlassian?: boolean; azureDevops?: boolean; awsApi?: boolean; awsDocs?: boolean } | null;
      gitProvider?: string | null;
    };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    // Omitting gitProvider keeps the current value; sending null/"" clears it
    // back to "inherit".
    const validatedProvider =
      gitProvider === undefined ? existing.gitProvider : parseGitProvider(gitProvider);
    if (validatedProvider === INVALID_PROVIDER) {
      res.status(400).json({ error: `gitProvider must be one of: ${GIT_PROVIDERS.join(", ")}, or null` });
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
    const tab = await updateTab(id, name.trim(), repositoryUrl, validatedMcpConfig, validatedProvider);
    if (!tab) {
      res.status(404).json({ error: "Tab not found" });
      return;
    }
    broadcast({ type: "tab-updated", tab });
    res.json(tab);
  } catch (err) {
    log.error("route-error", {
      component: "tabs",
      method: "PUT",
      path: "/api/tabs/:id",
      ...toErrorFields(err),
      msg: "Failed to update tab",
    });
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
    log.error("route-error", {
      component: "tabs",
      method: "DELETE",
      path: "/api/tabs/:id",
      ...toErrorFields(err),
      msg: "Failed to delete tab",
    });
    res.status(500).json({ error: "Failed to delete tab" });
  }
});

export default router;
