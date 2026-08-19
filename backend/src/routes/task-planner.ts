import { Router, type Request, type Response } from "express";
import express from "express";
import {
  createSession,
  startSession,
  stopSession,
  sendPrompt,
  getSession,
  getSessionOutput,
  deleteSession,
  injectPendingRunner,
} from "../session-manager.js";
import { createTask } from "../db/tasks.js";
import { getAllTabs, getTabById } from "../db/tabs.js";
import { broadcastToUser } from "../websocket-handler.js";
import { notifyTaskAvailable } from "../agent/task-claimer.js";
import { requireAuth, getUserId } from "../middleware/auth.js";
import { log, toErrorFields } from "../logger.js";
import { getDecryptedCredential } from "../db/credentials.js";
import { resolveGitProvider } from "../types.js";
import { getUserById } from "../db/users.js";
import { buildPlannerRepoMcpServer } from "./task-planner-mcp.js";
import { PlannerSessionPool, type PooledRunner } from "../planner-session-pool.js";
import { KiroRunner } from "../agent/kiro-runner.js";
import { resolve } from "node:path";
import type { CreateTaskInput } from "../types.js";

/**
 * Extended PooledRunner that exposes the underlying KiroRunner instance.
 * Needed because `injectPendingRunner()` requires the actual KiroRunner object,
 * not just the PooledRunner interface.
 */
interface PooledKiroRunner extends PooledRunner {
  readonly _kiroRunner: KiroRunner;
}

const router = Router();

// All task planner routes require authentication
router.use(requireAuth);

// Override the global body-parser limit (100KB) for this router — image uploads
// send base64-encoded data inside the JSON body which easily exceeds the default.
router.use(express.json({ limit: "15mb" }));

// ---------------------------------------------------------------------------
// Warm Session Pool
// ---------------------------------------------------------------------------

/** Default cwd for pre-warmed pool runners (project root). */
const DEFAULT_POOL_CWD = resolve(import.meta.dirname, "../../..");

/** Configurable pool limits via env vars (with sensible defaults). */
const POOL_MAX_PER_TAB = Number(process.env.PLANNER_POOL_MAX_PER_TAB) || 2;
const POOL_MAX_TOTAL = Number(process.env.PLANNER_POOL_MAX_TOTAL) || 6;
const POOL_IDLE_TIMEOUT_MS = Number(process.env.PLANNER_POOL_IDLE_MS) || 20 * 60 * 1000; // 20 min

let runnerIdSeq = 0;

/**
 * Check whether the warm pool can be used.
 *
 * DESIGN DECISION — API key handling for pooled runners:
 * Pool runners are spawned ahead of time (before any user context is known).
 * The Kiro API key is baked into the child process environment at spawn time
 * and cannot be changed afterwards — `newSession()` only resets the ACP
 * session/cwd, not the process environment.
 *
 * Therefore pooled runners ALWAYS use the server's global `KIRO_API_KEY` env var.
 * If no global key is configured, pooling is disabled and the system falls back
 * to cold-start, which correctly decrypts and uses each user's individual key.
 *
 * This is an acceptable trade-off because:
 * - The server's global key is used only for planner sessions (short, interactive)
 * - The cold-start path remains the fallback and always uses per-user keys
 * - Production deployments should always set `KIRO_API_KEY` in the server env
 */
export function isPoolEnabled(): boolean {
  return !!process.env.KIRO_API_KEY;
}

/**
 * Factory function that spawns a real KiroRunner process for the pool.
 * Uses a generic cwd (project root) — the actual workspace cwd is set later
 * via newSession(cwd) when the runner is checked out for a real conversation.
 *
 * NOTE: Pool runners authenticate using the server's global KIRO_API_KEY env var.
 * Per-user keys cannot be injected into an already-running process.
 */
async function createPoolRunner(): Promise<PooledKiroRunner> {
  const runner = await KiroRunner.create({
    cwd: DEFAULT_POOL_CWD,
    model: null,
    // kiroApiKey is intentionally NOT passed here — KiroRunner.create() will
    // automatically pick up process.env.KIRO_API_KEY (the server's global key).
    // See isPoolEnabled() guard for why per-user keys can't be used in the pool.
  });
  runnerIdSeq++;
  const id = `planner-pool-${runnerIdSeq}-${Date.now()}`;
  return {
    id,
    get isAlive() { return runner.isAlive; },
    newSession: (cwd?: string) => runner.newSession(cwd),
    close: () => runner.close(),
    /** The underlying KiroRunner (needed for injectPendingRunner) */
    _kiroRunner: runner,
  };
}

/** Singleton pool instance. */
export const plannerPool = new PlannerSessionPool({
  maxPerTab: POOL_MAX_PER_TAB,
  maxTotal: POOL_MAX_TOTAL,
  idleTimeoutMs: POOL_IDLE_TIMEOUT_MS,
  factory: createPoolRunner,
});

// Log pool status at startup so operators know whether warm pooling is active.
if (isPoolEnabled()) {
  log.info("planner-pool-enabled", {
    component: "planner-pool",
    maxPerTab: POOL_MAX_PER_TAB,
    maxTotal: POOL_MAX_TOTAL,
    idleTimeoutMs: POOL_IDLE_TIMEOUT_MS,
    msg: `Planner session pool enabled (using server KIRO_API_KEY). Max ${POOL_MAX_TOTAL} total, ${POOL_MAX_PER_TAB} per tab, ${POOL_IDLE_TIMEOUT_MS / 1000}s idle timeout.`,
  });
} else {
  log.warn("planner-pool-disabled", {
    component: "planner-pool",
    msg: "Planner session pool DISABLED — KIRO_API_KEY env var is not set. All planner sessions will cold-start. Set KIRO_API_KEY to enable warm pooling.",
  });
}

/**
 * System prompt for the task planner agent.
 * This instructs the AI to help the user define a well-structured task
 * through a conversational interview process.
 */
const TASK_PLANNER_SYSTEM_PROMPT = `You are a Task Planner assistant. Your job is to help the user create a well-designed, actionable task for a software development team.

## Your Process

1. **Understand the idea**: Ask the user what they want to accomplish. Listen carefully.
2. **Clarify requirements**: Ask targeted follow-up questions to understand:
   - What exactly should change or be built?
   - Why is this needed? What problem does it solve?
   - Are there specific files, components, or areas of the codebase involved?
   - What's the expected behavior when this is done?
   - Are there edge cases or constraints to consider?
3. **Propose the task**: Once you have enough information, propose a well-structured task with:
   - A clear, concise title (action-oriented, e.g., "Add pagination to /users endpoint")
   - A detailed description that includes acceptance criteria
   - Suggested priority (1=Critical, 2=High, 3=Medium, 4=Low)
   - Suggested type (feature, improvement, or bug)
   - Relevant files (if known)
4. **Refine**: Ask if the user wants to adjust anything about the proposal.
5. **Finalize**: When the user approves, output the final task as a JSON block.

## Rules

- Be conversational and helpful, not robotic.
- Ask ONE or TWO questions at a time, not a long list.
- If the user gives a vague idea, help them sharpen it.
- If the user gives a detailed spec, move quickly to the proposal.
- Always suggest a priority and type, but let the user override.
- Keep titles under 80 characters.
- Descriptions should be detailed enough for another developer to implement without further questions.

## Output Format

When the user confirms the task, output EXACTLY this format (and nothing else after it):

\`\`\`json:task
{
  "title": "...",
  "description": "...",
  "priority": 1-4,
  "type": "feature|improvement|bug",
  "files": ["file1.ts", "file2.ts"]
}
\`\`\`

Start by greeting the user and asking what they'd like to accomplish.`;

// POST /api/task-planner/prewarm — Fire-and-forget: ensure a warm pool slot exists for the tab
router.post("/prewarm", (req: Request, res: Response) => {
  const userId = getUserId(req);
  const { tabId } = req.body as { tabId?: number };
  const effectiveTabId = tabId ?? 0;

  // Pool requires a server-level KIRO_API_KEY — skip if not configured.
  if (!isPoolEnabled()) {
    res.status(202).json({ ok: true });
    return;
  }

  // Fire-and-forget: kick off the warm in the background, respond immediately.
  // Never block the caller, never surface spawn errors to the caller.
  plannerPool.warm(effectiveTabId).catch((err) => {
    log.warn("prewarm-background-error", {
      component: "task-planner",
      tabId: effectiveTabId,
      userId,
      ...toErrorFields(err),
      msg: `Background prewarm failed for tab ${effectiveTabId}`,
    });
  });

  res.status(202).json({ ok: true });
});

// POST /api/task-planner/start — Start a new task planning conversation
router.post("/start", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { tabId } = req.body as { tabId?: number };

    // Build the system prompt, optionally enriched with tab/repository context
    let systemPrompt = TASK_PLANNER_SYSTEM_PROMPT;
    let sessionTabIds: number[] | undefined;
    let rawMcpServers: unknown[] | undefined;

    if (tabId) {
      const tab = await getTabById(tabId);
      if (tab && tab.userId === userId) {
        sessionTabIds = [tab.id];
        const contextLines: string[] = [
          `\n\n## Repository Context`,
          `You are planning a task for the following project:`,
          `- **Tab/Project name:** ${tab.name}`,
        ];
        if (tab.repositoryUrl) {
          contextLines.push(`- **Repository URL:** ${tab.repositoryUrl}`);
        }
        if (tab.gitProvider) {
          contextLines.push(`- **Git provider:** ${tab.gitProvider}`);
        }

        // Build an MCP server entry for repo access (replaces git clone)
        if (tab.repositoryUrl) {
          const owner = await getUserById(userId);
          const provider = resolveGitProvider(
            tab.gitProvider,
            owner?.defaultGitProvider,
            tab.repositoryUrl
          );

          // Retrieve the appropriate PAT for private repos
          let githubPat: string | undefined;
          let azureDevOpsPat: string | undefined;
          if (provider === "github") {
            const pat = await getDecryptedCredential(userId, "githubPat");
            if (pat) githubPat = pat;
          } else if (provider === "azure-devops") {
            const pat = await getDecryptedCredential(userId, "azureDevOpsPat");
            if (pat) azureDevOpsPat = pat;
          }

          const mcpServer = buildPlannerRepoMcpServer({
            provider,
            repositoryUrl: tab.repositoryUrl,
            githubPat,
            azureDevOpsPat,
          });

          if (mcpServer) {
            rawMcpServers = [mcpServer];
            contextLines.push(
              `\n**You have MCP tools available for browsing this repository's files.** ` +
              `Use the available tools to browse the codebase, read READMEs, architecture docs, ` +
              `and understand the project structure before proposing tasks. ` +
              `Reference actual file paths that exist in the repo.`
            );
          }
        }

        contextLines.push(
          `\nUse this context to ask more relevant clarifying questions and suggest accurate file paths. ` +
          `When proposing the task, ground your suggestions in this specific project.`
        );
        systemPrompt += contextLines.join("\n");
      }
    }

    // Create a dedicated interactive session for this planning conversation.
    // forceLocal ensures the planner never triggers an ACA Job execution —
    // it only needs to chat and read files via MCP, never build/test/commit.
    const session = await createSession({
      name: "Task Planner",
      prompt: systemPrompt,
      interactive: true,
      loop: false,
      runs: 0,
      intervalSeconds: 0,
      userId,
      tabIds: sessionTabIds,
      pinned: false,
      forceLocal: true,
      rawMcpServers,
    });

    // Try to use a warm runner from the pool (keyed by tabId).
    // If one is available, inject it so startSession() skips the cold spawn.
    // Pool runners use the server's global KIRO_API_KEY — skip if not configured.
    const effectiveTabId = tabId ?? 0;
    if (isPoolEnabled()) {
      const warmRunner = plannerPool.checkout(effectiveTabId) as PooledKiroRunner | null;
      if (warmRunner) {
        const kiroRunner = warmRunner._kiroRunner;
        const injected = injectPendingRunner(session.id, kiroRunner);
        if (injected) {
          log.info("planner-warm-start", {
            component: "task-planner",
            sessionId: session.id,
            tabId: effectiveTabId,
            runnerId: warmRunner.id,
            msg: `Using warm pool runner for planner session ${session.id}`,
          });
          // Detach the pool slot (runner is now owned by the session, not the pool).
          // Uses detach() instead of destroy() so the runner is NOT closed.
          plannerPool.detach(warmRunner.id);
        } else {
          // Injection failed (e.g. session was deleted or already running) —
          // destroy the runner rather than returning it to the pool, since the
          // failure indicates an unexpected state that could leave the runner tainted.
          plannerPool.destroy(warmRunner.id).catch(() => {});
          log.warn("planner-warm-inject-failed", {
            component: "task-planner",
            sessionId: session.id,
            tabId: effectiveTabId,
            runnerId: warmRunner.id,
            msg: `Failed to inject warm runner into session ${session.id} — destroyed`,
          });
        }
      }
    }

    // Start the session immediately
    await startSession(session.id);

    res.status(201).json({
      sessionId: session.id,
      message: "Task planner session started",
    });
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "POST",
      path: "/api/task-planner/start",
      ...toErrorFields(err),
      msg: "Failed to start task planner",
    });
    res.status(500).json({ error: "Failed to start task planner" });
  }
});

// POST /api/task-planner/:sessionId/message — Send a message to the task planner
router.post("/:sessionId/message", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Task planner session not found" });
      return;
    }

    const { message, image } = req.body as { message: string; image?: { data: string; mimeType: string } };
    if (!message || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    // Validate image if provided
    if (image) {
      const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

      if (!image.data || !image.mimeType) {
        res.status(400).json({ error: "Image must include both 'data' (base64) and 'mimeType'" });
        return;
      }

      if (!ALLOWED_MIME_TYPES.includes(image.mimeType)) {
        res.status(400).json({ error: `Unsupported image type: ${image.mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}` });
        return;
      }

      const decodedSize = Buffer.byteLength(image.data, "base64");
      if (decodedSize > MAX_IMAGE_SIZE) {
        res.status(400).json({ error: `Image too large: ${(decodedSize / 1024 / 1024).toFixed(1)}MB exceeds the 10MB limit` });
        return;
      }
    }

    try {
      const sent = await sendPrompt(sessionId, message.trim(), image);
      if (!sent) {
        res.status(400).json({ error: "Could not send message — session may not be running" });
        return;
      }
    } catch (err) {
      // Catch the "remote worker mode" error from sendPrompt
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "POST",
      path: "/api/task-planner/:sessionId/message",
      ...toErrorFields(err),
      msg: "Failed to send task planner message",
    });
    res.status(500).json({ error: "Failed to send message" });
  }
});

// POST /api/task-planner/:sessionId/create-task — Create the task from the conversation
router.post("/:sessionId/create-task", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Task planner session not found" });
      return;
    }

    // Accept task data from the frontend (parsed from the AI output)
    const { title, description, priority, type, files, tabIds } = req.body as {
      title: string;
      description: string;
      priority: number;
      type: string;
      files?: string[];
      tabIds?: number[];
    };

    if (!title || !priority || !type) {
      res.status(400).json({ error: "title, priority, and type are required" });
      return;
    }

    // Verify tabIds belong to the user if provided
    let finalTabIds = tabIds;
    if (finalTabIds && finalTabIds.length > 0) {
      const userTabs = await getAllTabs(userId);
      const userTabIds = new Set(userTabs.map((t) => t.id));
      const unauthorized = finalTabIds.filter((id) => !userTabIds.has(id));
      if (unauthorized.length > 0) {
        res.status(403).json({ error: "Cannot assign task to tabs you do not own" });
        return;
      }
    } else {
      // Prefer the tab that was used to start the planning session
      if (session.tabIds && session.tabIds.length > 0) {
        finalTabIds = session.tabIds;
      } else {
        // Fallback to user's first tab
        const userTabs = await getAllTabs(userId);
        if (userTabs.length > 0) {
          finalTabIds = [userTabs[0].id];
        }
      }
    }

    const taskInput: CreateTaskInput = {
      title,
      description: description || "",
      priority: priority as 1 | 2 | 3 | 4,
      type: type as "feature" | "improvement" | "bug",
      files: files || [],
      origin: "user-assisted",
      tabIds: finalTabIds,
    };

    const task = await createTask(taskInput);
    broadcastToUser(userId, { type: "task-created", task });
    notifyTaskAvailable(); // wake any idle loop sessions immediately

    // Clean up the planner session
    try {
      await stopSession(sessionId);
      deleteSession(sessionId);
    } catch {
      // Non-fatal — session cleanup failure doesn't affect the created task
    }

    res.status(201).json(task);
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "POST",
      path: "/api/task-planner/:sessionId/create-task",
      ...toErrorFields(err),
      msg: "Failed to create task from planner",
    });
    res.status(500).json({ error: "Failed to create task" });
  }
});

// DELETE /api/task-planner/:sessionId — Cancel/close a task planner session
router.delete("/:sessionId", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Task planner session not found" });
      return;
    }

    await stopSession(sessionId);
    deleteSession(sessionId);

    res.status(204).send();
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "DELETE",
      path: "/api/task-planner/:sessionId",
      ...toErrorFields(err),
      msg: "Failed to delete task planner session",
    });
    res.status(500).json({ error: "Failed to close task planner" });
  }
});

// GET /api/task-planner/:sessionId/output — Get the conversation output
router.get("/:sessionId/output", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Task planner session not found" });
      return;
    }

    const output = getSessionOutput(sessionId);
    res.json({ entries: output || [] });
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "GET",
      path: "/api/task-planner/:sessionId/output",
      ...toErrorFields(err),
      msg: "Failed to get task planner output",
    });
    res.status(500).json({ error: "Failed to get output" });
  }
});

export default router;
