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

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { KiroRunner } from "./agent/kiro-runner.js";
import type { SessionUpdateChunk } from "./agent/kiro-runner.js";
import { broadcast } from "./websocket-handler.js";
import { claimTask, markTaskDeveloped, resetTaskToTodo, getAvailableTaskCount } from "./agent/task-claimer.js";
import { buildDevPrompt } from "./agent/prompt-builder.js";
import { TabMcpConfig, DEFAULT_MCP_CONFIG } from "./types.js";
import {
  getAllSessionsFromDb,
  getRunningSessionsFromDb,
  insertSession,
  updateSessionStatus,
  updateSessionMeta,
  deleteSessionFromDb,
  isSessionOwnedByUser,
} from "./db/sessions.js";
import { getUserKiroApiKey, getUserById } from "./db/users.js";
import { getAllDecryptedCredentials, getDecryptedCredential } from "./db/credentials.js";
import { isDbAvailable } from "./db/connection.js";
import { recordError } from "./error-store.js";
import { log, logSessionEvent, logWorkerEvent, toErrorFields } from "./logger.js";
import { includesGenericTab, getAgentTabs, getTabById } from "./db/tabs.js";
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

const sessions = new Map<string, ManagedSession>();

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
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Persist all session metadata to the database.
 * Called after every state mutation so sessions survive server restarts.
 */
function persistSessions(): void {
  if (!isDbAvailable()) return;

  const allMeta = Array.from(sessions.values()).map((s) => s.meta);
  for (const meta of allMeta) {
    updateSessionMeta(meta).catch(() => {
      // DB write failed silently — will retry on next state change
    });
  }
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

  const toRestart: string[] = [];

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

function generateId(): string {
  return randomBytes(4).toString("hex");
}

function now(): string {
  return new Date().toISOString();
}

function appendOutput(session: ManagedSession, entry: OutputEntry): void {
  session.meta.output.push(entry);
  if (session.meta.output.length > MAX_OUTPUT_ENTRIES) {
    session.meta.output = session.meta.output.slice(-MAX_OUTPUT_ENTRIES);
  }
  broadcast({ type: "session-output", sessionId: session.meta.id, entry });
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
  broadcast({ type: "session-activity", sessionId: session.meta.id, activity });
}

function setStatus(session: ManagedSession, status: Session["status"]): void {
  session.meta.status = status;
  broadcast({ type: "session-updated", session: session.meta });
  persistSessions();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSession(input: CreateSessionInput): Session {
  const id = generateId();
  const session: ManagedSession = {
    meta: {
      id,
      name: input.name,
      agent: input.agent,
      status: "stopped",
      prompt: input.prompt || "",
      interactive: input.interactive !== false,
      loop: input.loop === true,
      runs: input.runs ?? 0,
      intervalSeconds: input.intervalSeconds ?? 10,
      cwd: input.cwd || DEFAULT_CWD,
      timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT,
      model: input.model,
      mcpServers: input.mcpServers,
      mcpConfigOverride: input.mcpConfigOverride ?? undefined,
      tabIds: input.tabIds,
      userId: input.userId ?? 0,
      createdAt: now(),
      output: [],
    },
    runner: null,
    abortController: null,
    messageBuffer: "",
    messageFlushTimer: null,
    lastToolLabel: "",
    lastToolCount: 0,
    acaExecutionName: null,
    acaPromptResolver: null,
    acaPromptRejecter: null,
  };

  sessions.set(id, session);
  broadcast({ type: "session-created", session: session.meta });
  persistSessions();

  // Structured log for Azure Monitor
  logSessionEvent("session-created", id, { agent: session.meta.agent, name: session.meta.name });

  // Also insert into DB if available
  if (isDbAvailable()) {
    insertSession(session.meta).catch((err) => {
      log.warn("session-db-insert-failed", {
        component: "session-manager",
        sessionId: id,
        ...toErrorFields(err),
      });
    });
  }

  return session.meta;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)?.meta;
}

export function getAllSessions(userId?: number): Session[] {
  return Array.from(sessions.values())
    .filter((s) => userId === undefined || s.meta.userId === userId)
    .map((s) => ({
    ...s.meta,
    // Don't include full output in list endpoint — too large
    output: [],
  }));
}

export function getSessionOutput(id: string): OutputEntry[] {
  const session = sessions.get(id);
  if (!session) return [];
  return session.meta.output;
}

export function deleteSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;

  // Stop first if running
  if (session.meta.status === "running") {
    stopSession(id);
  }

  sessions.delete(id);
  broadcast({ type: "session-deleted", sessionId: id });
  persistSessions();

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

export async function startSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.meta.status === "running") return true; // already running

  session.meta.output = [];
  session.meta.startedAt = now();
  setStatus(session, "running");
  setActivity(session, { type: "working", detail: "Starting ACP session..." });
  logSessionEvent("session-started", id, { agent: session.meta.agent, name: session.meta.name, mode: ACA_MODE ? "remote" : "local" });

  appendOutput(session, {
    timestamp: now(),
    stream: "system",
    text: ACA_MODE
      ? `Starting ACA worker for agent "${session.meta.agent}"...`
      : `Starting agent "${session.meta.agent}" in ${session.meta.cwd}...`,
  });

  // Spawn async — don't block the caller
  const launcher = ACA_MODE ? runSessionAca(session) : runSession(session);
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
    });
  });

  return true;
}

export async function stopSession(id: string): Promise<boolean> {
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

export async function sendPrompt(id: string, text: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.meta.status !== "running" || !session.runner) return false;
  if (!session.meta.interactive) return false;

  appendOutput(session, { timestamp: now(), stream: "system", text: `▶ ${text}` });
  setActivity(session, { type: "working", detail: "Processing prompt..." });

  // Run prompt in background
  streamPrompt(session, text).catch((err) => {
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

    // Create the KiroRunner (kiroApiKey is passed to env and used only during spawn)
    managed.runner = await KiroRunner.create({
      agent: meta.agent,
      cwd: meta.cwd,
      model: meta.model ?? null,
      mcpServers: meta.mcpServers?.map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env,
      })),
      kiroApiKey,
    });

    // Clear decrypted key from local scope — no longer needed
    kiroApiKey = undefined;

    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `ACP session established (PID: ${managed.runner.pid})`,
    });

    if (meta.loop) {
      // ─── Autonomous loop mode (like dev-agent.ts) ───
      await runLoopMode(managed, signal);
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

async function runLoopMode(
  managed: ManagedSession,
  signal: AbortSignal
): Promise<void> {
  const { meta } = managed;
  let iteration = 0;
  const maxRuns = meta.runs; // 0 = endless

  // Determine effective tab filter for task claiming:
  // If the session's tabs include "generic", the agent can work on tasks from ANY tab.
  // Otherwise, only claim tasks from the specific tabs assigned.
  let effectiveTabIds: number[] | undefined = meta.tabIds;
  if (meta.tabIds && meta.tabIds.length > 0) {
    const isGeneric = await includesGenericTab(meta.tabIds);
    if (isGeneric) {
      effectiveTabIds = undefined; // No filter — can claim from any tab
    }
  }

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

    // Check for available tasks (filtered by effective tab assignments)
    const todoCount = await getAvailableTaskCount(effectiveTabIds);

    if (todoCount === 0) {
      setActivity(managed, {
        type: "idle",
        detail: `No tasks available. Polling every ${meta.intervalSeconds}s...`,
      });

      // Wait before polling again
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
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

    const task = await claimTask(undefined, effectiveTabIds);
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
    broadcast({ type: "session-updated", session: meta });
    persistSessions();

    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `Claimed: [P${task.priority}] "${task.title}" (ID: ${task.id}, type: ${task.type})`,
    });

    setActivity(managed, {
      type: "working",
      detail: `Working on: ${task.title}`,
    });

    // Build and send the prompt
    const prompt = buildDevPrompt(task, meta.cwd);
    let success = true;

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
      });
    }

    // Update task state
    if (signal.aborted) {
      // Session was stopped mid-task — reset to todo
      await resetTaskToTodo(task.id);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task ${task.id} reset to "todo" (session stopped).`,
      });
      break;
    }

    if (success) {
      await markTaskDeveloped(task.id);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task ${task.id} marked as "developed" ✓`,
      });
    } else {
      await resetTaskToTodo(task.id);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task ${task.id} reset to "todo" (execution failed).`,
      });
    }

    meta.currentTaskId = undefined;
    broadcast({ type: "session-updated", session: meta });
    persistSessions();

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

async function streamPrompt(managed: ManagedSession, text: string): Promise<void> {
  if (!managed.runner) return;

  try {
    for await (const update of managed.runner.prompt(text)) {
      if (managed.abortController?.signal.aborted) break;
      processUpdate(managed, update);
    }
    // Flush any remaining buffered agent message text
    flushMessageBuffer(managed);
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

      case "tool_call":
        if (update.title) {
          const { icon, label } = getToolDisplayInfo(update.title);
          setActivity(managed, { type: "tool-call", detail: label });
          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: `${icon} ${label}`,
          });
        }
        break;

      case "tool_call_update":
        // Only log completion as a subtle indicator, not a full line
        if (update.status === "completed") {
          setActivity(managed, { type: "working", detail: "Processing..." });
        }
        break;

      case "thinking":
        setActivity(managed, { type: "thinking", detail: "Thinking..." });
        break;

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
    let gitOptions: { repositoryUrl: string; devBranch?: string; githubPat?: string } | null = null;
    if (meta.tabIds && meta.tabIds.length > 0) {
      for (const tabId of meta.tabIds) {
        const tab = await getTabById(tabId);
        if (tab?.repositoryUrl) {
          // Get GitHub PAT from user credentials if the repo is on GitHub
          let githubPat: string | undefined;
          if (tab.repositoryUrl.includes("github.com")) {
            const pat = await getDecryptedCredential(meta.userId, "githubPat");
            if (pat) githubPat = pat;
          }
          gitOptions = { repositoryUrl: tab.repositoryUrl, devBranch: "develop", githubPat };
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
    const execution = await startWorkerJob(
      acaConfig,
      meta.id,
      meta.agent,
      meta.userId,
      meta.timeoutSeconds,
      mcpSidecar,
      gitOptions
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
      await runLoopModeAca(managed, signal);
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
 * Send a prompt to an ACA worker and wait for prompt-done response.
 */
async function streamPromptAca(managed: ManagedSession, text: string, taskMeta?: { id: number; title: string; type: string; description: string; files: string[] }): Promise<{ hasChanges?: boolean; prUrl?: string }> {
  if (!isWorkerConnected(managed.meta.id)) {
    throw new Error("Worker is not connected");
  }

  // Send the prompt to the worker (with optional task metadata for branch/commit/PR)
  const workerTaskMeta = taskMeta ? { id: taskMeta.id, title: taskMeta.title, type: taskMeta.type, description: taskMeta.description, files: taskMeta.files } : undefined;
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

  return (result && typeof result === "object") ? result as { hasChanges?: boolean; prUrl?: string } : {};
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

  let effectiveTabIds: number[] | undefined = meta.tabIds;
  if (meta.tabIds && meta.tabIds.length > 0) {
    const isGeneric = await includesGenericTab(meta.tabIds);
    if (isGeneric) {
      effectiveTabIds = undefined;
    }
  }

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

    const todoCount = await getAvailableTaskCount(effectiveTabIds);

    if (todoCount === 0) {
      setActivity(managed, {
        type: "idle",
        detail: `No tasks available. Polling every ${meta.intervalSeconds}s...`,
      });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
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

    const task = await claimTask(undefined, effectiveTabIds);
    if (!task) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: "Failed to claim task (race condition or empty queue).",
      });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
      continue;
    }

    meta.currentTaskId = task.id;
    broadcast({ type: "session-updated", session: meta });
    persistSessions();

    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `Claimed: [P${task.priority}] "${task.title}" (ID: ${task.id}, type: ${task.type})`,
    });

    setActivity(managed, { type: "working", detail: `Working on: ${task.title}` });

    const prompt = buildDevPrompt(task, meta.cwd);
    let success = true;
    let promptResult: { hasChanges?: boolean; prUrl?: string } = {};

    try {
      promptResult = await streamPromptAca(managed, prompt, { id: task.id, title: task.title, type: task.type, description: task.description, files: task.files });
    } catch (err) {
      success = false;
      const msg = err instanceof Error ? err.message : String(err);
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
      });
    }

    if (signal.aborted) {
      await resetTaskToTodo(task.id);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task ${task.id} reset to "todo" (session stopped).`,
      });
      break;
    }

    // Check if the worker produced any file changes
    if (success && !promptResult.hasChanges) {
      success = false;
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `⚠ No file changes detected after agent execution — task reset to "todo".`,
      });
    }

    if (success && promptResult.prUrl) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Pull Request: ${promptResult.prUrl}`,
      });
    }

    if (success) {
      await markTaskDeveloped(task.id);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task ${task.id} marked as "developed" ✓`,
      });
    } else {
      await resetTaskToTodo(task.id);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: `Task ${task.id} reset to "todo" (execution failed).`,
      });
    }

    meta.currentTaskId = undefined;
    broadcast({ type: "session-updated", session: meta });
    persistSessions();

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
    onWorkerReady(sessionId: string, acpSessionId: string) {
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
        text: `Worker ready (ACP session: ${acpSessionId})`,
      });
      setActivity(session, { type: "idle", detail: "Worker connected" });
    },

    onWorkerOutput(sessionId: string, entry: OutputEntry) {
      const session = sessions.get(sessionId);
      if (!session) return;
      appendOutput(session, entry);
    },

    onWorkerSessionUpdate(sessionId: string, update: unknown) {
      const session = sessions.get(sessionId);
      if (!session) return;
      // Route through the same processUpdate logic used for local mode
      if (update && typeof update === "object") {
        processUpdate(session, update as SessionUpdateChunk);
      }
    },

    onWorkerPromptDone(sessionId: string, _result: unknown) {
      const session = sessions.get(sessionId);
      if (!session) return;
      flushMessageBuffer(session);
      setActivity(session, { type: "idle", detail: "Ready for next prompt" });
      // Resolve the awaiter in streamPromptAca
      if (session.acaPromptResolver) {
        session.acaPromptResolver(_result);
        session.acaPromptResolver = null;
        session.acaPromptRejecter = null;
      }
    },

    onWorkerExited(sessionId: string, exitCode: number | null, signal: string | null) {
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

    onWorkerShutdown(sessionId: string, exitCode: number) {
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
