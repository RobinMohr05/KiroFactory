/**
 * Session Manager — Manages persistent ACP agent sessions.
 *
 * Each session spawns a KiroRunner that stays alive until manually stopped.
 * Output is buffered and broadcast via WebSocket to all connected clients.
 *
 * Sessions can run in two modes:
 * - Interactive: waits for manual prompts from the user
 * - Loop (autonomous): automatically claims tasks from the DB and executes them
 */

import { resolve } from "node:path";
import { KiroRunner } from "./agent/kiro-runner.js";
import type { SessionUpdateChunk } from "./agent/kiro-runner.js";
import { broadcastToUser } from "./websocket-handler.js";
import { sanitizeSessionForClient } from "./session-sanitize.js";
import { claimTask, resolveTask, resetTask, getAvailableTaskCount, waitForTaskAvailable, markTaskDone, findSiblingTasks, findSiblingTasksByGroupId } from "./agent/task-claimer.js";
import type { ClaimedTask } from "./agent/task-claimer.js";
import { buildDevPrompt, buildReviewPrompt } from "./agent/prompt-builder.js";
import { buildPersistentBranchName } from "./agent/repo-url-parser.js";
import { TabMcpConfig, DEFAULT_MCP_CONFIG, resolveGitProvider, type GitProvider } from "./types.js";
import {
  getAllSessionsFromDb,
  getRunningSessionsFromDb,
  insertSession,
  updateSessionStatus,
  updateSessionMeta,
  deleteSessionFromDb,
  isSessionOwnedByUser,
  reorderSessionsInDb,
  updateSessionPinInDb,
} from "./db/sessions.js";
import { getUserKiroApiKey, getUserById } from "./db/users.js";
import { getAllDecryptedCredentials, getDecryptedCredential } from "./db/credentials.js";
import { isDbAvailable } from "./db/connection.js";
import { getTaskAutoMergePrs, areAllGroupTasksDone } from "./db/tasks.js";
import { recordError } from "./error-store.js";
import { log, logSessionEvent, logWorkerEvent, toErrorFields } from "./logger.js";
import { getAgentTabs, getTabById } from "./db/tabs.js";
import { getAgentByName } from "./db/agents.js";
import { materializeAgentConfigIfMissing, encodeAgentConfigBase64 } from "./agent/agent-config-writer.js";
import { buildProxyServersConfig, type SessionCredentials } from "./mcp-proxy-config.js";
import {
  loadAcaConfig,
  startWorkerJob,
  stopWorkerJob,
  getWorkerJobStatus,
  isAcaModeEnabled,
  type AcaWorkerConfig,
  type AcaJobExecution,
  type McpProxySidecarConfig,
} from "./aca-worker-spawner.js";
import {
  setWorkerEventHandler,
  sendWorkerPrompt,
  sendWorkerStop,
  isWorkerConnected,
  type WorkerEventHandler,
} from "./worker-ws-handler.js";
import type {
  Session,
  OutputEntry,
  Activity,
  CreateSessionInput,
  UpdateSessionInput,
  McpServerConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_ENTRIES = 2000;
const DEFAULT_TIMEOUT = 0; // 0 = no timeout (runs forever)
const DEFAULT_CWD = resolve(import.meta.dirname, "../.."); // project root

// ---------------------------------------------------------------------------
// Worker mode detection (WORKER_MODE env var or auto-detect from ACA config)
// ---------------------------------------------------------------------------

const acaConfig = loadAcaConfig();

/**
 * WORKER_MODE controls how sessions spawn agent processes:
 * - "local"  — Spawn kiro-cli as a local child process (default for development)
 * - "remote" — Launch ACA Job, worker connects back via internal WebSocket
 *
 * If WORKER_MODE is not set, auto-detect based on ACA config presence.
 */
const WORKER_MODE: "local" | "remote" = (() => {
  const envVal = process.env.WORKER_MODE?.toLowerCase();
  if (envVal === "remote") return "remote";
  if (envVal === "local") return "local";
  // Auto-detect: if ACA env vars are configured, use remote; otherwise local
  return acaConfig !== null ? "remote" : "local";
})();

const ACA_MODE = WORKER_MODE === "remote";

/**
 * Absolute path the ACA worker container clones the repository into
 * (WORKSPACE in worker/worker.js).
 *
 * Prompts for remote workers must use this, not `meta.cwd`: the orchestrator's
 * own cwd is /app inside its container, and telling the agent that /app is the
 * working directory sends it exploring the orchestrator's image layout instead
 * of the checked-out repository.
 */
const ACA_WORKSPACE_PATH = "/workspace";

log.info("worker-mode", {
  component: "session-manager",
  mode: ACA_MODE ? "remote" : "local",
  msg: ACA_MODE
    ? "Remote worker mode — sessions spawn as Azure Container Apps Jobs"
    : "Local worker mode — sessions spawn kiro-cli as child processes",
});

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

const sessions = new Map<number, ManagedSession>();

interface ManagedSession {
  meta: Session;
  runner: KiroRunner | null;
  abortController: AbortController | null;
  /** Buffer for accumulating agent_message_chunk text before emitting as a line */
  messageBuffer: string;
  /** Timer to flush partial lines after a brief pause */
  messageFlushTimer: ReturnType<typeof setTimeout> | null;
  /** Tracks the last tool label to suppress consecutive duplicate output lines */
  lastToolLabel: string;
  /** Count of consecutive identical tool calls (for dedup display) */
  lastToolCount: number;
  /** ACA Job execution name (set when running in ACA mode) */
  acaExecutionName: string | null;
  /** Resolver for awaiting prompt completion from ACA worker */
  acaPromptResolver: ((result: unknown) => void) | null;
  /** Rejecter for awaiting prompt completion from ACA worker */
  acaPromptRejecter: ((err: Error) => void) | null;
  /** Cumulative credits consumed this session (tracked via _kiro.dev/metadata) */
  totalCreditsUsed: number;
  /** Verdict reported by the agent via report_verdict MCP tool this turn (local mode only) */
  turnVerdict: string | null;
  /** Tracks toolCallId for the report_verdict tool to capture verdict from tool_call_update */
  verdictToolCallId: string | null;
  /**
   * Pre-created KiroRunner from the warm session pool.
   * If set before startSession() is called, runSession() will use this runner
   * instead of creating a new one. Consumed (set to null) once used.
   */
  pendingRunner: KiroRunner | null;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Pending persist timers keyed by session ID.
 * Debounces rapid state changes into a single DB write per session.
 */
const pendingPersists = new Map<number, ReturnType<typeof setTimeout>>();
const PERSIST_DEBOUNCE_MS = 2000;

/**
 * Schedule a debounced persist for a single session.
 * If called again within PERSIST_DEBOUNCE_MS for the same session, the timer
 * resets — so rapid mutations (status, activity, taskId) collapse into one write.
 */
function persistSession(sessionId: number): void {
  if (!isDbAvailable()) return;

  // Clear any pending timer for this session
  const existing = pendingPersists.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingPersists.delete(sessionId);
    const session = sessions.get(sessionId);
    if (!session) return;
    updateSessionMeta(session.meta).catch(() => {
      // DB write failed silently — will retry on next state change
    });
  }, PERSIST_DEBOUNCE_MS);

  pendingPersists.set(sessionId, timer);
}



/**
 * Initialize sessions from the database on server startup.
 * Sessions that were "running" before the restart are automatically re-started.
 * This handles the case where `tsx watch` restarts the server mid-agent-execution.
 *
 * Requires the DB to be connected before calling.
 */
export async function initSessions(): Promise<void> {
  let persisted: Session[] = [];

  if (isDbAvailable()) {
    try {
      const dbSessions = await getAllSessionsFromDb();
      persisted = dbSessions.map((s) => {
        const wasRunning = s.status === "running";
        return {
          ...s,
          status: wasRunning ? ("stopped" as const) : s.status,
          currentTaskId: undefined,
          output: [],
          currentActivity: undefined,
          __wasRunning: wasRunning,
        } as Session & { __wasRunning?: boolean };
      });
    } catch (err) {
      log.warn("session-restore-failed", {
        component: "session-manager",
        msg: "Failed to load persisted sessions from DB",
        ...toErrorFields(err),
      });
    }
  }

  const toRestart: number[] = [];

  for (const meta of persisted) {
    // If the session was running, keep the status as "stopped" for now
    // (loadSessions already resets running → stopped) but schedule a restart.
    const wasRunning = meta.status === "stopped" && meta.startedAt;
    sessions.set(meta.id, {
      meta,
      runner: null,
      abortController: null,
      messageBuffer: "",
      messageFlushTimer: null,
      lastToolLabel: "",
      lastToolCount: 0,
      acaExecutionName: null,
      acaPromptResolver: null,
      acaPromptRejecter: null,
      totalCreditsUsed: 0,
      turnVerdict: null,
      verdictToolCallId: null,
      pendingRunner: null,
    });

    // Check if this session should auto-restart.
    // We detect this by checking if sessions.json had it as "running" before loadSessions reset it.
    // Since loadSessions() already set it to "stopped", we need a different signal.
    // We'll use a flag from loadSessions instead.
    if ((meta as any).__wasRunning) {
      toRestart.push(meta.id);
      delete (meta as any).__wasRunning;
    }
  }

  if (persisted.length > 0) {
    log.info("sessions-restored", {
      component: "session-manager",
      count: persisted.length,
      msg: `Restored ${persisted.length} session(s) from database`,
    });
  }

  // Auto-restart sessions that were running before the server restarted.
  // Use a short delay to allow the rest of the server to finish initializing.
  if (toRestart.length > 0) {
    log.info("sessions-auto-restarting", {
      component: "session-manager",
      count: toRestart.length,
      msg: `Auto-restarting ${toRestart.length} session(s) that were active before restart`,
    });
    setTimeout(async () => {
      // Reset any orphaned in-progress tasks (their kiro-cli process is dead)
      try {
        const { resetOrphanedTasks } = await import("./agent/task-claimer.js");
        const resetCount = await resetOrphanedTasks();
        if (resetCount > 0) {
          log.info("orphaned-tasks-reset", {
            component: "session-manager",
            count: resetCount,
            msg: `Reset ${resetCount} orphaned in-progress task(s) back to "todo"`,
          });
        }
      } catch (err) {
        log.warn("orphaned-tasks-reset-failed", {
          component: "session-manager",
          msg: "Could not reset orphaned in-progress tasks",
          ...toErrorFields(err),
        });
      }

      for (const id of toRestart) {
        startSession(id).catch((err) => {
          log.error("session-auto-restart-failed", {
            component: "session-manager",
            sessionId: id,
            ...toErrorFields(err),
          });
        });
      }
    }, 2000);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function appendOutput(session: ManagedSession, entry: OutputEntry): void {
  session.meta.output.push(entry);
  if (session.meta.output.length > MAX_OUTPUT_ENTRIES) {
    session.meta.output = session.meta.output.slice(-MAX_OUTPUT_ENTRIES);
  }
  broadcastToUser(session.meta.userId, { type: "session-output", sessionId: session.meta.id, entry });
}

/**
 * Flush accumulated agent_message_chunk text as a single output entry.
 * This prevents the same sentence from being split across many timestamped lines.
 */
function flushMessageBuffer(session: ManagedSession): void {
  if (session.messageFlushTimer) {
    clearTimeout(session.messageFlushTimer);
    session.messageFlushTimer = null;
  }
  if (session.messageBuffer.length === 0) return;

  const text = session.messageBuffer;
  session.messageBuffer = "";

  appendOutput(session, {
    timestamp: now(),
    stream: "stdout",
    text,
  });
}

/**
 * Buffer incoming agent_message_chunk text and flush on newlines or after a delay.
 * Chunks are accumulated until a newline is seen or 300ms of inactivity passes,
 * so complete sentences appear as single log lines.
 */
function bufferAgentMessage(session: ManagedSession, text: string): void {
  session.messageBuffer += text;

  // Clear any pending flush timer
  if (session.messageFlushTimer) {
    clearTimeout(session.messageFlushTimer);
    session.messageFlushTimer = null;
  }

  // Flush complete lines immediately (split on newlines)
  const lines = session.messageBuffer.split("\n");
  if (lines.length > 1) {
    // All lines except the last are complete — emit them
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (line.length > 0) {
        appendOutput(session, {
          timestamp: now(),
          stream: "stdout",
          text: line,
        });
      }
    }
    // Keep the remainder (text after the last newline) in the buffer
    session.messageBuffer = lines[lines.length - 1];
  }

  // If there's still buffered text without a newline, set a flush timer
  if (session.messageBuffer.length > 0) {
    session.messageFlushTimer = setTimeout(() => {
      flushMessageBuffer(session);
    }, 300);
  }
}

function setActivity(session: ManagedSession, activity: Activity): void {
  session.meta.currentActivity = activity;
  broadcastToUser(session.meta.userId, { type: "session-activity", sessionId: session.meta.id, activity });
}

function setStatus(session: ManagedSession, status: Session["status"]): void {
  session.meta.status = status;
  broadcastToUser(session.meta.userId, { type: "session-updated", session: sanitizeSessionForClient(session.meta) });
  persistSession(session.meta.id);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fallback id space used only when the DB is unavailable at session-creation
 * time (so no IDENTITY value can be assigned). Negative and decrementing so
 * these never collide with real, DB-assigned ids. A session created this way
 * simply won't survive a server restart — same limitation as before the
 * sessions table existed at all.
 */
let localOnlyIdCounter = 0;
function nextLocalOnlyId(): number {
  localOnlyIdCounter -= 1;
  return localOnlyIdCounter;
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const isAgentless = !input.agent;
  const meta: Session = {
    id: 0, // placeholder — replaced below once the real id is known
    name: input.name,
    agent: input.agent || "",
    status: "stopped",
    prompt: input.prompt || "",
    interactive: isAgentless ? true : (input.interactive !== false),
    loop: isAgentless ? false : (input.loop === true),
    runs: isAgentless ? 0 : (input.runs ?? 0),
    intervalSeconds: input.intervalSeconds ?? 10,
    cwd: input.cwd || DEFAULT_CWD,
    timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT,
    model: input.model,
    mcpServers: input.mcpServers,
    mcpConfigOverride: input.mcpConfigOverride ?? undefined,
    rawMcpServers: input.rawMcpServers,
    tabIds: input.tabIds,
    userId: input.userId ?? 0,
    createdAt: now(),
    output: [],
    pinned: input.pinned === true,
    isPermanent: input.isPermanent === true,
    sortOrder: 0, // placeholder — calculated below
    forceLocal: input.forceLocal === true,
  };

  // Calculate sortOrder: place new session at end of appropriate group
  const isPinned = meta.pinned;
  const userSessions = Array.from(sessions.values())
    .filter((s) => s.meta.userId === meta.userId && s.meta.pinned === isPinned);
  const maxOrder = userSessions.length > 0
    ? Math.max(...userSessions.map((s) => s.meta.sortOrder ?? 0))
    : -1;
  meta.sortOrder = maxOrder + 1;

  // The session id is assigned by the database (IDENTITY column), so it must
  // be known before the session can be registered anywhere.
  if (isDbAvailable()) {
    try {
      meta.id = await insertSession(meta);
    } catch (err) {
      log.warn("session-db-insert-failed", {
        component: "session-manager",
        ...toErrorFields(err),
      });
      meta.id = nextLocalOnlyId();
    }
  } else {
    meta.id = nextLocalOnlyId();
  }

  const session: ManagedSession = {
    meta,
    runner: null,
    abortController: null,
    messageBuffer: "",
    messageFlushTimer: null,
    lastToolLabel: "",
    lastToolCount: 0,
    acaExecutionName: null,
    acaPromptResolver: null,
    acaPromptRejecter: null,
    totalCreditsUsed: 0,
    turnVerdict: null,
    verdictToolCallId: null,
    pendingRunner: null,
  };

  sessions.set(meta.id, session);
  broadcastToUser(session.meta.userId, { type: "session-created", session: sanitizeSessionForClient(session.meta) });

  // Structured log for Azure Monitor
  logSessionEvent("session-created", meta.id, { agent: meta.agent, name: meta.name });

  return session.meta;
}

export function getSession(id: number): Session | undefined {
  return sessions.get(id)?.meta;
}

export function getAllSessions(userId?: number): Session[] {
  return Array.from(sessions.values())
    .filter((s) => userId === undefined || s.meta.userId === userId)
    .sort((a, b) => {
      // pinned DESC, then sortOrder ASC
      if (a.meta.pinned !== b.meta.pinned) return a.meta.pinned ? -1 : 1;
      return (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0);
    })
    .map((s) => ({
    ...sanitizeSessionForClient(s.meta),
    // Don't include full output in list endpoint — too large
    output: [],
  }));
}

export function getSessionOutput(id: number): OutputEntry[] {
  const session = sessions.get(id);
  if (!session) return [];
  return session.meta.output;
}

export function deleteSession(id: number): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.meta.isPermanent) return false; // permanent sessions cannot be deleted

  // Stop first if running
  if (session.meta.status === "running") {
    stopSession(id);
  }

  sessions.delete(id);
  broadcastToUser(session.meta.userId, { type: "session-deleted", sessionId: id });

  // Also delete from DB if available
  if (isDbAvailable()) {
    deleteSessionFromDb(id).catch((err) => {
      log.warn("session-db-delete-failed", {
        component: "session-manager",
        sessionId: id,
        ...toErrorFields(err),
      });
    });
  }

  return true;
}

export function updateSessionTabs(id: number, tabIds: number[]): boolean {
  const session = sessions.get(id);
  if (!session) return false;

  session.meta.tabIds = tabIds.length > 0 ? tabIds : undefined;
  broadcastToUser(session.meta.userId, { type: "session-updated", session: sanitizeSessionForClient(session.meta) });
  persistSession(id);

  logSessionEvent("session-tabs-updated", id, { tabIds });
  return true;
}

/**
 * Reorder sessions by setting sort_order based on array position.
 * Persists to DB and broadcasts updates.
 */
export function reorderSessions(sessionIds: number[], userId: number): boolean {
  // Verify all sessions exist and belong to the user
  for (const id of sessionIds) {
    const s = sessions.get(id);
    if (!s || s.meta.userId !== userId) return false;
  }

  // Update sort_order in memory
  for (let i = 0; i < sessionIds.length; i++) {
    const s = sessions.get(sessionIds[i]);
    if (s) s.meta.sortOrder = i;
  }

  // Persist to DB
  if (isDbAvailable()) {
    reorderSessionsInDb(sessionIds, userId).catch((err) => {
      log.warn("session-reorder-db-failed", {
        component: "session-manager",
        ...toErrorFields(err),
      });
    });
  }

  // Broadcast a full session list refresh to the user
  broadcastToUser(userId, { type: "sessions-reordered", sessions: getAllSessions(userId) });
  return true;
}

/**
 * Pin or unpin a session. When pinning, move to bottom of pinned group.
 * When unpinning, move to top of unpinned group.
 */
export function pinSession(id: number, pinned: boolean): boolean {
  const session = sessions.get(id);
  if (!session) return false;

  // Prevent unpinning a permanent session (e.g., the auto-created Chat session)
  if (!pinned && session.meta.isPermanent) return false;

  const userId = session.meta.userId;
  const allUserSessions = Array.from(sessions.values())
    .filter((s) => s.meta.userId === userId)
    .sort((a, b) => {
      if (a.meta.pinned !== b.meta.pinned) return a.meta.pinned ? -1 : 1;
      return (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0);
    });

  session.meta.pinned = pinned;

  if (pinned) {
    // Move to bottom of pinned group
    const pinnedSessions = allUserSessions.filter((s) => s.meta.pinned && s.meta.id !== id);
    const maxPinnedOrder = pinnedSessions.length > 0
      ? Math.max(...pinnedSessions.map((s) => s.meta.sortOrder ?? 0))
      : -1;
    session.meta.sortOrder = maxPinnedOrder + 1;
  } else {
    // Move to top of unpinned group (sort_order = 0, shift others up)
    const unpinnedSessions = allUserSessions.filter((s) => !s.meta.pinned && s.meta.id !== id);
    session.meta.sortOrder = 0;
    // Shift existing unpinned sessions down by 1
    for (const s of unpinnedSessions) {
      s.meta.sortOrder = (s.meta.sortOrder ?? 0) + 1;
    }
  }

  // Persist
  if (isDbAvailable()) {
    updateSessionPinInDb(id, pinned, session.meta.sortOrder).catch((err) => {
      log.warn("session-pin-db-failed", {
        component: "session-manager",
        ...toErrorFields(err),
      });
    });
    // Also persist shifted sort orders for unpinned sessions
    if (!pinned) {
      const unpinnedSessions = Array.from(sessions.values())
        .filter((s) => s.meta.userId === userId && !s.meta.pinned && s.meta.id !== id);
      for (const s of unpinnedSessions) {
        persistSession(s.meta.id);
      }
    }
  }

  // Broadcast a full session list refresh so all clients get updated sort orders
  broadcastToUser(userId, { type: "sessions-reordered", sessions: getAllSessions(userId) });
  logSessionEvent("session-pin-changed", id, { pinned });
  return true;
}

/**
 * Update editable session fields. `agent` and internal/lifecycle fields are excluded.
 * Returns `{ success: true }` on success, `{ success: false, reason: "running" }` if the
 * session is currently running, or `null` if the session doesn't exist.
 */
export function updateSessionFields(
  id: number,
  updates: UpdateSessionInput
): { success: true } | { success: false; reason: string } | null {
  const session = sessions.get(id);
  if (!session) return null;

  if (session.meta.status === "running") {
    return { success: false, reason: "running" };
  }

  // Validate name is non-empty if provided (guard against null and non-string)
  if (updates.name !== undefined) {
    if (typeof updates.name !== "string" || !updates.name.trim()) {
      return { success: false, reason: "name cannot be empty" };
    }
  }

  // Whitelist of allowed fields — ignore anything else (including `agent`)
  if (updates.name !== undefined) session.meta.name = updates.name;
  if (updates.prompt !== undefined) session.meta.prompt = updates.prompt || "";
  if (updates.cwd !== undefined) session.meta.cwd = updates.cwd || DEFAULT_CWD;
  if (updates.model !== undefined) session.meta.model = updates.model || undefined;
  if (updates.timeoutSeconds !== undefined) session.meta.timeoutSeconds = updates.timeoutSeconds;
  if (updates.interactive !== undefined) session.meta.interactive = updates.interactive;
  if (updates.loop !== undefined) session.meta.loop = updates.loop;
  if (updates.runs !== undefined) session.meta.runs = updates.runs;
  if (updates.intervalSeconds !== undefined) session.meta.intervalSeconds = updates.intervalSeconds;
  if (updates.mcpServers !== undefined) session.meta.mcpServers = updates.mcpServers?.length ? updates.mcpServers : undefined;
  if (updates.mcpConfigOverride !== undefined) session.meta.mcpConfigOverride = updates.mcpConfigOverride;
  if (updates.tabIds !== undefined) session.meta.tabIds = updates.tabIds?.length ? updates.tabIds : undefined;

  broadcastToUser(session.meta.userId, { type: "session-updated", session: sanitizeSessionForClient(session.meta) });
  persistSession(id);

  logSessionEvent("session-fields-updated", id, { updatedKeys: Object.keys(updates) });
  return { success: true };
}

/**
 * Inject a pre-created KiroRunner into a session before starting it.
 * Used by the planner session pool to provide a warm runner so startSession()
 * skips the cold spawn. The injected runner will have newSession(cwd) called
 * on it during runSession() to reset it to the correct workspace.
 *
 * Must be called AFTER createSession() and BEFORE startSession().
 */
export function injectPendingRunner(sessionId: number, runner: KiroRunner): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.meta.status === "running") return false;
  session.pendingRunner = runner;
  return true;
}

export async function startSession(id: number): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.meta.status === "running") return true; // already running

  session.meta.output = [];
  session.meta.startedAt = now();
  session.totalCreditsUsed = 0;
  session.meta.totalCreditsUsed = 0;
  setStatus(session, "running");
  setActivity(session, { type: "working", detail: "Starting ACP session..." });
  logSessionEvent("session-started", id, { agent: session.meta.agent, name: session.meta.name, mode: ACA_MODE ? "remote" : "local" });

  appendOutput(session, {
    timestamp: now(),
    stream: "system",
    text: ACA_MODE && !session.meta.forceLocal
      ? session.meta.agent
        ? `Starting ACA worker for agent "${session.meta.agent}"...`
        : `Starting ACA worker (no agent)...`
      : session.meta.agent
        ? `Starting agent "${session.meta.agent}" in ${session.meta.cwd}...`
        : `Starting interactive session in ${session.meta.cwd}...`,
  });

  // Spawn async — don't block the caller
  // forceLocal sessions (e.g. task planner) always use the local KiroRunner
  // child process, even when the global worker mode is "remote" (ACA_MODE).
  const useLocal = session.meta.forceLocal || !ACA_MODE;
  const launcher = useLocal ? runSession(session) : runSessionAca(session);
  launcher.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    appendOutput(session, { timestamp: now(), stream: "stderr", text: `Fatal: ${msg}` });
    setStatus(session, "error");
    setActivity(session, { type: "idle" });

    logSessionEvent("session-error", session.meta.id, {
      agent: session.meta.agent,
      name: session.meta.name,
      mode: ACA_MODE ? "remote" : "local",
      taskId: session.meta.currentTaskId,
      ...toErrorFields(err),
    });

    // Record the error for the UI
    recordError({
      sessionId: session.meta.id,
      sessionName: session.meta.name,
      agent: session.meta.agent,
      message: msg,
      context: "Fatal error during session startup/execution",
      taskId: session.meta.currentTaskId,
      taskTitle: undefined,
      userId: session.meta.userId,
    });
  });

  return true;
}

export async function stopSession(id: number): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.meta.status !== "running") return true;

  // Signal abort
  session.abortController?.abort();

  // Flush any remaining buffered agent message text
  flushMessageBuffer(session);

  // ACA mode: send stop to worker + cancel the ACA job
  if (ACA_MODE && session.acaExecutionName) {
    // Send stop signal to worker via WebSocket (triggers graceful shutdown)
    sendWorkerStop(id);

    // Cancel the ACA job execution via Azure API
    if (acaConfig) {
      stopWorkerJob(acaConfig, session.acaExecutionName).catch((err) => {
        console.warn(`[session-manager] Failed to stop ACA job ${session.acaExecutionName}:`, err);
      });
    }
    session.acaExecutionName = null;

    // Reject any pending prompt awaiter
    if (session.acaPromptRejecter) {
      session.acaPromptRejecter(new Error("Session stopped by user"));
      session.acaPromptResolver = null;
      session.acaPromptRejecter = null;
    }
  }

  // Local mode: close the KiroRunner
  if (session.runner) {
    try {
      await session.runner.close();
    } catch {
      /* best effort */
    }
    session.runner = null;
  }

  appendOutput(session, { timestamp: now(), stream: "system", text: "Session stopped by user." });
  logSessionEvent("session-stopped", id, { agent: session.meta.agent, name: session.meta.name });
  setStatus(session, "stopped");
  setActivity(session, { type: "idle" });
  return true;
}

export async function sendPrompt(id: number, text: string, image?: { data: string; mimeType: string }): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.meta.status !== "running") return false;
  if (!session.meta.interactive) return false;

  // Must have either a local runner or a connected ACA worker
  const hasLocalRunner = !!session.runner;
  const hasAcaWorker = ACA_MODE && isWorkerConnected(id);
  if (!hasLocalRunner && !hasAcaWorker) return false;

  // Image attachments are only supported in local worker mode
  if (image && hasAcaWorker) {
    throw new Error("Image attachments are not supported for sessions running in remote worker mode");
  }

  appendOutput(session, { timestamp: now(), stream: "system", text: `▶ ${text}` });
  setActivity(session, { type: "working", detail: "Processing prompt..." });

  // Run prompt in background
  const promptFn = hasAcaWorker
    ? streamPromptAca(session, text)
    : streamPrompt(session, text, image);

  promptFn.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    appendOutput(session, { timestamp: now(), stream: "stderr", text: `Prompt error: ${msg}` });
    setActivity(session, { type: "idle" });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Internal: session execution loop
// ---------------------------------------------------------------------------

async function runSession(managed: ManagedSession): Promise<void> {
  const { meta } = managed;
  managed.abortController = new AbortController();
  const { signal } = managed.abortController;

  try {
    // Decrypt the user's Kiro API key at runtime (only held for subprocess setup)
    let kiroApiKey: string | undefined;
    if (meta.userId) {
      try {
        const key = await getUserKiroApiKey(meta.userId);
        if (key) kiroApiKey = key;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `Warning: Could not retrieve Kiro API key for user ${meta.userId}: ${msg}`,
        });
        // Continue without per-user key — KiroRunner will fall back to process.env.KIRO_API_KEY
      }
    }

    // Materialize the DB-configured agent (prompt/tools/allowedTools/resources)
    // into .kiro/agents/<name>.json in the session's workspace, so kiro-cli
    // actually uses it. A repo-committed agent file of the same name always
    // wins — this only fills in the gap when none exists.
    if (meta.agent) {
      try {
        const agentRecord = await getAgentByName(meta.agent);
        if (agentRecord) {
          const wrote = materializeAgentConfigIfMissing(agentRecord, meta.cwd);
          if (wrote) {
            appendOutput(managed, {
              timestamp: now(),
              stream: "system",
              text: `Materialized .kiro/agents/${meta.agent}.json from agent configuration.`,
            });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `Warning: could not materialize agent config for "${meta.agent}": ${msg}`,
        });
        // Non-fatal — kiro-cli falls back to its own agent resolution.
      }
    }

    // Create the KiroRunner (kiroApiKey is passed to env and used only during spawn)
    // If a pre-warmed runner was injected from the session pool, use it (calling
    // newSession to reset to the correct cwd) instead of cold-spawning a new one.
    if (managed.pendingRunner) {
      managed.runner = managed.pendingRunner;
      managed.pendingRunner = null;
      try {
        await managed.runner.newSession(meta.cwd);
      } catch (err) {
        // If newSession fails on the pooled runner, fall through to cold-create
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `Warm runner newSession failed (${msg}) — falling back to cold start.`,
        });
        try { await managed.runner.close(); } catch { /* best effort */ }
        managed.runner = null;
      }
    }

    if (!managed.runner) {
      managed.runner = await KiroRunner.create({
        agent: meta.agent || undefined,
        cwd: meta.cwd,
        model: meta.model ?? null,
        mcpServers: meta.mcpServers?.map((s) => ({
          name: s.name,
          command: s.command,
          args: s.args,
          env: s.env,
        })),
        rawMcpServers: meta.rawMcpServers,
        kiroApiKey,
      });
    }

    // Clear decrypted key from local scope — no longer needed
    kiroApiKey = undefined;

    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `ACP session established (PID: ${managed.runner.pid})`,
    });

    if (meta.loop) {
      // ─── Autonomous loop mode — claims/resolves tasks through the pipeline ───
      const stages = await getAgentStageStates(meta.agent);
      if (!stages.requiresTask) {
        // Standalone mode: repeat the session prompt, no task queue
        await runStandaloneLoopLocal(managed, signal);
      } else {
        await runLoopMode(managed, signal);
      }
    } else {
      // ─── Interactive mode (original behavior) ───
      // Send initial prompt
      if (meta.prompt.trim()) {
        await streamPrompt(managed, meta.prompt);
      }

      // Session stays alive — just monitor the process
      // The runner remains open for follow-up prompts until stopped
      setActivity(managed, { type: "idle", detail: "Waiting for prompts..." });

      // Keep alive: periodically check if process is still running
      while (!signal.aborted && managed.runner?.isAlive) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // If we got here without abort, the process died unexpectedly
    if (!signal.aborted) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: "Agent process exited unexpectedly.",
      });
      setStatus(managed, "error");
      setActivity(managed, { type: "idle" });
    }
  } catch (err) {
    if (signal.aborted) return; // expected during stop
    throw err;
  } finally {
    managed.runner = null;
    managed.abortController = null;
  }
}

// ---------------------------------------------------------------------------
// Loop mode: auto-claim tasks and execute them
// ---------------------------------------------------------------------------

/**
 * Stage states for a given agent, used to parameterize the task lifecycle.
 * Defaults match the original developer-agent pipeline: todo → in-progress → developed.
 */
interface AgentStageStates {
  claimState: string;
  workingState: string;
  resolveState: string;
  /** "editor" (implements changes) or "inspector" (reviews/QAs, never edits). Determines which turn prompt is built. */
  kind: "editor" | "inspector";
  /** Whether this agent requires a task to run (false = standalone prompt loop). */
  requiresTask: boolean;
}

const DEFAULT_STAGE_STATES: AgentStageStates = {
  claimState: "todo",
  workingState: "in-progress",
  resolveState: "developed",
  kind: "editor",
  requiresTask: true,
};

/**
 * Look up the agent's configured stage states (and kind) from the DB.
 * Falls back to the default developer pipeline if the agent is not found
 * or has no stage states configured.
 */
async function getAgentStageStates(agentName: string): Promise<AgentStageStates> {
  if (!agentName) return DEFAULT_STAGE_STATES;
  try {
    const agent = await getAgentByName(agentName);
    if (!agent) return DEFAULT_STAGE_STATES;
    return {
      claimState: agent.claimState,
      workingState: agent.workingState,
      resolveState: agent.resolveState,
      kind: agent.kind,
      requiresTask: agent.requiresTask,
    };
  } catch {
    return DEFAULT_STAGE_STATES;
  }
}

/**
 * Build the correct turn prompt for the given task, based on the agent's kind.
 * Inspector agents (code-reviewer-agent, qa-improvement-agent, ...) get a
 * read-only review/QA prompt; editor agents (developer-agent, ...) get the
 * implementation prompt. Without this branch, every agent received the
 * implementation prompt regardless of kind — see buildReviewPrompt's doc
 * comment for the bug this fixes.
 */
function buildTurnPrompt(kind: "editor" | "inspector", task: ClaimedTask, cwd: string, autoMergePrs?: boolean): string {
  return kind === "inspector" ? buildReviewPrompt(task, cwd, autoMergePrs) : buildDevPrompt(task, cwd);
}

async function runLoopMode(
  managed: ManagedSession,
  signal: AbortSignal
): Promise<void> {
  const { meta } = managed;
  let iteration = 0;
  const maxRuns = meta.runs; // 0 = endless

  // Look up the agent's stage states once per loop start
  const stages = await getAgentStageStates(meta.agent);

  // Task-claiming tab filter: a session with no tabs assigned claims from
  // ANY tab. A session assigned to specific tabs only claims from those.
  const effectiveTabIds: number[] | undefined = meta.tabIds;

  const runsLabel = maxRuns === 0 ? "endless" : `${maxRuns} run(s)`;
  appendOutput(managed, {
    timestamp: now(),
    stream: "system",
    text: `Autonomous loop started (${runsLabel}, interval: ${meta.intervalSeconds}s)`,
  });

  while (!signal.aborted && managed.runner?.isAlive) {
    // Check if we've reached the run limit
    if (maxRuns > 0 && iteration >= maxRuns) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `All ${maxRuns} run(s) completed. Stopping.`,
      });
      setStatus(managed, "completed");
      setActivity(managed, { type: "completed", detail: `${maxRuns} run(s) finished` });
      return;
    }

    // Wait until a task is available (event-driven — no DB poll while idle)
    const todoCount = await getAvailableTaskCount(effectiveTabIds, stages.claimState);

    if (todoCount === 0) {
      setActivity(managed, {
        type: "idle",
        detail: "No tasks available. Waiting for new tasks...",
      });

      // Park here until a task is created/reset or the session is stopped.
      // waitForTaskAvailable does a single DB check, then suspends on an
      // in-process event — zero DB queries during the wait.
      await waitForTaskAvailable(effectiveTabIds, stages.claimState, signal);
      continue;
    }

    iteration++;

    // Claim the next task
    setActivity(managed, { type: "working", detail: "Claiming next task..." });

    const progressLabel = maxRuns > 0 ? `${iteration}/${maxRuns}` : `#${iteration}`;
    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `── Run ${progressLabel} ── ${todoCount} task(s) available`,
    });

    const task = await claimTask(undefined, effectiveTabIds, stages.claimState, stages.workingState);
    if (!task) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: "Failed to claim task (race condition or empty queue).",
      });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
      continue;
    }

    // Track current task
    meta.currentTaskId = task.id;
    broadcastToUser(meta.userId, { type: "session-updated", session: sanitizeSessionForClient(meta) });
    persistSession(meta.id);

    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `Claimed: [P${task.priority}] "${task.title}" (ID: ${task.id}, type: ${task.type})`,
    });

    setActivity(managed, {
      type: "working",
      detail: `Working on: ${task.title}`,
    });

    // Start a fresh ACP session for this task — no conversation history from
    // whatever the previous task's turn accumulated. Applies to every claimed
    // task (first attempt, rework pass on an existing branch, inspector
    // review), so the agent always reads the current code/PR state fresh
    // instead of relying on memory of a prior turn.
    let success = true;
    try {
      await managed.runner?.newSession();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `Warning: could not start a fresh session for this task (${msg}) — continuing on the existing session.`,
      });
    }

    // Build and send the prompt (review prompt for inspector agents, dev prompt otherwise)
    // Look up autoMergePrs only for the QA agent (final pipeline stage) — the code-reviewer
    // should never see the auto-merge prompt section or have the pr-complete tool.
    let autoMergePrs = false;
    if (stages.kind === "inspector" && meta.agent === "qa-improvement-agent") {
      try {
        autoMergePrs = await getTaskAutoMergePrs(task.id);
      } catch {
        // Non-critical — default to no auto-merge
      }
    }
    const prompt = buildTurnPrompt(stages.kind, task, meta.cwd, autoMergePrs);

    // Reset per-turn verdict tracking before each prompt
    managed.turnVerdict = null;
    managed.verdictToolCallId = null;

    try {
      await streamPrompt(managed, prompt);
    } catch (err) {
      success = false;
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `Task execution error: ${msg}`,
      });

      // Record the error so it appears in the Errors tab
      recordError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: msg,
        context: `Error while executing task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority})`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
      });
    }

    // If a required MCP server (verdict, pr-review) failed to initialize this
    // turn, the agent was missing tools it expected to have — see the same
    // check in runLoopModeAca for the full rationale. Fail the turn instead
    // of trusting whatever verdict came back.
    if (success && managed.runner?.mcpServerInitFailures.length) {
      success = false;
      const failedNames = managed.runner.mcpServerInitFailures.map((f) => f.name || "unknown").join(", ");
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `✖ MCP server(s) [${failedNames}] failed to start — the agent was missing tools it needed. ` +
          `Task reset to "${stages.claimState}" for retry instead of trusting this turn's result.`,
      });
      recordError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: `Required MCP server(s) failed to initialize this turn: ${failedNames} — any verdict/result reported is unreliable`,
        context: `Task "${task.title}" (ID: ${task.id}) ran with ${failedNames} unavailable.`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
      });
    }

    // Update task state
    if (signal.aborted) {
      // Session was stopped mid-task — reset to claim state
      // No new git info at all — omit branch/PR so the existing values are preserved.
      await resetTask(task.id, stages.claimState);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task ${task.id} reset to "${stages.claimState}" (session stopped).`,
      });
      break;
    }

    if (success) {
      // "no_action_needed" means already implemented / no issues found — always
      // resolve to stages.resolveState, never skip straight to "done".
      // The developer-agent saying "already implemented" still needs code review.
      if (managed.turnVerdict === "no_action_needed") {
        // Preserve existing branch/PR — the agent found nothing to do so it
        // never pushed anything, and we must not wipe what a prior stage stored.
        await resolveTask(task.id, stages.resolveState);
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} marked as "${stages.resolveState}" (${stages.kind === "inspector" ? "no issues found" : "already implemented"}) ✓`,
        });
      } else if (managed.turnVerdict === "changes_requested") {
        // Reviewer/QA agent found issues — send back to "todo" for rework,
        // preserving branch/PR so the developer agent can resume (local mode
        // never tracks git branch/PR info, so there is nothing new to report here).
        await resetTask(task.id, "todo");
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} sent back to "todo" — reviewer/QA requested changes (see PR comments).`,
        });
      } else {
        await resolveTask(task.id, stages.resolveState);
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} marked as "${stages.resolveState}" ✓`,
        });
      }
    } else {
      // No new git info at all — omit branch/PR so the existing values are preserved.
      await resetTask(task.id, stages.claimState);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task ${task.id} reset to "${stages.claimState}" (execution failed).`,
      });
    }

    meta.currentTaskId = undefined;
    broadcastToUser(meta.userId, { type: "session-updated", session: meta });
    persistSession(meta.id);

    // Brief pause between tasks
    if (!signal.aborted && meta.intervalSeconds > 0) {
      setActivity(managed, {
        type: "idle",
        detail: `Next run in ${meta.intervalSeconds}s...`,
      });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
    }
  }
}

/**
 * Sleep that can be interrupted by an AbortSignal.
 */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Standalone loop mode for agents with requiresTask=false (local runner).
 * Repeatedly sends the session prompt without claiming tasks.
 * No git operations — local mode has no git integration.
 */
async function runStandaloneLoopLocal(
  managed: ManagedSession,
  signal: AbortSignal
): Promise<void> {
  const { meta } = managed;
  let iteration = 0;
  const maxRuns = meta.runs; // 0 = endless

  const runsLabel = maxRuns === 0 ? "endless" : `${maxRuns} run(s)`;
  appendOutput(managed, {
    timestamp: now(),
    stream: "system",
    text: `Standalone loop started — no task queue (${runsLabel}, interval: ${meta.intervalSeconds}s)`,
  });

  while (!signal.aborted && managed.runner?.isAlive) {
    if (maxRuns > 0 && iteration >= maxRuns) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `All ${maxRuns} run(s) completed. Stopping.`,
      });
      setStatus(managed, "completed");
      setActivity(managed, { type: "completed", detail: `${maxRuns} run(s) finished` });
      return;
    }

    iteration++;
    const progressLabel = maxRuns > 0 ? `${iteration}/${maxRuns}` : `#${iteration}`;
    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `── Standalone run ${progressLabel} ──`,
    });

    setActivity(managed, { type: "working", detail: `Running prompt (${progressLabel})` });

    // Reset per-turn verdict tracking
    managed.turnVerdict = null;
    managed.verdictToolCallId = null;

    try {
      await streamPrompt(managed, meta.prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `Prompt execution error: ${msg}`,
      });
      recordError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: msg,
        context: `Error in standalone loop iteration ${iteration}`,
        userId: meta.userId,
      });
    }

    if (signal.aborted) break;

    // Pause between iterations
    if (meta.intervalSeconds > 0) {
      setActivity(managed, {
        type: "idle",
        detail: `Next run in ${meta.intervalSeconds}s...`,
      });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
    }
  }
}

async function streamPrompt(managed: ManagedSession, text: string, image?: { data: string; mimeType: string }): Promise<void> {
  if (!managed.runner) return;

  try {
    for await (const update of managed.runner.prompt(text, image)) {
      if (managed.abortController?.signal.aborted) break;
      processUpdate(managed, update);
    }
    // Flush any remaining buffered agent message text
    flushMessageBuffer(managed);

    // Capture credit usage from the completed turn
    const turnCredits = managed.runner.lastTurnCredits;
    if (turnCredits > 0) {
      managed.totalCreditsUsed += turnCredits;
      managed.meta.totalCreditsUsed = managed.totalCreditsUsed;
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task used ${turnCredits.toFixed(4)} credits (session total: ${managed.totalCreditsUsed.toFixed(4)} credits).`,
      });
      broadcastToUser(managed.meta.userId, { type: "session-updated", session: managed.meta });
      persistSession(managed.meta.id);
    }

    setActivity(managed, { type: "idle", detail: "Ready for next prompt" });
  } catch (err) {
    // Flush buffer even on error so partial text isn't lost
    flushMessageBuffer(managed);
    if (managed.abortController?.signal.aborted) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tool name → human-friendly description mapping
// ---------------------------------------------------------------------------

interface ToolDisplayInfo {
  icon: string;
  label: string;
}

/**
 * Map raw ACP tool names to human-friendly descriptions.
 * Provides enough context to understand what the agent is doing
 * without exposing internal tool names or overly technical details.
 */
function getToolDisplayInfo(toolName: string): ToolDisplayInfo {
  const name = toolName.toLowerCase();

  // File reading
  if (name.includes("read") && (name.includes("file") || name.includes("document"))) {
    return { icon: "📖", label: "Reading file" };
  }
  // File writing / editing
  if (name.includes("write") || name.includes("create_file")) {
    return { icon: "📝", label: "Writing file" };
  }
  if (name.includes("edit") || name.includes("replace") || name.includes("patch")) {
    return { icon: "✏️", label: "Editing code" };
  }
  // Shell / command execution
  if (name.includes("shell") || name.includes("exec") || name.includes("run") || name.includes("terminal") || name.includes("command")) {
    return { icon: "🖥️", label: "Running command" };
  }
  // Search / grep / find
  if (name.includes("search") || name.includes("grep") || name.includes("find") || name.includes("ripgrep")) {
    return { icon: "🔍", label: "Searching codebase" };
  }
  // Directory listing / navigation
  if (name.includes("list") || name.includes("dir") || name.includes("tree") || name.includes("glob")) {
    return { icon: "📂", label: "Browsing files" };
  }
  // Git operations
  if (name.includes("git")) {
    return { icon: "🔀", label: "Git operation" };
  }
  // Web / fetch / HTTP
  if (name.includes("fetch") || name.includes("http") || name.includes("web") || name.includes("url") || name.includes("browser")) {
    return { icon: "🌐", label: "Web request" };
  }
  // Database
  if (name.includes("sql") || name.includes("query") || name.includes("database") || name.includes("db")) {
    return { icon: "🗄️", label: "Database query" };
  }
  // Delete / remove
  if (name.includes("delete") || name.includes("remove")) {
    return { icon: "🗑️", label: "Removing file" };
  }
  // Rename / move
  if (name.includes("rename") || name.includes("move")) {
    return { icon: "📋", label: "Moving file" };
  }

  // Fallback: use the tool name but format it nicely
  return { icon: "🔧", label: formatToolName(toolName) };
}

/**
 * Format a camelCase or snake_case tool name into a readable label.
 * E.g., "readFile" → "Read file", "list_directory" → "List directory"
 */
function formatToolName(name: string): string {
  // Split on camelCase boundaries and underscores
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);

  if (words.length === 0) return name;
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(" ");
}

// ---------------------------------------------------------------------------

function processUpdate(managed: ManagedSession, update: SessionUpdateChunk): void {
  if (update.sessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content && typeof update.content.text === "string") {
          bufferAgentMessage(managed, update.content.text);
        }
        break;

      case "tool_call": {
        // Fall back to `kind` (and finally a generic label) so a tool call is
        // never silently dropped just because the agent omitted a title.
        const rawName = update.title || (update as { kind?: string }).kind || "tool";
        const { icon, label } = getToolDisplayInfo(rawName);
        setActivity(managed, { type: "tool-call", detail: label });
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `${icon} ${label}${update.title && label !== update.title ? ` — ${update.title}` : ""}`,
        });
        // Track report_verdict tool calls so we can capture the verdict from the update.
        // kiro-cli reports MCP tool titles as "Running: @<server>/<tool>" (e.g.
        // "Running: @verdict/report_verdict"), never the bare tool name — an exact
        // match against "report_verdict" never fires. Match by substring instead.
        if (rawName.includes("report_verdict")) {
          managed.verdictToolCallId = (update as { toolCallId?: string }).toolCallId ?? null;
        }
        break;
      }

      case "tool_call_update":
        if (update.status === "completed") {
          // Check if this is a completed report_verdict call — capture the verdict
          if (
            managed.verdictToolCallId &&
            (update as { toolCallId?: string }).toolCallId === managed.verdictToolCallId
          ) {
            // Extract verdict from tool output content
            const content = (update as { content?: Array<{ type?: string; text?: string }> }).content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === "text" && block.text) {
                  try {
                    const parsed = JSON.parse(block.text);
                    if (parsed?.verdict) {
                      managed.turnVerdict = parsed.verdict;
                    }
                  } catch { /* not JSON — ignore */ }
                }
              }
            }
            managed.verdictToolCallId = null;
          }
          setActivity(managed, { type: "working", detail: "Processing..." });
        } else if (update.status === "failed") {
          // Tool failures are the most common reason an agent produces no
          // changes — always surface them.
          appendOutput(managed, {
            timestamp: now(),
            stream: "stderr",
            text: `⚠️ Tool call failed: ${update.title || (update as { toolCallId?: string }).toolCallId || "unknown tool"}`,
          });
        }
        break;

      case "agent_thought_chunk":
      case "thinking":
        setActivity(managed, { type: "thinking", detail: "Thinking..." });
        break;

      case "plan": {
        const entries = (update as { entries?: Array<{ content?: string; status?: string }> }).entries || [];
        if (entries.length > 0) {
          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: `📋 Plan:\n${entries.map((e) => `  [${e.status ?? "?"}] ${e.content ?? ""}`).join("\n")}`,
          });
        }
        break;
      }

      default:
        // Other update types — show only if meaningful, with a clean format
        if (update.title || update.status) {
          const label = update.title || update.status || "";
          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: `ℹ️ ${label}`,
          });
        }
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// ACA mode: spawn workers as Azure Container Apps Jobs
// ---------------------------------------------------------------------------

/**
 * Run a session using an ACA worker container instead of a local KiroRunner.
 *
 * Flow:
 * 1. Call ACA Jobs API to start a new job execution
 * 2. Worker container starts, connects back via /ws/worker WebSocket
 * 3. Worker events are routed through the WorkerEventHandler callbacks
 * 4. When session ends, ACA job execution completes and container is cleaned up
 */
async function runSessionAca(managed: ManagedSession): Promise<void> {
  const { meta } = managed;
  managed.abortController = new AbortController();
  const { signal } = managed.abortController;

  if (!acaConfig) {
    throw new Error("ACA mode enabled but configuration is missing");
  }

  try {
    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: "Requesting ACA Job execution...",
    });

    // Resolve git workspace options from the session's tab configuration.
    // Use the first tab that has a repositoryUrl configured.
    let gitOptions: {
      repositoryUrl: string;
      devBranch?: string;
      gitProvider?: GitProvider;
      githubPat?: string;
      azureDevOpsPat?: string;
      persistentBranchName?: string;
    } | null = null;
    if (meta.tabIds && meta.tabIds.length > 0) {
      for (const tabId of meta.tabIds) {
        const tab = await getTabById(tabId);
        if (tab?.repositoryUrl) {
          // Provider precedence: the tab's explicit choice, then the owner's
          // profile default, then detection from the repository URL.
          const owner = await getUserById(meta.userId);
          const provider = resolveGitProvider(
            tab.gitProvider,
            owner?.defaultGitProvider,
            tab.repositoryUrl
          );

          const source = tab.gitProvider
            ? "tab"
            : owner?.defaultGitProvider
              ? "profile-default"
              : "url-detection";

          let githubPat: string | undefined;
          let azureDevOpsPat: string | undefined;

          // Only the selected provider's credential is handed to the worker.
          if (provider === "github") {
            const pat = await getDecryptedCredential(meta.userId, "githubPat");
            if (pat) githubPat = pat;
          } else if (provider === "azure-devops") {
            const pat = await getDecryptedCredential(meta.userId, "azureDevOpsPat");
            if (pat) azureDevOpsPat = pat;
          }

          const hasCredential = !!githubPat || !!azureDevOpsPat;
          log.info("git-provider-resolved", {
            component: "session-manager",
            sessionId: meta.id,
            tabId: tab.id,
            provider: provider ?? "unresolved",
            source,
            hasCredential,
            msg: `Git provider for tab "${tab.name}": ${provider ?? "unresolved"} (from ${source})`,
          });

          appendOutput(managed, {
            timestamp: now(),
            stream: hasCredential ? "system" : "stderr",
            text: provider
              ? `Git provider: ${provider} (from ${source})` +
                (hasCredential
                  ? ""
                  : ` — no ${provider === "github" ? "githubPat" : "azureDevOpsPat"} credential stored, pushing will fail`)
              : `Git provider could not be determined for ${tab.repositoryUrl}. ` +
                `Pick one on the tab or set a profile default in Settings.`,
          });

          gitOptions = {
            repositoryUrl: tab.repositoryUrl,
            devBranch: "develop,dev,main",
            gitProvider: provider ?? undefined,
            githubPat,
            azureDevOpsPat,
          };
          break;
        }
      }
    }

    // ─── Build per-session MCP proxy sidecar config ───────────────────────
    // Each session gets its own MCP proxy container for full isolation.
    // Credentials are decrypted at runtime and injected per session — no
    // cross-session credential sharing.
    let mcpSidecar: McpProxySidecarConfig | null = null;

    if (acaConfig.proxyImage) {
      try {
        // 1. Resolve effective MCP config: tab-level toggles merged with session overrides
        let effectiveMcpConfig: TabMcpConfig = { ...DEFAULT_MCP_CONFIG };

        if (meta.tabIds && meta.tabIds.length > 0) {
          // Use the first tab's MCP config as the base
          for (const tabId of meta.tabIds) {
            const tab = await getTabById(tabId);
            if (tab) {
              effectiveMcpConfig = { ...tab.mcpConfig };
              break;
            }
          }
        }

        // Apply session-level overrides (if set, they win over tab defaults)
        if (meta.mcpConfigOverride) {
          effectiveMcpConfig = { ...effectiveMcpConfig, ...meta.mcpConfigOverride };
        }

        // 2. Decrypt user credentials (only held in memory during config build)
        const rawCreds = await getAllDecryptedCredentials(meta.userId);
        const credentials: SessionCredentials = {
          azureDevOpsPat: rawCreds.azureDevOpsPat,
          atlassianApiToken: rawCreds.atlassianApiToken,
          atlassianUsername: rawCreds.atlassianUsername,
          awsAccessKeyId: rawCreds.awsAccessKeyId,
          awsSecretAccessKey: rawCreds.awsSecretAccessKey,
        };

        // 3. Generate servers.json config for the proxy sidecar
        const serversConfig = buildProxyServersConfig({
          mcpConfig: effectiveMcpConfig,
          credentials,
          sessionMcpServers: meta.mcpServers,
        });

        if (serversConfig) {
          mcpSidecar = { serversConfig, credentials };
          const serverNames = Object.keys(serversConfig);
          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: `MCP proxy sidecar: ${serverNames.length} server(s) configured [${serverNames.join(", ")}]`,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `Warning: Could not build MCP proxy config: ${msg}. Continuing without MCP proxy.`,
        });
        // Continue without proxy — non-fatal
      }
    }

    // Start the ACA Job execution via Azure REST API
    // Look up the agent's kind + full config to pass to the worker container.
    // The config lets the worker materialize .kiro/agents/<name>.json from
    // this session's actual DB-configured prompt/tools/resources instead of
    // its own hardcoded default.
    let agentKind: "editor" | "inspector" = "editor";
    let agentConfigBase64: string | undefined;
    let agentRequiresTask = true;
    if (meta.agent) {
      try {
        const agentRecord = await getAgentByName(meta.agent);
        if (agentRecord) {
          agentKind = agentRecord.kind;
          agentConfigBase64 = encodeAgentConfigBase64(agentRecord);
          agentRequiresTask = agentRecord.requiresTask;
        }
      } catch {
        // Agent lookup failed — default to editor (safe: existing behavior)
      }
    }

    // For standalone (requiresTask=false) agents, compute and attach a persistent
    // branch name so the worker continuously commits to one branch.
    if (!agentRequiresTask && gitOptions) {
      gitOptions.persistentBranchName =
        buildPersistentBranchName(meta.id, meta.name);
    }

    const execution = await startWorkerJob(
      acaConfig,
      meta.id,
      meta.agent,
      meta.userId,
      meta.timeoutSeconds,
      mcpSidecar,
      gitOptions,
      agentKind,
      agentConfigBase64
    );

    managed.acaExecutionName = execution.executionName;

    logWorkerEvent("worker-spawned", meta.id, {
      agent: meta.agent,
      executionName: execution.executionName,
      status: execution.status,
      msg: `ACA worker job started: ${execution.executionName}`,
    });

    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `ACA Job started: ${execution.executionName} (status: ${execution.status})`,
    });

    setActivity(managed, { type: "working", detail: "Waiting for worker to connect..." });

    // Wait for the worker to connect back via WebSocket or for abort
    await waitForWorkerOrAbort(managed, signal);

    // If we reach here without abort and the worker isn't connected, it failed
    if (!signal.aborted && !isWorkerConnected(meta.id)) {
      throw new Error(
        `Worker failed to connect (execution: ${managed.acaExecutionName}). ` +
        `Check Azure Portal container logs for startup errors.`
      );
    }

    if (signal.aborted) return;

    // Worker is connected — send the initial prompt if configured
    if (meta.loop) {
      if (!agentRequiresTask) {
        await runStandaloneLoopAca(managed, signal);
      } else {
        await runLoopModeAca(managed, signal);
      }
    } else {
      // Interactive mode: send initial prompt, then wait for user follow-ups
      if (meta.prompt.trim()) {
        await streamPromptAca(managed, meta.prompt);
      }
      setActivity(managed, { type: "idle", detail: "Waiting for prompts..." });

      // Keep alive: wait for worker disconnect or session stop
      while (!signal.aborted && isWorkerConnected(meta.id)) {
        await interruptibleSleep(2000, signal);
      }
    }

    if (!signal.aborted) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: "Worker disconnected.",
      });
      setStatus(managed, "error");
      setActivity(managed, { type: "idle" });
    }
  } catch (err) {
    if (signal.aborted) return;
    throw err;
  } finally {
    managed.acaExecutionName = null;
    managed.abortController = null;
    managed.acaPromptResolver = null;
    managed.acaPromptRejecter = null;
  }
}

/**
 * Wait for the ACA worker to connect via WebSocket, with a timeout.
 *
 * Periodically polls the ACA job execution status to detect early failures
 * (e.g. container crash, image pull error) and reports progress so the UI
 * shows what's happening during the wait.
 */
async function waitForWorkerOrAbort(
  managed: ManagedSession,
  signal: AbortSignal
): Promise<void> {
  const WORKER_CONNECT_TIMEOUT_MS = 180_000; // 3 minutes for container pull + start
  const STATUS_POLL_INTERVAL_MS = 10_000; // Check ACA job status every 10s
  const startTime = Date.now();
  let lastStatusCheck = 0;
  let lastLoggedStatus = "";

  log.info("worker-wait-started", {
    component: "session-manager",
    sessionId: managed.meta.id,
    executionName: managed.acaExecutionName,
    timeoutMs: WORKER_CONNECT_TIMEOUT_MS,
    msg: `Waiting up to ${WORKER_CONNECT_TIMEOUT_MS / 1000}s for worker WebSocket connection...`,
  });

  while (!signal.aborted && !isWorkerConnected(managed.meta.id)) {
    const elapsed = Date.now() - startTime;

    if (elapsed > WORKER_CONNECT_TIMEOUT_MS) {
      // Before throwing, try one final status check for diagnostic context
      let finalStatus = "unknown";
      if (acaConfig && managed.acaExecutionName) {
        try {
          const jobStatus = await getWorkerJobStatus(acaConfig, managed.acaExecutionName);
          finalStatus = jobStatus.status;
        } catch { /* best effort */ }
      }

      const errorMsg =
        `Worker did not connect within ${WORKER_CONNECT_TIMEOUT_MS / 1000}s. ` +
        `ACA job status at timeout: "${finalStatus}". ` +
        `The container may have failed to start, crashed during init, or cannot reach the orchestrator URL. ` +
        `Check the worker container logs in Azure Portal for more details.`;

      log.error("worker-connect-timeout", {
        component: "session-manager",
        sessionId: managed.meta.id,
        agent: managed.meta.agent,
        executionName: managed.acaExecutionName,
        elapsedMs: elapsed,
        lastAcaStatus: finalStatus,
        msg: errorMsg,
      });

      throw new Error(errorMsg);
    }

    // Periodically poll ACA job execution status to detect early failures
    if (acaConfig && managed.acaExecutionName && elapsed - lastStatusCheck >= STATUS_POLL_INTERVAL_MS) {
      lastStatusCheck = elapsed;
      try {
        const jobStatus = await getWorkerJobStatus(acaConfig, managed.acaExecutionName);
        const statusStr = jobStatus.status;

        // Log status changes
        if (statusStr !== lastLoggedStatus) {
          lastLoggedStatus = statusStr;
          const elapsedSec = Math.round(elapsed / 1000);

          log.info("worker-status-poll", {
            component: "session-manager",
            sessionId: managed.meta.id,
            executionName: managed.acaExecutionName,
            acaStatus: statusStr,
            elapsedSec,
            msg: `Worker job status: "${statusStr}" (${elapsedSec}s elapsed)`,
          });

          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: `Worker status: ${statusStr} (${elapsedSec}s elapsed, waiting for WebSocket connection...)`,
          });
        }

        // Detect terminal failure states — bail out early instead of waiting the full timeout
        const failedStates = ["failed", "terminated", "degraded", "unknown"];
        if (failedStates.includes(statusStr.toLowerCase())) {
          const errorMsg =
            `ACA worker job entered terminal state "${statusStr}" before connecting. ` +
            `Execution: ${managed.acaExecutionName}. ` +
            `The container likely crashed during startup. ` +
            `Check Azure Portal → Container Apps Jobs → ${managed.acaExecutionName} → Logs for details.`;

          log.error("worker-early-failure", {
            component: "session-manager",
            sessionId: managed.meta.id,
            agent: managed.meta.agent,
            executionName: managed.acaExecutionName,
            acaStatus: statusStr,
            elapsedMs: elapsed,
            msg: errorMsg,
          });

          throw new Error(errorMsg);
        }
      } catch (err) {
        // If it's our own thrown Error from the terminal state check, re-throw
        if (err instanceof Error && err.message.includes("terminal state")) {
          throw err;
        }
        // Otherwise, status poll failed — log but continue waiting
        log.debug("worker-status-poll-error", {
          component: "session-manager",
          sessionId: managed.meta.id,
          executionName: managed.acaExecutionName,
          ...toErrorFields(err),
        });
      }
    }

    await interruptibleSleep(1000, signal);
  }

  // Log success if connected
  if (isWorkerConnected(managed.meta.id)) {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    log.info("worker-connected-timing", {
      component: "session-manager",
      sessionId: managed.meta.id,
      agent: managed.meta.agent,
      executionName: managed.acaExecutionName,
      elapsedSec,
      msg: `Worker connected after ${elapsedSec}s`,
    });
  }
}

/**
 * Result of a single prompt turn reported by an ACA worker.
 *
 * `error` carries the ACP/JSON-RPC failure text (or a git failure) so a turn
 * that never actually ran can be told apart from a turn that ran and produced
 * nothing. `stopReason` is the ACP StopReason ("end_turn", "cancelled",
 * "max_tokens", "refusal", ...).
 */
interface WorkerPromptResult {
  hasChanges?: boolean;
  prUrl?: string;
  branchName?: string;
  error?: string | null;
  stopReason?: string | null;
  toolCalls?: number;
  durationMs?: number;
  /** The agent's work was committed but could not be pushed — retrying won't help. */
  deliveryFailed?: boolean;
  /** Kiro credits consumed this turn (from _kiro.dev/metadata meteringUsage). */
  credits?: number;
  /** Agent-reported verdict via the report_verdict MCP tool. Cross-checked against git diff by the worker. */
  verdict?: "resolved" | "no_action_needed" | "changes_requested";
  /**
   * MCP servers that failed to initialize this turn (see worker.js's
   * `_kiro.dev/mcp/server_init_failure` handling). Non-empty means the agent
   * was missing tools it expected to have — e.g. an inspector without
   * post_review_comment, or an editor without get_pr_review_comments — so
   * whatever verdict/result it reported should not be trusted at face value.
   */
  mcpServerInitFailures?: Array<{ name: string | null }>;
}

/**
 * Send a prompt to an ACA worker and wait for prompt-done response.
 */
async function streamPromptAca(managed: ManagedSession, text: string, taskMeta?: { id: number; title: string; type: string; description: string; files: string[]; branch?: string | null; pullRequestUrl?: string | null; siblingTasks?: Array<{ id: number; title: string; type: string; description: string; pullRequestUrl: string | null }>; autoMergePrs?: boolean; allGroupTasksDone?: boolean }): Promise<WorkerPromptResult> {
  if (!isWorkerConnected(managed.meta.id)) {
    throw new Error("Worker is not connected");
  }

  // Send the prompt to the worker (with optional task metadata for branch/commit/PR)
  const workerTaskMeta = taskMeta ? { id: taskMeta.id, title: taskMeta.title, type: taskMeta.type, description: taskMeta.description, files: taskMeta.files, branch: taskMeta.branch ?? null, pullRequestUrl: taskMeta.pullRequestUrl ?? null, siblingTasks: taskMeta.siblingTasks, autoMergePrs: taskMeta.autoMergePrs, allGroupTasksDone: taskMeta.allGroupTasksDone } : undefined;
  const sent = sendWorkerPrompt(managed.meta.id, text, workerTaskMeta);
  if (!sent) {
    throw new Error("Failed to send prompt to worker");
  }

  // Wait for prompt-done callback from the worker event handler
  const result = await new Promise<unknown>((resolve, reject) => {
    managed.acaPromptResolver = (r: unknown) => resolve(r);
    managed.acaPromptRejecter = reject;

    // Also resolve on abort
    const onAbort = () => {
      managed.acaPromptResolver = null;
      managed.acaPromptRejecter = null;
      resolve({});
    };
    managed.abortController?.signal.addEventListener("abort", onAbort, { once: true });
  });

  managed.acaPromptResolver = null;
  managed.acaPromptRejecter = null;

  return (result && typeof result === "object") ? result as WorkerPromptResult : {};
}

/**
 * Standalone loop mode for agents with requiresTask=false (ACA worker).
 * Repeatedly sends the session prompt without claiming tasks.
 * The worker handles persistent branch checkout/push via PERSISTENT_BRANCH_NAME env.
 * No PR creation — the branch is a continuously updated deliverable.
 */
async function runStandaloneLoopAca(
  managed: ManagedSession,
  signal: AbortSignal
): Promise<void> {
  const { meta } = managed;
  let iteration = 0;
  const maxRuns = meta.runs; // 0 = endless

  const runsLabel = maxRuns === 0 ? "endless" : `${maxRuns} run(s)`;
  appendOutput(managed, {
    timestamp: now(),
    stream: "system",
    text: `Standalone loop started — no task queue (${runsLabel}, interval: ${meta.intervalSeconds}s)`,
  });

  while (!signal.aborted && isWorkerConnected(meta.id)) {
    if (maxRuns > 0 && iteration >= maxRuns) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `All ${maxRuns} run(s) completed. Stopping.`,
      });
      setStatus(managed, "completed");
      setActivity(managed, { type: "completed", detail: `${maxRuns} run(s) finished` });
      return;
    }

    iteration++;
    const progressLabel = maxRuns > 0 ? `${iteration}/${maxRuns}` : `#${iteration}`;
    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `── Standalone run ${progressLabel} ──`,
    });

    setActivity(managed, { type: "working", detail: `Running prompt (${progressLabel})` });

    try {
      // No taskMeta — standalone sessions don't have tasks
      const promptResult = await streamPromptAca(managed, meta.prompt);

      // Surface worker-reported errors (ACP failure, git push failure, timeout)
      if (promptResult.error) {
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `⚠ Turn error: ${promptResult.error}`,
        });
        recordError({
          sessionId: meta.id,
          sessionName: meta.name,
          agent: meta.agent,
          message: promptResult.error,
          context: `Standalone loop iteration ${iteration} reported error. stopReason: ${promptResult.stopReason ?? "none"}, tool calls: ${promptResult.toolCalls ?? 0}, duration: ${Math.round((promptResult.durationMs ?? 0) / 1000)}s.`,
          userId: meta.userId,
        });
      }
      if (promptResult.stopReason === "cancelled") {
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `⚠ Turn was cancelled (likely timeout) before completing.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `Prompt execution error: ${msg}`,
      });
      recordError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: msg,
        context: `Error in standalone loop iteration ${iteration}`,
        userId: meta.userId,
      });
    }

    if (signal.aborted) break;

    // Pause between iterations
    if (meta.intervalSeconds > 0) {
      setActivity(managed, {
        type: "idle",
        detail: `Next run in ${meta.intervalSeconds}s...`,
      });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
    }
  }
}

/**
 * Autonomous loop mode using ACA worker.
 * Same logic as runLoopMode but uses streamPromptAca instead of streamPrompt.
 */
async function runLoopModeAca(
  managed: ManagedSession,
  signal: AbortSignal
): Promise<void> {
  const { meta } = managed;
  let iteration = 0;
  const maxRuns = meta.runs;

  // Look up the agent's stage states once per loop start
  const stages = await getAgentStageStates(meta.agent);

  // Track consecutive failures per task ID to prevent infinite retry loops.
  // After MAX_TASK_FAILURES consecutive failures on the same task, it is left
  // in claimState but skipped for the rest of this session (not re-claimed).
  const MAX_TASK_FAILURES = 3;
  const taskFailures = new Map<number, number>(); // taskId → consecutive failure count
  const blockedTasks = new Set<number>(); // tasks that hit the failure cap this session

  // Task-claiming tab filter: a session with no tabs assigned claims from
  // ANY tab. A session assigned to specific tabs only claims from those.
  const effectiveTabIds: number[] | undefined = meta.tabIds;

  const runsLabel = maxRuns === 0 ? "endless" : `${maxRuns} run(s)`;
  appendOutput(managed, {
    timestamp: now(),
    stream: "system",
    text: `Autonomous loop started (${runsLabel}, interval: ${meta.intervalSeconds}s)`,
  });

  while (!signal.aborted && isWorkerConnected(meta.id)) {
    if (maxRuns > 0 && iteration >= maxRuns) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `All ${maxRuns} run(s) completed. Stopping.`,
      });
      setStatus(managed, "completed");
      setActivity(managed, { type: "completed", detail: `${maxRuns} run(s) finished` });
      return;
    }

    const todoCount = await getAvailableTaskCount(effectiveTabIds, stages.claimState);

    if (todoCount === 0) {
      setActivity(managed, {
        type: "idle",
        detail: "No tasks available. Waiting for new tasks...",
      });

      // Park here until a task is created/reset or the session is stopped.
      // waitForTaskAvailable does a single DB check, then suspends on an
      // in-process event — zero DB queries during the wait.
      await waitForTaskAvailable(effectiveTabIds, stages.claimState, signal);
      continue;
    }

    iteration++;
    setActivity(managed, { type: "working", detail: "Claiming next task..." });

    const progressLabel = maxRuns > 0 ? `${iteration}/${maxRuns}` : `#${iteration}`;
    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `── Run ${progressLabel} ── ${todoCount} task(s) available`,
    });

    const task = await claimTask(undefined, effectiveTabIds, stages.claimState, stages.workingState);
    if (!task) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: "Failed to claim task (race condition or empty queue).",
      });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
      continue;
    }

    // Skip tasks that have already exceeded failure limit in this session
    if (blockedTasks.has(task.id)) {
      // No git activity happened here at all — preserve existing branch/PR.
      await resetTask(task.id, stages.claimState);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Skipping task ${task.id} — exceeded ${MAX_TASK_FAILURES} consecutive failures this session.`,
      });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
      continue;
    }

    meta.currentTaskId = task.id;
    broadcastToUser(meta.userId, { type: "session-updated", session: meta });
    persistSession(meta.id);

    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `Claimed: [P${task.priority}] "${task.title}" (ID: ${task.id}, type: ${task.type})`,
    });

    setActivity(managed, { type: "working", detail: `Working on: ${task.title}` });

    let success = true;
    let promptResult: WorkerPromptResult = {};
    let failureReason = "";
    /** Set when the agent succeeded but the push failed — not worth retrying. */
    let deliveryFailure = false;

    // Sibling task lookup for shared branch/PR support (AC1, AC2, AC3, AC5).
    //
    // Two paths:
    //   1. task.branch IS set → look up siblings sharing that branch (AC1/AC5)
    //   2. task.branch is NULL but task.groupId IS set → look up siblings by
    //      group_id to discover a shared branch from an earlier task (AC2).
    //
    // AC2 requires that tasks share an explicit `group_id` column value. Without
    // a groupId, there is no way to discover siblings when the task has no branch
    // (since "sibling by branch" requires a branch to search for). The groupId is
    // the grouping mechanism; the first task in a group that runs creates the
    // branch, and subsequent tasks discover it via this lookup.
    //
    // Race conditions between tasks in the same group are prevented by the
    // NOT EXISTS clause in claimTask() — only one task per group can be in a
    // workingState at any time.
    let siblingTasks: Array<{ id: number; title: string; type: string; description: string; pullRequestUrl: string | null }> | undefined;
    if (task.branch) {
      try {
        const siblings = await findSiblingTasks(task.branch, task.id);
        if (siblings.length > 0) {
          siblingTasks = siblings.map(s => ({ id: s.id, title: s.title, type: s.type, description: s.description, pullRequestUrl: s.pullRequestUrl }));
          // Propagate sibling's PR URL to the current task if the task itself
          // doesn't have one yet. This ensures the worker receives the PR URL
          // directly on `currentTaskMeta.pullRequestUrl` (instead of relying on
          // the worker-side `findSiblingPrUrl` fallback), which is required for
          // Azure DevOps where there's no 422-based duplicate PR recovery.
          if (!task.pullRequestUrl) {
            const siblingPrUrl = siblings.find(s => s.pullRequestUrl)?.pullRequestUrl;
            if (siblingPrUrl) {
              task.pullRequestUrl = siblingPrUrl;
            }
          }
          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: `Task shares branch "${task.branch}" with ${siblings.length} sibling task(s): ${siblings.map(s => `#${s.id}`).join(", ")}`,
          });
        }
      } catch (err) {
        // Non-critical — proceed without sibling info
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `Warning: could not look up sibling tasks: ${msg}`,
        });
      }
    } else if (task.groupId) {
      // AC2: task has no branch yet, but has a groupId — look up siblings by
      // group_id to discover a shared branch from an earlier task in the group.
      try {
        const groupSiblings = await findSiblingTasksByGroupId(task.groupId, task.id);
        if (groupSiblings.length > 0) {
          // Find a sibling that already has a branch assigned
          const siblingWithBranch = groupSiblings.find(s => s.branch);
          if (siblingWithBranch && siblingWithBranch.branch) {
            // Inherit the branch (and PR URL) from the sibling
            task.branch = siblingWithBranch.branch;
            task.pullRequestUrl = siblingWithBranch.pullRequestUrl || task.pullRequestUrl;
            siblingTasks = groupSiblings.map(s => ({ id: s.id, title: s.title, type: s.type, description: s.description, pullRequestUrl: s.pullRequestUrl }));
            appendOutput(managed, {
              timestamp: now(),
              stream: "system",
              text: `AC2: Task has no branch but shares group "${task.groupId}" with ${groupSiblings.length} sibling(s). Inherited branch "${task.branch}" from sibling #${siblingWithBranch.id}.`,
            });
          } else {
            // Siblings exist but none have a branch yet — this is the first task in the group to run.
            // Provide siblings for PR content generation but don't set a branch.
            siblingTasks = groupSiblings.map(s => ({ id: s.id, title: s.title, type: s.type, description: s.description, pullRequestUrl: s.pullRequestUrl }));
            appendOutput(managed, {
              timestamp: now(),
              stream: "system",
              text: `Task is in group "${task.groupId}" with ${groupSiblings.length} sibling(s), but no sibling has a branch yet — this task will create one.`,
            });
          }
        }
      } catch (err) {
        // Non-critical — proceed without sibling info
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `Warning: could not look up group siblings: ${msg}`,
        });
      }
    }

    // Compute autoMergePrs and allGroupTasksDone for the pr-complete MCP server.
    // Only relevant for the QA agent (final pipeline stage) — the code-reviewer
    // should never get the auto-merge prompt section or the pr-complete tool.
    let autoMergePrs = false;
    // Default: ungrouped tasks can merge freely (true); grouped tasks must verify
    // all siblings are done before merging (false). This ensures that if
    // areAllGroupTasksDone() throws, a grouped task's merge is safely deferred
    // rather than prematurely allowed.
    let allGroupTasksDone = !task.groupId;
    if (meta.agent === "qa-improvement-agent") {
      try {
        autoMergePrs = await getTaskAutoMergePrs(task.id);
        if (task.groupId) {
          allGroupTasksDone = await areAllGroupTasksDone(task.groupId, task.id);
        }
      } catch (err) {
        // Non-critical — if lookup fails, default to no auto-merge for grouped
        // tasks (allGroupTasksDone stays false), which defers the merge safely.
        // For ungrouped tasks, autoMergePrs stays false so no merge is attempted.
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `Warning: could not look up autoMergePrs/group status: ${msg}`,
        });
      }
    }

    // Build the prompt after autoMergePrs is known (inspector agents need it for the auto-merge section)
    const prompt = buildTurnPrompt(stages.kind, task, ACA_WORKSPACE_PATH, autoMergePrs);

    try {
      promptResult = await streamPromptAca(managed, prompt, { id: task.id, title: task.title, type: task.type, description: task.description, files: task.files, branch: task.branch, pullRequestUrl: task.pullRequestUrl, siblingTasks, autoMergePrs, allGroupTasksDone });
    } catch (err) {
      success = false;
      const msg = err instanceof Error ? err.message : String(err);
      failureReason = msg;
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `Task execution error: ${msg}`,
      });
      recordError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: msg,
        context: `Error while executing task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority})`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
      });
    }

    if (signal.aborted) {
      // `|| undefined` preserves the existing DB value whenever the worker
      // never got far enough to report real git info (or sent an explicit
      // null) — never force branch/PR to null just because the session stopped.
      await resetTask(task.id, stages.claimState, promptResult.branchName || undefined, promptResult.prUrl || undefined);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task ${task.id} reset to "${stages.claimState}" (session stopped).`,
      });
      break;
    }

    // The agent turn itself failed (ACP error, timeout, git failure). This is a
    // different failure from "the agent ran but changed nothing" and must be
    // reported as such — otherwise a broken agent looks like a lazy one.
    if (success && promptResult.error) {
      success = false;
      failureReason = promptResult.error;
      if (promptResult.deliveryFailed) {
        // The agent finished the task; the commit just couldn't be pushed.
        // Re-running the agent would only repeat the work and fail the same way,
        // so skip the retry budget entirely and surface it as a config problem.
        deliveryFailure = true;
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text:
            `✖ The agent completed the task but the result could not be pushed. This is a git ` +
            `credential/permission problem, not a task problem — retrying will not help.\n${promptResult.error}`,
        });
      } else {
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `✖ Agent turn failed: ${promptResult.error}`,
        });
      }
      recordError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: promptResult.error,
        context:
          `Agent turn failed for task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority}). ` +
          `stopReason: ${promptResult.stopReason ?? "none"}, tool calls: ${promptResult.toolCalls ?? 0}, ` +
          `duration: ${Math.round((promptResult.durationMs ?? 0) / 1000)}s.`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
      });
    }

    // A cancelled turn (timeout, or the orchestrator's own session/cancel) never
    // reached end_turn — the agent was mid-work when it was cut off. It can still
    // report hasChanges + a clean push (git operations run unconditionally after
    // the turn ends), so without this check a task that never finished — and was
    // very possibly never verified to build — looks identical to a real success
    // and gets marked "developed" with a PR opened on unverified work.
    if (success && promptResult.stopReason === "cancelled") {
      success = false;
      failureReason = `Agent turn was cancelled (timeout) before completing — stopReason: cancelled, tool calls: ${promptResult.toolCalls ?? 0}, duration: ${Math.round((promptResult.durationMs ?? 0) / 1000)}s`;
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `✖ Agent turn was cancelled before it finished (likely a timeout) — task reset to "${stages.claimState}" instead of being marked "${stages.resolveState}".`,
      });
      recordError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: failureReason,
        context:
          `Task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority}) was cancelled ` +
          `before the agent reached end_turn. Any pushed branch/PR reflects unverified, possibly incomplete work.`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
      });
    }

    // If a required MCP server (verdict, pr-review) failed to initialize this
    // turn, the agent was missing tools it expected to have and may have
    // silently degraded — e.g. an inspector losing post_review_comment and
    // reporting "no_action_needed" instead of a real finding, or an editor
    // losing get_pr_review_comments and never reading reviewer feedback at
    // all (see the code-reviewer-agent / developer-agent incidents this
    // check was added for). Whatever verdict/result came back cannot be
    // trusted at face value, so treat this exactly like a cancelled turn:
    // fail the turn and let it retry against a fresh session (a new
    // session/new call gives the MCP server another chance to start cleanly).
    if (success && promptResult.mcpServerInitFailures?.length) {
      success = false;
      const failedNames = promptResult.mcpServerInitFailures
        .map((f) => f.name || "unknown")
        .join(", ");
      failureReason = `Required MCP server(s) failed to initialize this turn: ${failedNames} — any verdict/result reported is unreliable`;
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `✖ MCP server(s) [${failedNames}] failed to start — the agent was missing tools it needed. ` +
          `Task reset to "${stages.claimState}" for retry instead of trusting this turn's result.`,
      });
      recordError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: failureReason,
        context:
          `Task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority}) ran with ` +
          `${failedNames} unavailable. Any verdict this turn reported (${promptResult.verdict ?? "none"}) is not trustworthy.`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
      });
    }

    // Check if the worker produced any file changes.
    // Skip this check when the agent reported any verdict — inspector/QA agents
    // legitimately never produce file changes (they only post PR comments).
    if (success && !promptResult.hasChanges && !promptResult.verdict) {
      success = false;
      const details = [
        `stopReason: ${promptResult.stopReason ?? "unknown"}`,
        `tool calls: ${promptResult.toolCalls ?? 0}`,
        `duration: ${Math.round((promptResult.durationMs ?? 0) / 1000)}s`,
      ].join(", ");
      failureReason = `No file changes produced (${details})`;
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `⚠ No file changes detected after agent execution (${details}) — task reset to "${stages.claimState}".`,
      });
      if ((promptResult.toolCalls ?? 0) === 0) {
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text:
            "The agent made zero tool calls, so it never inspected the repository. " +
            "This usually points at the agent/tool configuration or the ACP handshake, not the task itself.",
        });
      }
    }

    if (success && promptResult.prUrl) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Pull Request: ${promptResult.prUrl}`,
      });
    }

    if (success) {
      // If the agent reported "no_action_needed" and no file changes exist
      // "no_action_needed" means the agent found the work already done / no issues:
      // - Both editor AND inspector agents advance to their own resolveState.
      //   An editor saying "already implemented" still goes to "developed" so code
      //   review and QA can run. An inspector saying "looks good" goes to "reviewed"
      //   so QA can run. Only markTaskDone() is called when ALL pipeline stages are
      //   already satisfied, which never applies here.
      if (promptResult.verdict === "no_action_needed" && !promptResult.hasChanges) {
        // When the agent found nothing to do it never touched the repo, so
        // branchName/prUrl in promptResult are empty. Preserve whatever the
        // previous pipeline stage already stored rather than overwriting with null.
        await resolveTask(task.id, stages.resolveState);
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} marked as "${stages.resolveState}" (${stages.kind === "inspector" ? "no issues found" : "already implemented"}) ✓`,
        });
      } else if (promptResult.verdict === "changes_requested") {
        // Reviewer/QA agent found issues — send back to "todo" for rework.
        // The worker always sends an explicit `null` (never omits the key) when
        // it has nothing to report, so `|| undefined` is required here — passing
        // the raw value straight through would still overwrite an existing PR
        // link with null on every inspector turn (inspectors never have a PR to
        // report, but DO have a real branch name from checking it out to review).
        await resetTask(task.id, "todo", promptResult.branchName || undefined, promptResult.prUrl || undefined);
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} sent back to "todo" — reviewer/QA requested changes (see PR comments).`,
        });
      } else {
        await resolveTask(task.id, stages.resolveState, promptResult.branchName || undefined, promptResult.prUrl || undefined);
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} marked as "${stages.resolveState}" ✓`,
        });
      }
      // Clear failure counter on success
      taskFailures.delete(task.id);
    } else {
      // On failure, pass branch/PR info if the worker managed a best-effort push.
      // `|| undefined` ensures a worker that never got that far (or that has no
      // PR to report, e.g. an inspector) preserves the existing DB value instead
      // of overwriting it with the worker's default `null`.
      await resetTask(task.id, stages.claimState, promptResult.branchName || undefined, promptResult.prUrl || undefined);

      // A delivery failure is an environment problem, not a task problem —
      // block immediately instead of spending the whole retry budget
      // re-implementing the same task and failing the same push.
      if (deliveryFailure) {
        blockedTasks.add(task.id);
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} reset to "${stages.claimState}" and blocked for this session — fix the git credentials, then re-run.`,
        });
        meta.currentTaskId = undefined;
        broadcastToUser(meta.userId, { type: "session-updated", session: meta });
        persistSession(meta.id);
        continue;
      }

      // Track consecutive failures and apply backoff / blocking
      const failures = (taskFailures.get(task.id) || 0) + 1;
      taskFailures.set(task.id, failures);

      if (failures >= MAX_TASK_FAILURES) {
        blockedTasks.add(task.id);
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} reset to "${stages.claimState}" (${failureReason || "execution failed"}). ⛔ Blocked after ${failures} consecutive failures — will not retry this session.`,
        });
        recordError({
          sessionId: meta.id,
          sessionName: meta.name,
          agent: meta.agent,
          message: `Task "${task.title}" failed ${failures} consecutive times — blocked for this session`,
          context: `Task ID: ${task.id}, type: ${task.type}, priority: P${task.priority}. Last failure: ${failureReason || "unknown"}. Manual investigation is required.`,
          taskId: task.id,
          taskTitle: task.title,
          userId: meta.userId,
        });
      } else {
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} reset to "${stages.claimState}" (${failureReason || "execution failed"}). Attempt ${failures}/${MAX_TASK_FAILURES} — will retry with backoff.`,
        });
        // Exponential backoff: 30s, 60s after 1st and 2nd failures
        const backoffMs = 30_000 * Math.pow(2, failures - 1);
        setActivity(managed, { type: "idle", detail: `Backoff after failure (${Math.round(backoffMs / 1000)}s)...` });
        await interruptibleSleep(backoffMs, signal);
      }
    }

    meta.currentTaskId = undefined;
    broadcastToUser(meta.userId, { type: "session-updated", session: meta });
    persistSession(meta.id);

    if (!signal.aborted && meta.intervalSeconds > 0) {
      setActivity(managed, { type: "idle", detail: `Next run in ${meta.intervalSeconds}s...` });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
    }
  }
}

// ---------------------------------------------------------------------------
// ACA Worker Event Handler Registration
// ---------------------------------------------------------------------------

/**
 * Register callbacks so the worker-ws-handler routes incoming worker messages
 * to the correct session in session-manager.
 * Must be called during server startup (after imports resolve).
 */
function initWorkerEventHandler(): void {
  const handler: WorkerEventHandler = {
    onWorkerReady(sessionId: number, acpSessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) return;
      logWorkerEvent("worker-connected", sessionId, {
        agent: session.meta.agent,
        acpSessionId,
        msg: "Worker connected and ready",
      });
      appendOutput(session, {
        timestamp: now(),
        stream: "system",
        text: `Worker container connected (ACP: ${acpSessionId})`,
      });
      setActivity(session, { type: "idle", detail: "Worker connected" });
    },

    onWorkerOutput(sessionId: number, entry: OutputEntry) {
      const session = sessions.get(sessionId);
      if (!session) return;
      appendOutput(session, entry);
    },

    onWorkerSessionUpdate(sessionId: number, update: unknown) {
      const session = sessions.get(sessionId);
      if (!session) return;
      // Route through the same processUpdate logic used for local mode
      if (update && typeof update === "object") {
        processUpdate(session, update as SessionUpdateChunk);
      }
    },

    onWorkerPromptDone(sessionId: number, result: unknown) {
      const session = sessions.get(sessionId);
      if (!session) return;
      flushMessageBuffer(session);

      // Log the full turn outcome. Previously this payload was discarded, so an
      // ACP-level failure was indistinguishable from an idle agent.
      const r = (result && typeof result === "object" ? result : {}) as WorkerPromptResult;
      logWorkerEvent(r.error ? "worker-prompt-failed" : "worker-prompt-done", sessionId, {
        agent: session.meta.agent,
        taskId: session.meta.currentTaskId,
        stopReason: r.stopReason ?? null,
        toolCalls: r.toolCalls ?? null,
        durationMs: r.durationMs ?? null,
        hasChanges: r.hasChanges ?? null,
        prUrl: r.prUrl ?? null,
        error: r.error ?? null,
        credits: r.credits ?? null,
        msg: r.error
          ? `Prompt turn failed: ${r.error}`
          : `Prompt turn finished (stopReason: ${r.stopReason ?? "unknown"}, tool calls: ${r.toolCalls ?? 0}, changes: ${r.hasChanges ? "yes" : "no"})`,
      });

      // Accumulate credit usage from this turn
      if (r.credits && r.credits > 0) {
        session.totalCreditsUsed += r.credits;
        session.meta.totalCreditsUsed = session.totalCreditsUsed;
        appendOutput(session, {
          timestamp: now(),
          stream: "system",
          text: `Task used ${r.credits.toFixed(4)} credits (session total: ${session.totalCreditsUsed.toFixed(4)} credits).`,
        });
        broadcastToUser(session.meta.userId, { type: "session-updated", session: session.meta });
        persistSession(session.meta.id);
      }

      setActivity(session, { type: "idle", detail: "Ready for next prompt" });
      // Resolve the awaiter in streamPromptAca
      if (session.acaPromptResolver) {
        session.acaPromptResolver(result);
        session.acaPromptResolver = null;
        session.acaPromptRejecter = null;
      }
    },

    onWorkerExited(sessionId: number, exitCode: number | null, signal: string | null) {
      const session = sessions.get(sessionId);
      if (!session) return;
      const reason = signal === "disconnected"
        ? "Worker disconnected"
        : `Worker exited (code: ${exitCode}, signal: ${signal})`;

      // A nonzero exit code (or an unexpected disconnect) is a crash; a clean
      // exit is a normal lifecycle end.
      const crashed = signal === "disconnected" || (exitCode !== null && exitCode !== 0);
      logWorkerEvent(crashed ? "worker-crashed" : "worker-exited", sessionId, {
        agent: session.meta.agent,
        exitCode,
        signal,
        msg: reason,
      });

      appendOutput(session, { timestamp: now(), stream: "system", text: reason });
      // Reject any pending prompt awaiter
      if (session.acaPromptRejecter) {
        session.acaPromptRejecter(new Error(reason));
        session.acaPromptResolver = null;
        session.acaPromptRejecter = null;
      }
    },

    onWorkerShutdown(sessionId: number, exitCode: number) {
      const session = sessions.get(sessionId);
      if (!session) return;
      logWorkerEvent(exitCode === 0 ? "worker-exited" : "worker-crashed", sessionId, {
        agent: session.meta.agent,
        exitCode,
        msg: `Worker shutdown (exit code: ${exitCode})`,
      });
      appendOutput(session, {
        timestamp: now(),
        stream: "system",
        text: `Worker shutdown (exit code: ${exitCode})`,
      });
      if (exitCode === 0) {
        setStatus(session, "completed");
        setActivity(session, { type: "completed" });
      } else {
        setStatus(session, "error");
        setActivity(session, { type: "idle" });
      }
    },
  };

  setWorkerEventHandler(handler);
}

// Initialize the worker event handler immediately (runs at module load time)
if (ACA_MODE) {
  initWorkerEventHandler();
}

// ---------------------------------------------------------------------------
// Cleanup on process exit
// ---------------------------------------------------------------------------

export async function shutdownAllSessions(): Promise<void> {
  const running = Array.from(sessions.values()).filter(
    (s) => s.meta.status === "running"
  );
  await Promise.allSettled(running.map((s) => stopSession(s.meta.id)));
}
