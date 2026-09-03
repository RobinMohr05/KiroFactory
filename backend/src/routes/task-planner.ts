import { Router, type Request, type Response } from "express";
import {
  createSession,
  startSession,
  stopSession,
  sendPrompt,
  getSession,
  getSessionOutput,
  deleteSession,
  getAllSessions,
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
import { buildPlannerBoardMcpServer } from "./task-planner-board-mcp.js";
import { PlannerSessionPool, type PooledRunner } from "../planner-session-pool.js";
import { KiroRunner } from "../agent/kiro-runner.js";
import { getDetectedModelIds } from "./models.js";
import { resolve } from "node:path";
import type { CreateTaskInput } from "../types.js";
import { recordError } from "../error-store.js";

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
 * System-managed model preference for AI Task Planner sessions.
 *
 * The planner is deliberately pinned to claude-sonnet-4.6 — the Claude Sonnet
 * tier just below sonnet-5 — to avoid the high-traffic congestion common on
 * sonnet-5. There's no runtime traffic/availability signal exposed by kiro-cli
 * or the ACP ModelInfo shape, so we simply pin the next-highest sonnet rather
 * than attempting sonnet-5 with runtime fallback.
 *
 * These are the literal kiro-cli model identifiers (with dots), in descending
 * preference order. This default is system-managed and NOT user-configurable.
 */
const PLANNER_MODEL_PREFERENCE = [
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
] as const;

/**
 * Resolve the planner session's model against a list of detected model IDs.
 *
 * Returns the highest-preference sonnet tier present in `availableIds`
 * (claude-sonnet-4.6, then 4.5, then 4), or `null` (Auto — let kiro-cli pick)
 * when none of them are available. Pure and synchronous so it can be unit
 * tested without spawning kiro-cli.
 */
export function resolvePlannerModel(availableIds: string[]): string | null {
  const available = new Set(availableIds);
  for (const modelId of PLANNER_MODEL_PREFERENCE) {
    if (available.has(modelId)) return modelId;
  }
  return null;
}

/**
 * Detect the available models and resolve the planner's system-managed model
 * from them. Logs which model was chosen. Never throws — a detection failure
 * yields an empty list, which resolves to `null` (Auto).
 */
export async function resolvePlannerModelFromDetection(): Promise<string | null> {
  const availableIds = await getDetectedModelIds();
  const chosen = resolvePlannerModel(availableIds);
  log.info("planner-model-resolved", {
    component: "task-planner",
    chosenModel: chosen ?? "auto",
    detectedCount: availableIds.length,
    msg: `Resolved AI Task Planner model to ${chosen ?? "auto (no preferred sonnet tier detected)"}`,
  });
  return chosen;
}

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
  const model = await resolvePlannerModelFromDetection();
  const runner = await KiroRunner.create({
    cwd: DEFAULT_POOL_CWD,
    model,
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
 *
 * NOTE ON QUESTION FORMATTING: the frontend renderer
 * (frontend/src/utils/renderPlannerMarkdown.ts) is the single source of truth
 * for how these questions are displayed as cards. The formatting guidance in
 * this prompt (each `**Qn — Title**:` header on its own line, preceded by a
 * blank line, with `Rec:` on its own line) is a SOFT, non-load-bearing hint
 * only — the renderer must not, and does not, rely on the model actually
 * following it. Do not treat this format as a contract the renderer depends on.
 */
const TASK_PLANNER_SYSTEM_PROMPT = `You are a Task Planner assistant. Your job is to help the user define a precise, actionable task through a structured interview — then produce a task description that an autonomous developer agent can execute without any follow-up questions.

## Critical context: who consumes the task you produce

The description you write will be given VERBATIM as the sole instruction to an autonomous developer agent. That agent:
- Runs single-shot, unattended, under a 15-minute timeout.
- Cannot ask follow-up questions — the description is ALL it gets.
- Is told not to scope-creep and must decide on its own whether "done" has been reached.
- Gets no conversation history — only the final task title + description.

If the description is vague, the agent will guess wrong or stall. Your job is to interview the user until you can write a description a competent engineer would execute correctly on the first try.

## The method — frontier-based interview

Model the task as a decision tree. Every decision branches into further decisions that depend on it. Work the tree in rounds:

1. The FRONTIER is every decision whose prerequisites are already settled — the questions you can ask now without guessing at answers you haven't heard yet.
2. Ask the entire frontier in one round. Number each question and provide your own recommended answer. Then STOP and WAIT for the user's answers before starting the next round.
3. Format each question like this — put the header on its own line, preceded by a blank line, and put \`Rec:\` on its own line (this keeps each question a visually distinct card):

   **Q1 — <title>**: <question body>

   Rec: <your recommended answer>

4. Each round, the user's answers reshape the tree: settled decisions push the frontier outward and unblock new questions. Recompute the frontier and ask the next round. A question that depends on an answer not yet given belongs to a LATER round.

Finding facts is your job when feasible — if you have repo-browsing tools available, look up file paths, function signatures, and architecture rather than asking the user for facts you could discover yourself. Decisions stay the user's — put each one to them and wait.

The interview is done when the frontier is empty: every branch visited, nothing left assumed.

## Starting the conversation

If the user's first message already states an idea or problem, skip greetings and go straight to your first frontier round. If they haven't said anything yet (session just opened), give a short, warm one-liner asking what they'd like to build or fix, then wait.

## Passivity check

If a round produces zero corrections — the user just says "yes" or "agreed" to every recommendation — don't treat that as confirmation you're done. Probe one level deeper on at least one question to verify actual engagement. A rubber-stamped task description is dangerous.

## When conversation can't resolve a question

Some decisions need something concrete to react to (a prototype, an experiment). When you hit one:
- Suggest splitting into a spike/exploration task + a follow-up implementation task.
- Or suggest the user create the task via the IDE where they can do exploratory coding first.
Don't keep rephrasing an unresolvable question — name it and offer the escape hatch.

## Convergence guard

If you've completed 3+ rounds without convergence (frontier keeps growing, scope unclear, user keeps changing direction), explicitly say so and suggest:
1. Splitting into multiple smaller tasks, or
2. Doing a spike task first to settle unknowns, or
3. Creating the task via the IDE for a more interactive workflow.

## Multiple tasks

If the user wants multiple tasks, grill the set together — ask questions that establish boundaries between tasks in the same round to avoid overlapping scope. Draft all of them at once for review.

When producing a batch of multiple tasks, decide per batch:
- **dependsOnBatchIndex** — if a task in the batch cannot start until another task in the same batch is done (e.g. task 2 modifies code that task 0 must create first), add \`"dependsOnBatchIndex": [0]\` (array of 0-based indices into the same output array) to the dependent task. Only use this for genuine sequential dependencies, not for loosely related work.
- **groupId** — if several tasks in the batch should be worked on the same branch/PR (parallelizable-but-related changes to the same area), give them the same string value for \`"groupId"\`. Omit for tasks that don't need grouping.

## Writing the final description

When the frontier is empty, draft the task(s). Write the description FOR the autonomous developer agent:
- Second-person imperative ("Implement...", "Add...", "Fix...")
- Include relevant file paths, function names, architectural context
- Explicit acceptance criteria the agent can self-verify (what should pass, what behavior should exist)
- Name what is NOT in scope so the agent doesn't wander
- Keep titles under 80 characters, action-oriented

Show the draft to the user. On confirmation, output the final task(s).

## Escape hatch

If the user's request is already unambiguous and narrow (e.g. they paste an exact error and file), skip most of the interview. The bar is "would the autonomous agent succeed unattended," not "did I ask N rounds."

## Output Format

When the user confirms the task(s), output EXACTLY this format (and nothing else after it).
ALWAYS output a JSON **array** — even for a single task, wrap it in \`[...]\`:

\`\`\`json:task
[
  {
    "title": "...",
    "description": "...",
    "priority": 1-4,
    "type": "feature|improvement|bug",
    "files": ["file1.ts", "file2.ts"],
    "dependsOnBatchIndex": [0],
    "dependsOnTaskId": [42],
    "groupId": "optional-shared-id"
  }
]
\`\`\`

- \`dependsOnBatchIndex\` (optional): 0-based indices into this same array for tasks that must be completed before this one.
- \`dependsOnTaskId\` (optional): array of real, already-existing task IDs discovered via the \`list_tasks\` tool. Use when a new task should depend on something already on the board. Do NOT guess task IDs — always look them up with \`list_tasks\` first.
- \`groupId\` (optional): shared string for tasks that should be worked on the same branch/PR.
- Omit all three fields when not needed.`;

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

// POST /api/task-planner/heartbeat — Presence signal: warm the pool while the
// user is active on the board, drain it promptly once they go idle.
router.post("/heartbeat", (req: Request, res: Response) => {
  const userId = getUserId(req);
  const { tabId, active } = req.body as { tabId?: number; active: boolean };
  const effectiveTabId = tabId ?? 0;

  // Pool requires a server-level KIRO_API_KEY — skip if not configured.
  if (!isPoolEnabled()) {
    res.status(202).json({ ok: true });
    return;
  }

  // Fire-and-forget in both directions: never block the caller, never surface
  // pool errors to the caller.
  if (active) {
    plannerPool.warm(effectiveTabId).catch((err) => {
      log.warn("heartbeat-warm-error", {
        component: "task-planner",
        tabId: effectiveTabId,
        userId,
        ...toErrorFields(err),
        msg: `Background heartbeat warm failed for tab ${effectiveTabId}`,
      });
    });
  } else {
    plannerPool.drainTab(effectiveTabId).catch((err) => {
      log.warn("heartbeat-drain-error", {
        component: "task-planner",
        tabId: effectiveTabId,
        userId,
        ...toErrorFields(err),
        msg: `Background heartbeat drain failed for tab ${effectiveTabId}`,
      });
    });
  }

  res.status(202).json({ ok: true });
});
router.post("/start", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { tabId } = req.body as { tabId?: number };

    // Enforce at most one Task Planner session per user at a time. A stray
    // duplicate can otherwise be created by a double-fire of this route
    // (e.g. a double-click on the "AI Planner" trigger, or — for the
    // still-unmerged React rewrite of this modal — StrictMode's dev-mode
    // double-mount). Planner sessions have no lasting value once superseded
    // (they're a short-lived planning chat, not a deliverable), so deleting
    // the old one outright is correct here — unlike a regular dev/loop
    // session, there's nothing to preserve.
    const stalePlanners = getAllSessions(userId).filter(
      (s) => s.name === "Task Planner" && s.status === "running"
    );
    for (const stale of stalePlanners) {
      deleteSession(stale.id);
    }

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

        // Build a board MCP server entry so the LLM can discover existing
        // tasks (list_tasks) and write dependency links (add_task_dependency).
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const boardMcp = buildPlannerBoardMcpServer({
          userId,
          tabId: tab.id,
          baseUrl,
        });
        if (!rawMcpServers) rawMcpServers = [];
        rawMcpServers.push(boardMcp);
      }
    }

    // Create a dedicated interactive session for this planning conversation.
    // forceLocal ensures the planner never triggers an ACA Job execution —
    // it only needs to chat and read files via MCP, never build/test/commit.
    //
    // The planner model is a system-managed default (claude-sonnet-4.6 when
    // available, falling back down the sonnet chain, else Auto) — it is NOT
    // user-configurable. This applies to the cold-start path here; warm pool
    // runners bake the same resolution in at spawn time (see createPoolRunner).
    const plannerModel = await resolvePlannerModelFromDetection();
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
      model: plannerModel ?? undefined,
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

    const { message, images: rawImages, image } = req.body as {
      message: string;
      images?: { data: string; mimeType: string }[];
      image?: { data: string; mimeType: string };
    };
    // Backward compat: accept legacy singular `image` field from app.js
    const images = rawImages ?? (image ? [image] : undefined);
    if (!message || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    // Validate images array if provided
    if (images) {
      if (!Array.isArray(images)) {
        res.status(400).json({ error: "images must be an array" });
        return;
      }

      const MAX_IMAGES = 3;
      if (images.length > MAX_IMAGES) {
        res.status(400).json({ error: `Too many images: ${images.length} exceeds the maximum of ${MAX_IMAGES}` });
        return;
      }

      const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

      for (let i = 0; i < images.length; i++) {
        const img = images[i];

        if (!img.data || !img.mimeType) {
          res.status(400).json({ error: `Image ${i + 1}: must include both 'data' (base64) and 'mimeType'` });
          return;
        }

        if (!ALLOWED_MIME_TYPES.includes(img.mimeType)) {
          res.status(400).json({ error: `Image ${i + 1}: unsupported type ${img.mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}` });
          return;
        }

        const decodedSize = Buffer.byteLength(img.data, "base64");
        if (decodedSize > MAX_IMAGE_SIZE) {
          res.status(400).json({ error: `Image ${i + 1}: too large (${(decodedSize / 1024 / 1024).toFixed(1)}MB exceeds the 10MB limit)` });
          return;
        }
      }
    }

    try {
      const sent = await sendPrompt(sessionId, message.trim(), images);
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

// POST /api/task-planner/:sessionId/create-task — Create task(s) from the conversation
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

    // ---------------------------------------------------------------------------
    // Determine batch items — accept either:
    //   1. { tasks: TaskBatchItem[] }   — new batch body
    //   2. { title, ... }               — existing single-object body (backward compat)
    // ---------------------------------------------------------------------------

    interface TaskBatchItem {
      title: string;
      description?: string;
      priority: number;
      type: string;
      files?: string[];
      tabIds?: number[];
      dependsOnBatchIndex?: number[];
      dependsOnTaskId?: number[];
      groupId?: string;
    }

    const body = req.body;
    let batchItems: TaskBatchItem[];

    if (body.tasks && Array.isArray(body.tasks)) {
      batchItems = body.tasks;
    } else if (body.title) {
      // Single-object backward compat — wrap as one-element batch
      batchItems = [body as TaskBatchItem];
    } else {
      res.status(400).json({ error: "Request body must be a task object or { tasks: [...] }" });
      return;
    }

    // Reject empty batch
    if (batchItems.length === 0) {
      res.status(400).json({ error: "At least one task is required" });
      return;
    }

    // Validate all items up front — reject the whole request on validation failure
    for (let i = 0; i < batchItems.length; i++) {
      const item = batchItems[i];
      if (!item.title || !item.priority || !item.type) {
        res.status(400).json({ error: `Task at index ${i} is missing required fields (title, priority, type)` });
        return;
      }
    }

    // ---------------------------------------------------------------------------
    // Topological sort based on dependsOnBatchIndex (Kahn's algorithm)
    // ---------------------------------------------------------------------------

    const n = batchItems.length;
    const inDegree = new Array(n).fill(0);
    const adjList: number[][] = Array.from({ length: n }, () => []);

    for (let i = 0; i < n; i++) {
      const deps = batchItems[i].dependsOnBatchIndex;
      if (deps) {
        if (!Array.isArray(deps)) {
          res.status(400).json({ error: `Task at index ${i} has invalid dependsOnBatchIndex (must be an array)` });
          return;
        }
        for (const dep of deps) {
          if (!Number.isInteger(dep) || dep < 0 || dep >= n || dep === i) {
            res.status(400).json({ error: `Task at index ${i} has invalid dependsOnBatchIndex ${dep} — must be an integer referencing another entry in the batch (not itself)` });
            return;
          }
          adjList[dep].push(i);
          inDegree[i]++;
        }
      }

      const taskIdDeps = batchItems[i].dependsOnTaskId;
      if (taskIdDeps) {
        if (!Array.isArray(taskIdDeps)) {
          res.status(400).json({ error: `Task at index ${i} has invalid dependsOnTaskId (must be an array)` });
          return;
        }
        for (const dep of taskIdDeps) {
          if (!Number.isInteger(dep) || dep <= 0) {
            res.status(400).json({ error: `Task at index ${i} has invalid dependsOnTaskId ${dep} — must be a positive integer` });
            return;
          }
        }
      }
    }

    const order: number[] = [];
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (inDegree[i] === 0) queue.push(i);
    }
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);
      for (const neighbor of adjList[node]) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) queue.push(neighbor);
      }
    }

    if (order.length !== n) {
      res.status(400).json({ error: "Cycle detected in dependsOnBatchIndex references" });
      return;
    }

    // ---------------------------------------------------------------------------
    // Resolve tabIds helper — fetch user's tabs once, not per batch item
    // ---------------------------------------------------------------------------

    const userTabs = await getAllTabs(userId);
    const userTabIds = new Set(userTabs.map((t) => t.id));

    const resolveTabIds = (item: TaskBatchItem): number[] => {
      if (item.tabIds && item.tabIds.length > 0) {
        const unauthorized = item.tabIds.filter((id) => !userTabIds.has(id));
        if (unauthorized.length > 0) {
          throw new Error("Cannot assign task to tabs you do not own");
        }
        return item.tabIds;
      }
      if (session.tabIds && session.tabIds.length > 0) {
        return session.tabIds;
      }
      if (userTabs.length > 0) return [userTabs[0].id];
      return [];
    };

    // ---------------------------------------------------------------------------
    // Create tasks in topological order
    // ---------------------------------------------------------------------------

    const createdTasks: Array<import("../types.js").Task> = [];
    const failedTasks: Array<{ task: TaskBatchItem; error: string }> = [];
    const batchIdMap: Map<number, number> = new Map(); // batchIndex -> real task ID

    for (const idx of order) {
      const item = batchItems[idx];
      try {
        const finalTabIds = resolveTabIds(item);

        // Resolve dependsOnBatchIndex to real IDs
        const dependsOn: number[] = [];
        if (item.dependsOnBatchIndex) {
          for (const depIdx of item.dependsOnBatchIndex) {
            const realId = batchIdMap.get(depIdx);
            if (realId === undefined) {
              throw new Error(`Dependency at batch index ${depIdx} was not created successfully`);
            }
            dependsOn.push(realId);
          }
        }
        // Include dependsOnTaskId (existing task IDs discovered via list_tasks)
        if (item.dependsOnTaskId) {
          for (const taskId of item.dependsOnTaskId) {
            dependsOn.push(taskId);
          }
        }

        const taskInput: CreateTaskInput = {
          title: item.title,
          description: item.description || "",
          priority: item.priority as 1 | 2 | 3 | 4,
          type: item.type as "feature" | "improvement" | "bug",
          files: item.files || [],
          origin: "user-assisted",
          tabIds: finalTabIds,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          groupId: item.groupId ?? null,
        };

        const task = await createTask(taskInput);
        createdTasks.push(task);
        batchIdMap.set(idx, task.id);

        broadcastToUser(userId, { type: "task-created", task });
        notifyTaskAvailable();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failedTasks.push({ task: item, error: errMsg });
        recordError({
          sessionId,
          sessionName: session.name || "Task Planner",
          agent: "task-planner",
          message: errMsg,
          context: `Failed to create batch item at index ${idx}`,
          taskTitle: item.title,
          userId,
          tabIds: session.tabIds,
        });
      }
    }

    // Only clean up the planner session on full success — partial failure
    // leaves the session open so the user can see failures in the modal.
    if (failedTasks.length === 0) {
      try {
        await stopSession(sessionId);
        deleteSession(sessionId);
      } catch {
        // Non-fatal — session cleanup failure doesn't affect the created tasks
      }
    }

    res.status(201).json({ created: createdTasks, failed: failedTasks });
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
