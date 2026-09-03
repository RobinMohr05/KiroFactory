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
import { claimTask, resolveTask, resetTask, getAvailableTaskCount, waitForTaskAvailable, markTaskDone, findSiblingTasks, findSiblingTasksByGroupId, describeClaimFailure } from "./agent/task-claimer.js";
import type { ClaimedTask } from "./agent/task-claimer.js";
import { buildDevPrompt, buildReviewPrompt } from "./agent/prompt-builder.js";
import { hasLocalGitChanges } from "./agent/local-git-check.js";
import { buildPersistentBranchName, buildTaskBranchName, sanitizeBranchName } from "./agent/repo-url-parser.js";
import { resolveGitProvider, type GitProvider } from "./types.js";
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
import { getTaskAutoMergePrs, areAllGroupTasksDone, createTask } from "./db/tasks.js";
import { recordError, type RecordErrorInput } from "./error-store.js";
import { log, logSessionEvent, logWorkerEvent, toErrorFields } from "./logger.js";
import { getAgentTabs, getTabById } from "./db/tabs.js";
import { getAgentByName } from "./db/agents.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { materializeAgentConfigIfMissing, encodeAgentConfigBase64 } from "./agent/agent-config-writer.js";
import {
  buildDeliveryResultPath,
  buildLocalGitDeliveryServer,
  buildLocalPrReviewServer,
  type LocalGitDeliveryContext,
  type DeliveryResult,
} from "./agent/local-git-delivery.js";
import { buildProxyServersConfig, type SessionCredentials } from "./mcp-proxy-config.js";
import {
  loadAcaConfig,
  startWorkerJob as startAcaWorkerJob,
  stopWorkerJob as stopAcaWorkerJob,
  getWorkerJobStatus as getAcaWorkerJobStatus,
  isAcaModeEnabled,
  type AcaWorkerConfig,
  type AcaJobExecution,
  type McpProxySidecarConfig,
} from "./aca-worker-spawner.js";
import {
  loadWslConfig,
  startWorkerJob as startWslWorkerJob,
  stopWorkerJob as stopWslWorkerJob,
  getWorkerJobStatus as getWslWorkerJobStatus,
  captureContainerLogs as captureWslContainerLogs,
  isWslModeEnabled,
  type WslWorkerConfig,
} from "./wsl-worker-spawner.js";
import {
  setWorkerEventHandler,
  sendWorkerPrompt,
  sendWorkerStop,
  isWorkerConnected,
  connectToLocalWorker,
  type WorkerEventHandler,
} from "./worker-ws-handler.js";
import type {
  Session,
  OutputEntry,
  Activity,
  CreateSessionInput,
  UpdateSessionInput,
  McpServerConfig,
  TurnEndSummary,
} from "./types.js";
import { createTurn, completeTurn, createErrorEvent, getMaxTurnNumber } from "./db/turns.js";

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
const wslConfig = loadWslConfig();

/**
 * WORKER_MODE controls how non-forceLocal sessions spawn agent processes:
 * - "remote" — Launch an Azure Container Apps Job; worker connects back via
 *   internal WebSocket.
 * - "local"  — Launch a local Docker container inside the dedicated WSL2
 *   distro (see ARCHITECTURE.md §12); worker connects back via the same
 *   internal WebSocket mechanism as "remote". This replaced the old bare
 *   `kiro-cli acp` child-process spawn (KiroRunner) for this path.
 *
 * `forceLocal` sessions (the task planner's pre-warmed pool) are a separate
 * concern entirely and always use KiroRunner regardless of WORKER_MODE — see
 * the `useLocal` dispatch in startSession().
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
 * Absolute path both the ACA worker container and the local WSL/Docker worker
 * container clone the repository into (WORKSPACE in worker/worker.js — the
 * same image, hence the same path, is used for both).
 *
 * Prompts for containerized workers must use this, not `meta.cwd`: the
 * orchestrator's own cwd is /app inside its container, and telling the agent
 * that /app is the working directory sends it exploring the orchestrator's
 * image layout instead of the checked-out repository.
 */
const ACA_WORKSPACE_PATH = "/workspace";

// ---------------------------------------------------------------------------
// Container worker spawner abstraction
//
// runSessionAca()/waitForWorkerOrAbort() below are shared between the ACA
// (hosted) and WSL/Docker (local) execution paths — both spawn a container
// running the same worker/.devcontainer image, and both connect back over
// the same internal WebSocket. Only how the container is *started* differs,
// so that's the one seam abstracted here rather than forking the (much
// larger) turn-execution/loop logic a second time.
// ---------------------------------------------------------------------------

/** A spawned worker container/job, regardless of which backend started it. */
interface ContainerWorkerExecution {
  executionName: string;
  status: string;
}

/** Status of a previously-started worker container/job. */
interface ContainerWorkerStatus {
  status: string;
  startTime?: string;
  endTime?: string;
}

/**
 * Uniform surface over aca-worker-spawner.ts and wsl-worker-spawner.ts.
 * Both modules already share this exact function shape by construction
 * (wsl-worker-spawner.ts was written as a structural parallel) — this
 * interface just names that shape so callers don't need to know which
 * backend they're talking to.
 */
interface ContainerWorkerSpawner {
  readonly kind: "aca" | "wsl";
  start(
    sessionId: number,
    agentName: string,
    userId: number,
    timeoutSeconds: number,
    mcpSidecar: McpProxySidecarConfig | null | undefined,
    gitOptions: unknown,
    agentKind: "editor" | "inspector" | undefined,
    agentConfigBase64: string | undefined,
    model: string | null | undefined
  ): Promise<ContainerWorkerExecution>;
  stop(executionName: string): Promise<void>;
  status(executionName: string): Promise<ContainerWorkerStatus>;
  /** Whether this backend's MCP proxy sidecar image is configured (gates sidecar setup). */
  hasProxyImage(): boolean;
}

function makeAcaSpawner(config: AcaWorkerConfig): ContainerWorkerSpawner {
  return {
    kind: "aca",
    start: (sessionId, agentName, userId, timeoutSeconds, mcpSidecar, gitOptions, agentKind, agentConfigBase64, model) =>
      startAcaWorkerJob(
        config,
        sessionId,
        agentName,
        userId,
        timeoutSeconds,
        mcpSidecar,
        gitOptions as Parameters<typeof startAcaWorkerJob>[6],
        agentKind,
        agentConfigBase64,
        model
      ),
    stop: (executionName) => stopAcaWorkerJob(config, executionName),
    status: (executionName) => getAcaWorkerJobStatus(config, executionName),
    hasProxyImage: () => !!config.proxyImage,
  };
}

function makeWslSpawner(config: WslWorkerConfig): ContainerWorkerSpawner {
  return {
    kind: "wsl",
    start: async (sessionId, agentName, userId, timeoutSeconds, mcpSidecar, gitOptions, agentKind, agentConfigBase64, model) => {
      const execution = await startWslWorkerJob(
        config,
        sessionId,
        agentName,
        userId,
        timeoutSeconds,
        mcpSidecar,
        gitOptions as Parameters<typeof startWslWorkerJob>[6],
        agentKind,
        agentConfigBase64,
        model
      );

      // Reversed connection direction (see wsl-worker-spawner.ts's module doc
      // comment): the worker container listens, and the backend dials into
      // it here — rather than the worker dialing the orchestrator's
      // /internal/worker endpoint like the ACA path does. If this fails, the
      // container is still running but unreachable — stop it rather than
      // leaving an orphaned container behind for a session that never
      // actually started from the caller's point of view.
      try {
        await connectToLocalWorker(`ws://localhost:${execution.publishedPort}`, sessionId);
      } catch (err) {
        await stopWslWorkerJob(config, execution.executionName).catch(() => {});
        throw err;
      }

      return execution;
    },
    stop: (executionName) => stopWslWorkerJob(config, executionName),
    status: (executionName) => getWslWorkerJobStatus(config, executionName),
    hasProxyImage: () => !!config.proxyImage,
  };
}

/**
 * Resolve which container backend a given session should use.
 *
 * - `forceLocal` sessions never reach this — they use KiroRunner (see
 *   startSession()'s `useLocal` dispatch).
 * - Otherwise: ACA in remote mode, WSL/Docker in local mode.
 *
 * Throws if the resolved mode's configuration is missing, mirroring the
 * previous `if (!acaConfig) throw ...` guard at the top of runSessionAca().
 */
function resolveContainerSpawner(): ContainerWorkerSpawner {
  if (ACA_MODE) {
    if (!acaConfig) {
      throw new Error("ACA mode enabled but configuration is missing");
    }
    return makeAcaSpawner(acaConfig);
  }
  if (!wslConfig) {
    throw new Error(
      "Local worker mode requires WSL/Docker configuration (ACA_WORKER_SECRET or WSL_WORKER_SECRET) " +
      "but none is set. See worker/.devcontainer/README.md."
    );
  }
  return makeWslSpawner(wslConfig);
}

log.info("worker-mode", {
  component: "session-manager",
  mode: ACA_MODE ? "remote" : "local",
  msg: ACA_MODE
    ? "Remote worker mode — sessions spawn as Azure Container Apps Jobs"
    : "Local worker mode — sessions spawn as local Docker containers inside the kirofactory-docker WSL distro",
});

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

const sessions = new Map<number, ManagedSession>();

export interface ManagedSession {
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
  /** Which container backend (ACA or WSL/Docker) started acaExecutionName, if any — set by runSessionAca(). */
  containerSpawner: ContainerWorkerSpawner | null;
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
  /** Turn number counter — incremented on each prompt send for this session. */
  turnNumber: number;
  /** Number of turns completed/started this run (resets on session start, used for REST API). */
  turnCountThisRun: number;
  /** Timestamp when the current turn started (for computing durationMs). */
  turnStartedAt: string | null;
  /** Tool call count in the current turn (for turn-end summary). */
  turnToolCallCount: number;
  /** Active tool calls with their start times, keyed by toolCallId. */
  turnActiveToolCalls: Map<string, number>;
  /**
   * Last generated fallback toolCallId (when ACP doesn't provide one on tool_call).
   * Used to correlate the subsequent tool_call_update which also won't have a toolCallId.
   * Reset after use or when the next tool_call arrives.
   */
  lastGeneratedToolCallId: string | null;
  /**
   * When true, this run is a scheduled one-shot: the interactive start path
   * sends the prompt exactly once and then stops the session instead of
   * staying alive for follow-ups. Set by runOneShotTurn() before startSession()
   * and cleared when the run settles.
   */
  oneShot: boolean;
  /**
   * Resolver/rejecter for the in-flight one-shot run (runOneShotTurn awaits
   * this). Resolved when the single turn completes cleanly; rejected on turn
   * failure or worker/runner error.
   */
  oneShotResolver: (() => void) | null;
  oneShotRejecter: ((err: Error) => void) | null;
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
      containerSpawner: null,
      acaPromptResolver: null,
      acaPromptRejecter: null,
      totalCreditsUsed: 0,
      turnVerdict: null,
      verdictToolCallId: null,
      pendingRunner: null,
      turnNumber: 0,
      turnCountThisRun: 0,
      turnStartedAt: null,
      turnToolCallCount: 0,
      turnActiveToolCalls: new Map(),
      lastGeneratedToolCallId: null,
      oneShot: false,
      oneShotResolver: null,
      oneShotRejecter: null,
    });

    // Check if this session should auto-restart.
    // We detect this by checking if sessions.json had it as "running" before loadSessions reset it.
    // Since loadSessions() already set it to "stopped", we need a different signal.
    // We'll use a flag from loadSessions instead.
    //
    // Scheduled (cron) sessions are one-shot, not persistent-running — they
    // must never be auto-restarted here. Their schedule is (re)armed by the
    // scheduled-session-manager's initScheduledSessions() instead.
    if ((meta as any).__wasRunning && !meta.cronExpression) {
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

/**
 * Record an error both in the in-memory error store (for live UI) and persist
 * it to the DB as an ErrorEvent node linked to the session (for historical review).
 */
/** How many trailing output lines to snapshot into an AgentError's recentOutput field. */
const ERROR_RECENT_OUTPUT_LINES = 25;

/**
 * Record an error both in the in-memory error store (for live UI) and persist
 * it to the DB as an ErrorEvent node linked to the session (for historical review).
 *
 * `managed`, when provided, is used to automatically enrich the error with
 * context that previously existed only in memory and was never attached to
 * the error record: a trailing snippet of the session's own output log (see
 * appendOutput()) and current turn stats (turn number, tool call count,
 * elapsed turn duration). This was the main reason agent errors were hard to
 * diagnose from the Errors/Logs tab alone — the flat message/context strings
 * (e.g. "Worker disconnected") threw away everything about what the agent
 * was actually doing right before the failure, even though that history was
 * sitting right there in session.meta.output the whole time.
 */
function recordSessionError(input: {
  sessionId: number;
  sessionName: string;
  agent: string;
  message: string;
  context: string;
  taskId?: number;
  taskTitle?: string;
  userId: number;
  /**
   * How this error was surfaced — "automatic" (default) for
   * orchestrator-detected errors, "self-reported" for report_agent_error.
   */
  source?: "automatic" | "self-reported";
  /** Raw error object, when available — its stack trace is attached if present. */
  err?: unknown;
  /** The live session, for automatic recentOutput/turn-stats enrichment. */
  managed?: ManagedSession;
}): void {
  const stack = input.err instanceof Error ? input.err.stack : undefined;

  let recentOutput: RecordErrorInput["recentOutput"];
  let turnNumber: number | undefined;
  let turnDurationMs: number | undefined;
  let toolCallCount: number | undefined;
  if (input.managed) {
    const output = input.managed.meta.output;
    if (output.length > 0) {
      recentOutput = output.slice(-ERROR_RECENT_OUTPUT_LINES).map((e) => ({
        timestamp: e.timestamp,
        stream: e.stream,
        text: e.text,
      }));
    }
    turnNumber = input.managed.turnNumber || undefined;
    toolCallCount = input.managed.turnToolCallCount || undefined;
    if (input.managed.turnStartedAt) {
      turnDurationMs = Date.parse(now()) - Date.parse(input.managed.turnStartedAt);
    }
  }

  recordError({
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    agent: input.agent,
    message: input.message,
    context: input.context,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    userId: input.userId,
    source: input.source,
    stack,
    recentOutput,
    turnNumber,
    turnDurationMs,
    toolCallCount,
  });

  // Persist to DB — fire-and-forget, non-fatal
  if (isDbAvailable()) {
    createErrorEvent({
      sessionId: input.sessionId,
      timestamp: now(),
      message: input.message,
      taskId: input.taskId ?? null,
      taskTitle: input.taskTitle ?? null,
    }).catch(() => { /* best effort */ });
  }
}

/**
 * Handle an agent's self-reported error, forwarded by the worker over the
 * WebSocket as an "agent-error" action (originating from the report_agent_error
 * MCP tool). Reuses the same session-context gathering as the automatic
 * recordSessionError call sites (sessionName, agent, userId, current
 * taskId/taskTitle), tagging the record with source "self-reported" so it can
 * be distinguished from orchestrator-detected errors.
 *
 * A no-op for an unknown/unregistered session id.
 */
export function handleWorkerAgentError(sessionId: number, message: string, context: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  recordSessionError({
    sessionId: session.meta.id,
    sessionName: session.meta.name,
    agent: session.meta.agent,
    message,
    context,
    taskId: session.meta.currentTaskId,
    taskTitle: session.meta.currentTaskTitle,
    userId: session.meta.userId,
    source: "self-reported",
    managed: session,
  });
}

/**
 * Handle a task spec reported by an inspector-kind agent, forwarded by the
 * worker over the WebSocket as a "task-create" action (originating from the
 * create_task MCP tool — see task-create-mcp-server.js). Creates a real
 * DB-backed task via the same createTask() the authenticated POST /api/tasks
 * route calls, tagged origin "ai" and scoped to the session's own tabs, then
 * broadcasts task-created so the board updates live. Mirrors
 * handleWorkerAgentError's session-lookup-then-no-op-if-missing shape.
 *
 * A no-op for an unknown/unregistered session id.
 */
export async function handleWorkerTaskCreate(
  sessionId: number,
  spec: { title: string; description: string; type: "improvement" | "bug" | "feature"; priority: 1 | 2 | 3 | 4; files: string[] }
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  try {
    const task = await createTask({
      title: spec.title,
      description: spec.description,
      type: spec.type,
      priority: spec.priority,
      files: spec.files,
      origin: "ai",
      tabIds: session.meta.tabIds,
    });
    broadcastToUser(session.meta.userId, { type: "task-created", task });
    appendOutput(session, {
      timestamp: now(),
      stream: "system",
      text: `Task created: "${task.title}" (#${task.id})`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendOutput(session, {
      timestamp: now(),
      stream: "stderr",
      text: `Warning: Failed to create task from agent report: ${msg}`,
    });
  }
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
    excludedMcpServerNames: input.excludedMcpServerNames?.length ? input.excludedMcpServerNames : undefined,
    rawMcpServers: input.rawMcpServers,
    tabIds: input.tabIds,
    userId: input.userId ?? 0,
    createdAt: now(),
    output: [],
    pinned: input.pinned === true,
    isPermanent: input.isPermanent === true,
    sortOrder: 0, // placeholder — calculated below
    forceLocal: input.forceLocal === true,
    cronExpression: input.cronExpression || undefined,
    cronTimezone: input.cronTimezone || undefined,
    retries: input.retries != null ? input.retries : undefined,
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
    containerSpawner: null,
    acaPromptResolver: null,
    acaPromptRejecter: null,
    totalCreditsUsed: 0,
    turnVerdict: null,
    verdictToolCallId: null,
    pendingRunner: null,
    turnNumber: 0,
    turnCountThisRun: 0,
    turnStartedAt: null,
    turnToolCallCount: 0,
    turnActiveToolCalls: new Map(),
    lastGeneratedToolCallId: null,
    oneShot: false,
    oneShotResolver: null,
    oneShotRejecter: null,
  };

  sessions.set(meta.id, session);
  broadcastToUser(session.meta.userId, { type: "session-created", session: sanitizeSessionForClient(session.meta) });

  // Structured log for Azure Monitor
  logSessionEvent("session-created", meta.id, { agent: meta.agent, name: meta.name });

  return session.meta;
}

export function getSession(id: number): Session | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  return session.meta;
}

/** Get the per-run turn count for a session (survives WS reconnection). */
export function getSessionTurnCount(id: number): number {
  return sessions.get(id)?.turnCountThisRun ?? 0;
}

// ---------------------------------------------------------------------------
// Scheduled (cron) one-shot session support
// ---------------------------------------------------------------------------

/** Current status of a session, or undefined if it doesn't exist. */
export function getSessionStatus(id: number): Session["status"] | undefined {
  return sessions.get(id)?.meta.status;
}

/**
 * All in-memory sessions that have a cronExpression configured — used by the
 * scheduled-session-manager to arm timers on boot.
 */
export function getScheduledSessions(): Session[] {
  return Array.from(sessions.values())
    .filter((s) => !!s.meta.cronExpression)
    .map((s) => s.meta);
}

/** Append a system output line to a session (used for the skip notice). */
export function appendScheduledSystemLine(id: number, text: string): void {
  const session = sessions.get(id);
  if (!session) return;
  appendOutput(session, { timestamp: now(), stream: "system", text });
}

/**
 * Record one AgentError for a failed scheduled-run attempt, tagged with the
 * attempt number out of the total (e.g. "attempt 2/3").
 */
export function recordScheduledAttemptError(
  id: number,
  attempt: number,
  totalAttempts: number,
  err: unknown
): void {
  const session = sessions.get(id);
  if (!session) return;
  const msg = err instanceof Error ? err.message : String(err);
  recordSessionError({
    sessionId: session.meta.id,
    sessionName: session.meta.name,
    agent: session.meta.agent,
    message: `Scheduled run failed (attempt ${attempt}/${totalAttempts}): ${msg}`,
    context: `Scheduled one-shot run of session "${session.meta.name}" (ID: ${session.meta.id}) failed on attempt ${attempt} of ${totalAttempts}.`,
    userId: session.meta.userId,
    err,
    managed: session,
  });
}

/**
 * The outcome of an ACA/remote one-shot turn, as decided from its
 * WorkerPromptResult. `resolve` = the turn succeeded and the one-shot promise
 * should resolve; `reject` = the turn failed and the scheduler should retry +
 * record a per-attempt AgentError (`reason` is the Error message, `logText`
 * the stderr line to surface in the session output).
 */
export type OneShotAcaClassification =
  | { outcome: "resolve" }
  | { outcome: "reject"; reason: string; logText: string };

/**
 * Classify an ACA/remote one-shot turn result as success or failure.
 *
 * The local `streamPrompt` path throws on failure and so reaches
 * `startSession`'s reject path directly, but `streamPromptAca` returns a
 * WorkerPromptResult instead of throwing. This mirrors the exact failure
 * signals `runLoopModeAca` checks so an ACA/remote scheduled turn that failed
 * rejects (→ retry + per-attempt AgentError) instead of silently resolving as
 * a success:
 *   - `mcpServerInitFailures` — a required MCP server failed to start, so the
 *     agent was missing tools it expected and the result isn't trustworthy
 *     (runLoopModeAca ~line 3653). Checked first: it invalidates any other
 *     signal the turn reported.
 *   - `error` — an ACP error, timeout, or git failure (runLoopModeAca ~line 3612).
 *   - `stopReason === "cancelled"` — the turn was cut off (timeout / explicit
 *     cancel) before reaching end_turn (runLoopModeAca ~line 3660).
 */
export function classifyOneShotAcaResult(
  result: WorkerPromptResult | undefined
): OneShotAcaClassification {
  if (result?.mcpServerInitFailures?.length) {
    const failedNames = result.mcpServerInitFailures
      .map((f) => f.name || "unknown")
      .join(", ");
    return {
      outcome: "reject",
      reason: `Required MCP server(s) failed to initialize this turn: ${failedNames} — any verdict/result reported is unreliable`,
      logText: `MCP server(s) [${failedNames}] failed to start — the agent was missing tools it needed.`,
    };
  }
  if (result?.error) {
    return {
      outcome: "reject",
      reason: result.error,
      logText: `Agent turn failed: ${result.error}`,
    };
  }
  if (result?.stopReason === "cancelled") {
    const reason = "Agent turn was cancelled (timeout) before completing — stopReason: cancelled";
    return { outcome: "reject", reason, logText: reason };
  }
  return { outcome: "resolve" };
}

/**
 * Run a scheduled session's prompt exactly once: start it as a one-shot
 * (interactive, non-loop) run, wait for the single turn to complete, then stop
 * the session so it returns to "stopped". Resolves on success; rejects if the
 * turn fails or the session errors during startup/execution.
 *
 * Caller (scheduled-session-manager) is responsible for retry/skip logic.
 */
export async function runOneShotTurn(id: number): Promise<void> {
  const session = sessions.get(id);
  if (!session) throw new Error(`Session ${id} not found`);
  if (session.meta.status === "running") {
    throw new Error(`Session ${id} is already running`);
  }

  session.oneShot = true;

  const done = new Promise<void>((resolve, reject) => {
    session.oneShotResolver = () => {
      session.oneShotResolver = null;
      session.oneShotRejecter = null;
      resolve();
    };
    session.oneShotRejecter = (err: Error) => {
      session.oneShotResolver = null;
      session.oneShotRejecter = null;
      reject(err);
    };
  });

  try {
    await startSession(id);
    await done;
  } finally {
    session.oneShot = false;
    session.oneShotResolver = null;
    session.oneShotRejecter = null;
    // Return the session to "stopped" — a one-shot must never stay running.
    try {
      await stopSession(id);
    } catch {
      /* best effort */
    }
  }
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
    // Per-run turn count for the frontend (survives WS reconnection)
    turnCount: s.turnCountThisRun,
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
  if (updates.excludedMcpServerNames !== undefined) session.meta.excludedMcpServerNames = updates.excludedMcpServerNames?.length ? updates.excludedMcpServerNames : undefined;
  if (updates.tabIds !== undefined) session.meta.tabIds = updates.tabIds?.length ? updates.tabIds : undefined;
  if (updates.cronExpression !== undefined) session.meta.cronExpression = updates.cronExpression || undefined;
  if (updates.cronTimezone !== undefined) session.meta.cronTimezone = updates.cronTimezone || undefined;
  if (updates.retries !== undefined) session.meta.retries = updates.retries != null ? updates.retries : undefined;

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
  // Load the max turn number from the DB to continue numbering without
  // collisions with Turn nodes from previous runs of this session.
  let maxTurn = 0;
  if (isDbAvailable()) {
    try {
      maxTurn = await getMaxTurnNumber(id);
    } catch { /* best effort — start from 0 if DB is unreachable */ }
  }
  session.turnNumber = maxTurn;
  session.turnCountThisRun = 0;
  session.turnStartedAt = null;
  session.turnToolCallCount = 0;
  session.turnActiveToolCalls.clear();
  session.lastGeneratedToolCallId = null;
  setStatus(session, "running");
  setActivity(session, { type: "working", detail: "Starting ACP session..." });
  logSessionEvent("session-started", id, { agent: session.meta.agent, name: session.meta.name, mode: session.meta.forceLocal ? "kiro-runner" : (ACA_MODE ? "remote" : "local-container") });

  appendOutput(session, {
    timestamp: now(),
    stream: "system",
    text: session.meta.forceLocal
      ? session.meta.agent
        ? `Starting agent "${session.meta.agent}" in ${session.meta.cwd}...`
        : `Starting interactive session in ${session.meta.cwd}...`
      : ACA_MODE
        ? session.meta.agent
          ? `Starting ACA worker for agent "${session.meta.agent}"...`
          : `Starting ACA worker (no agent)...`
        : session.meta.agent
          ? `Starting local worker container for agent "${session.meta.agent}"...`
          : `Starting local worker container (no agent)...`,
  });

  // Spawn async — don't block the caller.
  //
  // forceLocal sessions (e.g. the task planner's pre-warmed pool) always use
  // the in-process KiroRunner (bare `kiro-cli acp` child process) regardless
  // of WORKER_MODE — that's a separate low-latency planning concern, not the
  // dev-session worker path this module otherwise manages.
  //
  // Every other session goes through runSessionAca(), which spawns a
  // containerized worker via whichever backend resolveContainerSpawner()
  // picks: an ACA Job in remote mode, or a local Docker container inside the
  // dedicated kirofactory-docker WSL distro in local mode (see
  // ARCHITECTURE.md §12). Both connect back over the same internal
  // WebSocket, so runSessionAca()'s turn/loop logic needs no further
  // branching between the two.
  const launcher = session.meta.forceLocal ? runSession(session) : runSessionAca(session);
  launcher.catch((err) => {
    // Never surface a blank "Fatal:" line — a thrown Error with an empty
    // .message (seen from some socket-level failures, e.g. certain ws
    // "error" events) used to produce exactly that, with the only trace of
    // the real cause left in the stack passed to logSessionEvent below.
    // Falling back through name → toString() → a generic placeholder means
    // there's always *something* actionable in the UI-visible line too.
    const msg = toErrorFields(err).error;
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

    // One-shot (scheduled) run: reject the awaiter so runOneShotTurn() can
    // apply its per-attempt retry/error logic. The tagged per-attempt
    // AgentError is recorded by the scheduler, so we DON'T also record the
    // generic fatal error here (it would double-count every failed attempt).
    if (session.oneShot && session.oneShotRejecter) {
      const rejecter = session.oneShotRejecter;
      session.oneShotResolver = null;
      session.oneShotRejecter = null;
      rejecter(err instanceof Error ? err : new Error(msg));
      return;
    }

    // Record the error for the UI
    recordSessionError({
      sessionId: session.meta.id,
      sessionName: session.meta.name,
      agent: session.meta.agent,
      message: msg,
      context: "Fatal error during session startup/execution",
      taskId: session.meta.currentTaskId,
      taskTitle: undefined,
      userId: session.meta.userId,
      err,
      managed: session,
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

  // Containerized worker (ACA or local WSL/Docker): send stop to worker + tear down the container.
  // Gated on containerSpawner (set by runSessionAca() when it started the container),
  // not on ACA_MODE — local WSL/Docker sessions need teardown too, and ACA_MODE is
  // false for those.
  if (session.containerSpawner && session.acaExecutionName) {
    // Send stop signal to worker via WebSocket (triggers graceful shutdown)
    sendWorkerStop(id);

    // Tear down the container/job via whichever backend started it
    session.containerSpawner.stop(session.acaExecutionName).catch((err) => {
      console.warn(`[session-manager] Failed to stop worker ${session.acaExecutionName}:`, err);
    });
    session.acaExecutionName = null;
    session.containerSpawner = null;

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

export async function sendPrompt(id: number, text: string, images?: { data: string; mimeType: string }[]): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.meta.status !== "running") return false;
  if (!session.meta.interactive) return false;

  // Must have either a local KiroRunner (forceLocal sessions) or a connected
  // containerized worker (ACA or local WSL/Docker — both look identical here,
  // since both connect over the same internal WebSocket).
  const hasLocalRunner = !!session.runner;
  const hasContainerWorker = !!session.containerSpawner && isWorkerConnected(id);
  if (!hasLocalRunner && !hasContainerWorker) return false;

  // Image attachments are only supported for the in-process KiroRunner path.
  if (images && images.length > 0 && hasContainerWorker) {
    throw new Error("Image attachments are not supported for sessions running in a containerized worker");
  }

  appendOutput(session, { timestamp: now(), stream: "system", text: `▶ ${text}` });
  setActivity(session, { type: "working", detail: "Processing prompt..." });

  // Run prompt in background
  const promptFn = hasContainerWorker
    ? streamPromptAca(session, text)
    : streamPrompt(session, text, images);

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
      // Resolve agent-owned MCP servers (minus per-session exclusions)
      let agentMcpServers: McpServerConfig[] = [];
      if (meta.agent) {
        try {
          const agentRecord = await getAgentByName(meta.agent);
          if (agentRecord?.mcpServers?.length) {
            agentMcpServers = resolveAgentMcpServers(agentRecord.mcpServers, meta.excludedMcpServerNames);
            if (agentMcpServers.length > 0) {
              appendOutput(managed, {
                timestamp: now(),
                stream: "system",
                text: `MCP servers from agent "${meta.agent}": ${agentMcpServers.map((s) => s.name).join(", ")}`,
              });
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendOutput(managed, {
            timestamp: now(),
            stream: "stderr",
            text: `Warning: Could not resolve agent MCP servers: ${msg}. Continuing without agent MCP servers.`,
          });
        }
      }

      managed.runner = await KiroRunner.create({
        agent: meta.agent || undefined,
        cwd: meta.cwd,
        model: meta.model ?? null,
        mcpServers: [
          ...agentMcpServers,
          ...(meta.mcpServers?.map((s) => ({
            name: s.name,
            command: s.command,
            args: s.args,
            env: s.env,
          })) ?? []),
        ],
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

      // One-shot (scheduled) run: the prompt has completed exactly once —
      // signal success/failure and return so runOneShotTurn() can stop the
      // session. Mirrors the same MCP-init-failure check runLoopMode uses
      // (line ~1902): a required MCP server failing to start means the agent
      // was missing tools it expected, so whatever the turn produced isn't
      // trustworthy — reject instead of resolving so the scheduler retries.
      if (managed.oneShot) {
        if (managed.runner?.mcpServerInitFailures.length) {
          const failedNames = managed.runner.mcpServerInitFailures
            .map((f) => f.name || "unknown")
            .join(", ");
          appendOutput(managed, {
            timestamp: now(),
            stream: "stderr",
            text: `✖ MCP server(s) [${failedNames}] failed to start — the agent was missing tools it needed.`,
          });
          managed.oneShotRejecter?.(
            new Error(`Required MCP server(s) failed to initialize this turn: ${failedNames} — any verdict/result reported is unreliable`)
          );
        } else {
          managed.oneShotResolver?.();
        }
        return;
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
export interface AgentStageStates {
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
/**
 * Resolve the effective agent-owned MCP servers after applying per-session
 * exclusions. Pure function — extracted from the startup paths so it can be
 * unit-tested independently.
 *
 * Returns the filtered list (agent servers minus excluded names), which
 * callers prepend to the existing tab-toggle + session-only server lists.
 */
export function resolveAgentMcpServers(
  agentMcpServers: McpServerConfig[] | undefined,
  excludedNames: string[] | undefined
): McpServerConfig[] {
  const servers = agentMcpServers ?? [];
  if (servers.length === 0) return [];
  if (!excludedNames || excludedNames.length === 0) return servers;
  const excluded = new Set(excludedNames);
  return servers.filter((s) => !excluded.has(s.name));
}

/**
 * Look up the agent's configured stage states (and kind) from the DB.
 * Falls back to the default developer pipeline if the agent is not found
 * or has no stage states configured.
 */
export async function getAgentStageStates(agentName: string): Promise<AgentStageStates> {
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

/**
 * Renders a ClaimFailureDiagnosis (see task-claimer.ts) into the system-log
 * line shown after claimTask() returns null. Replaces the old unconditional
 * "race condition or empty queue" message, which was actively misleading in
 * the most common failure mode: a task blocked by a groupId sibling still
 * in workingState looks identical to a real race from the log alone, and
 * that case can persist for as long as the sibling stage takes (not a
 * transient blip), so it deserves its own message rather than being lumped
 * in with genuine CAS losses.
 */
function describeClaimFailureMessage(diagnosis: import("./agent/task-claimer.js").ClaimFailureDiagnosis): string {
  switch (diagnosis.reason) {
    case "group-locked":
      return (
        `Task ${diagnosis.blockedTaskId} ("${diagnosis.blockedTaskTitle}") is waiting on its group — ` +
        `sibling task ${diagnosis.blockingSiblingId} ("${diagnosis.blockingSiblingTitle}") is still being worked. ` +
        `Will retry once that task leaves its working state.`
      );
    case "race":
      return "Failed to claim task — a concurrent session likely claimed it first. Retrying.";
    case "empty":
    default:
      return "Failed to claim task (empty queue).";
  }
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

  // ─── Resolve git delivery context once per loop start ─────────────────
  // Mirrors runSessionAca's gitOptions resolution (tab -> repositoryUrl ->
  // provider -> PAT), so local editor-kind sessions can get the same
  // git-delivery/pr-review MCP tools the ACA path has. Resolved once here
  // (not per task) since it's session/tab-scoped, not task-scoped — only
  // TASK_BRANCH_NAME and the other per-task env vars vary per claimed task.
  // Non-fatal on failure: a session with no repo configured (or no stored
  // PAT) simply gets no git-delivery server, exactly like the ACA path logs
  // a warning and continues without pushing.
  let gitContext: LocalGitDeliveryContext | null = null;
  if (stages.kind === "editor" && effectiveTabIds && effectiveTabIds.length > 0) {
    try {
      for (const tabId of effectiveTabIds) {
        const tab = await getTabById(tabId);
        if (tab?.repositoryUrl) {
          const owner = await getUserById(meta.userId);
          const provider = resolveGitProvider(tab.gitProvider, owner?.defaultGitProvider, tab.repositoryUrl);

          let githubPat: string | undefined;
          let azureDevOpsPat: string | undefined;
          if (provider === "github") {
            githubPat = (await getDecryptedCredential(meta.userId, "githubPat")) || undefined;
          } else if (provider === "azure-devops") {
            azureDevOpsPat = (await getDecryptedCredential(meta.userId, "azureDevOpsPat")) || undefined;
          }

          gitContext = {
            repositoryUrl: tab.repositoryUrl,
            gitProvider: provider ?? null,
            devBranch: "develop",
            githubPat,
            azureDevOpsPat,
          };

          const hasCredential = !!githubPat || !!azureDevOpsPat;
          appendOutput(managed, {
            timestamp: now(),
            stream: hasCredential ? "system" : "stderr",
            text: provider
              ? `Git delivery: ${provider} configured for tab "${tab.name}"` +
                (hasCredential ? "" : ` — no ${provider === "github" ? "githubPat" : "azureDevOpsPat"} credential stored, push will fail`)
              : `Git provider could not be determined for ${tab.repositoryUrl} — git-delivery tools will not be available.`,
          });
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `Warning: Could not resolve git delivery context: ${msg}. Continuing without git-delivery MCP tools.`,
      });
      gitContext = null;
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

    // Wait until a task is available (event-driven — no DB poll while idle)
    const todoCount = await getAvailableTaskCount(effectiveTabIds, stages.claimState, stages.workingState);

    if (todoCount === 0) {
      setActivity(managed, {
        type: "idle",
        detail: "No tasks available. Waiting for new tasks...",
      });

      // Park here until a task is created/reset or the session is stopped.
      // waitForTaskAvailable does a single DB check, then suspends on an
      // in-process event — zero DB queries during the wait.
      await waitForTaskAvailable(effectiveTabIds, stages.claimState, signal, stages.workingState);
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
      const diagnosis = await describeClaimFailure(effectiveTabIds, stages.claimState, stages.workingState);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: describeClaimFailureMessage(diagnosis),
      });
      await interruptibleSleep(meta.intervalSeconds * 1000, signal);
      continue;
    }

    // Track current task
    meta.currentTaskId = task.id;
    meta.currentTaskTitle = task.title;
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
    //
    // For editor-kind tasks with a resolved git context, also (re)inject the
    // git-delivery MCP server (+ pr-review if this task already has a PR —
    // a rework pass) with THIS task's env vars (branch name, task id/title).
    // These are only known now, after claiming — see local-git-delivery.ts's
    // doc comment for why this can't be resolved once at loop start like
    // gitContext itself. deliveryResultPath is recomputed per task so a
    // stale result from a previous task can never be misread as this one's.
    let success = true;
    let deliveryResultPath: string | null = null;
    let taskBranchName: string | null = null;
    if (stages.kind === "editor" && gitContext) {
      taskBranchName = buildTaskBranchName(task.type, task.id, task.title);
      deliveryResultPath = buildDeliveryResultPath(meta.id);
      // Clear any leftover result from a previous task before this turn runs,
      // so a crash/skip can't cause a stale file to be misattributed below.
      try { if (existsSync(deliveryResultPath)) unlinkSync(deliveryResultPath); } catch { /* best effort */ }
    }
    try {
      let overrideServers: import("./agent/kiro-runner.js").McpServerEntry[] | undefined;
      if (taskBranchName && deliveryResultPath && gitContext) {
        const taskDeliveryCtx = {
          taskId: task.id,
          taskTitle: task.title,
          taskDescription: task.description,
          taskType: task.type,
          taskBranchName,
          pullRequestUrl: task.pullRequestUrl,
        };
        const servers = [
          buildLocalGitDeliveryServer(meta.cwd, gitContext, taskDeliveryCtx, deliveryResultPath),
          // pr-review is only useful once a PR exists to fetch comments from.
          task.pullRequestUrl
            ? buildLocalPrReviewServer(meta.id, gitContext, taskDeliveryCtx, "editor")
            : null,
        ].filter((s): s is import("./agent/kiro-runner.js").McpServerEntry => s !== null);
        if (servers.length > 0) {
          overrideServers = servers;
          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: `Git delivery tools for this task: ${servers.map((s) => s.name).join(", ")} (branch: ${taskBranchName})`,
          });
        }
      }
      await managed.runner?.newSession(undefined, overrideServers);
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
      await streamPrompt(managed, prompt, undefined, { id: task.id, title: task.title });
    } catch (err) {
      success = false;
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `Task execution error: ${msg}`,
      });

      // Record the error so it appears in the Errors tab
      recordSessionError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: msg,
        context: `Error while executing task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority})`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
        err,
        managed,
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
      recordSessionError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: `Required MCP server(s) failed to initialize this turn: ${failedNames} — any verdict/result reported is unreliable`,
        context: `Task "${task.title}" (ID: ${task.id}) ran with ${failedNames} unavailable.`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
        managed,
      });
    }

    // Read back the git-delivery result (if the task had a git context and the
    // agent called submit_task_changes this turn) BEFORE deciding task state —
    // mirrors worker.js's own DELIVERY_RESULT_PATH read-back in finishPromptTurn.
    // hasChanges below folds into the existing hasLocalGitChanges commit gate
    // so a successful MCP-driven commit/push is recognized exactly like a
    // manually-committed change was already recognized; branchName/prUrl (when
    // present) are the ONLY new git facts this turn produced, so they're what
    // gets persisted onto the task alongside its resolved/reset state.
    let deliveryResult: DeliveryResult | null = null;
    if (deliveryResultPath) {
      try {
        if (existsSync(deliveryResultPath)) {
          deliveryResult = JSON.parse(readFileSync(deliveryResultPath, "utf-8")) as DeliveryResult;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `Warning: could not read git delivery result: ${msg}`,
        });
      }
    }
    const deliveredBranchName = deliveryResult?.branchName || taskBranchName || undefined;
    const deliveredPrUrl = deliveryResult?.prUrl || undefined;
    const hasDeliveredChanges = !!deliveryResult?.committed || !!deliveryResult?.pushed;
    if (deliveryResult?.error && !deliveryResult.pushed) {
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `✖ Git delivery reported an error: ${deliveryResult.error}`,
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
      //
      // Note (task #1599): runLoopModeAca() has an additional safety net here that
      // sends an inspector's "no_action_needed" back to "todo" when the task has
      // no PR URL recorded at all. That check is NOT replicated in this local-mode
      // loop: local mode has no git-delivery MCP round-trip that reports a PR URL
      // per turn, and `task.pullRequestUrl` here reflects whatever the ACA/local
      // dev-agent pipeline stored previously (if anything) rather than something
      // this loop can verify against a real diff. Since local mode can't
      // meaningfully distinguish "no PR because nothing was implemented" from
      // "no PR because this deployment mode doesn't track one", the check is left
      // to the inspector's own judgment here, same as an empty-but-existing diff.
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
      } else if (stages.kind === "editor" && !hasDeliveredChanges && !hasLocalGitChanges(meta.cwd)) {
        // Local-mode commit gate (task #598): an editor-kind agent that ends its
        // turn with no verdict AND no observable git change (working tree diff,
        // commits ahead of the base branch, OR a successful git-delivery MCP
        // commit/push this turn) produced no detectable outcome at all. This is
        // the local equivalent of the hasChanges/committed cross-check
        // runLoopModeAca() gets from the ACA worker — without it, a turn that
        // silently did nothing was unconditionally marked resolved. Inspector-kind
        // agents are exempt: they never produce file changes by design, so this
        // check only applies to editors.
        await resetTask(task.id, stages.claimState);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `✖ Task ${task.id} reset to "${stages.claimState}" — no git changes detected and no verdict reported (turn produced no observable outcome).`,
        });
        recordSessionError({
          sessionId: meta.id,
          sessionName: meta.name,
          agent: meta.agent,
          message: `Editor-kind agent completed the turn with no verdict and no local git changes — nothing was actually implemented`,
          context: `Task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority}) produced no observable outcome in local mode.`,
          taskId: task.id,
          taskTitle: task.title,
          userId: meta.userId,
          managed,
        });
      } else if (stages.kind === "editor" && (deliveredBranchName || deliveredPrUrl)) {
        // Editor-kind task with new git-delivery facts this turn — persist
        // the branch name / PR URL alongside the resolve so the next stage
        // (reviewer/QA) and any future rework pass on this task know where
        // to look. Undefined fields are omitted (tri-state semantics —
        // see resolveTask's own doc comment), so a value this turn didn't
        // produce (e.g. no PR yet because push failed) doesn't overwrite an
        // existing one from a prior turn.
        await resolveTask(task.id, stages.resolveState, deliveredBranchName, deliveredPrUrl);
        appendOutput(managed, {
          timestamp: now(),
          stream: "system",
          text: `Task ${task.id} marked as "${stages.resolveState}" ✓` +
            (deliveredPrUrl ? ` — PR: ${deliveredPrUrl}` : deliveredBranchName ? ` — branch: ${deliveredBranchName}` : ""),
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
    meta.currentTaskTitle = undefined;
    broadcastToUser(meta.userId, { type: "session-updated", session: meta });
    persistSession(meta.id);
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
      recordSessionError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: msg,
        context: `Error in standalone loop iteration ${iteration}`,
        userId: meta.userId,
        err,
        managed,
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

async function streamPrompt(managed: ManagedSession, text: string, images?: { data: string; mimeType: string }[], taskMeta?: { id: number; title: string }): Promise<void> {
  if (!managed.runner) return;

  // ─── Turn start ───
  managed.turnNumber++;
  managed.turnCountThisRun++;
  managed.turnStartedAt = now();
  managed.turnToolCallCount = 0;
  managed.turnActiveToolCalls.clear();
  managed.turnVerdict = null;
  managed.verdictToolCallId = null;

  const turnNumber = managed.turnNumber;
  const taskId = taskMeta?.id ?? managed.meta.currentTaskId;
  const taskTitle = taskMeta?.title;

  broadcastToUser(managed.meta.userId, {
    type: "session-turn-start",
    sessionId: managed.meta.id,
    turnNumber,
    taskId,
    taskTitle,
    startedAt: managed.turnStartedAt,
  });

  // Persist turn-start to DB (fire-and-forget — don't block the prompt)
  if (isDbAvailable()) {
    createTurn({
      sessionId: managed.meta.id,
      number: turnNumber,
      startedAt: managed.turnStartedAt,
      taskId: taskId ?? null,
      taskTitle: taskTitle ?? null,
    }).catch(() => { /* best effort — non-fatal */ });
  }

  try {
    for await (const update of managed.runner.prompt(text, images)) {
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

    // ─── Turn end ───
    const endedAt = now();
    const durationMs = managed.turnStartedAt
      ? new Date(endedAt).getTime() - new Date(managed.turnStartedAt).getTime()
      : 0;
    const costEur = turnCredits * 0.04;

    const summary: TurnEndSummary = {
      credits: turnCredits,
      costEur,
      durationMs,
      toolCallCount: managed.turnToolCallCount,
      hasChanges: false, // Local mode doesn't track git changes
      verdict: managed.turnVerdict ?? undefined,
    };

    broadcastToUser(managed.meta.userId, {
      type: "session-turn-end",
      sessionId: managed.meta.id,
      turnNumber,
      summary,
    });

    // Persist turn-end to DB
    if (isDbAvailable()) {
      completeTurn({
        sessionId: managed.meta.id,
        number: turnNumber,
        endedAt,
        credits: turnCredits,
        costEur,
        verdict: managed.turnVerdict ?? null,
        durationMs,
        toolCallCount: managed.turnToolCallCount,
        hasChanges: false,
      }).catch(() => { /* best effort — non-fatal */ });
    }

    setActivity(managed, { type: "idle", detail: "Ready for next prompt" });
  } catch (err) {
    // Flush buffer even on error so partial text isn't lost
    flushMessageBuffer(managed);

    // ─── Turn end (on error) ───
    const endedAt = now();
    const durationMs = managed.turnStartedAt
      ? new Date(endedAt).getTime() - new Date(managed.turnStartedAt).getTime()
      : 0;

    const summary: TurnEndSummary = {
      credits: 0,
      costEur: 0,
      durationMs,
      toolCallCount: managed.turnToolCallCount,
      hasChanges: false,
    };

    broadcastToUser(managed.meta.userId, {
      type: "session-turn-end",
      sessionId: managed.meta.id,
      turnNumber,
      summary,
    });

    if (isDbAvailable()) {
      completeTurn({
        sessionId: managed.meta.id,
        number: turnNumber,
        endedAt,
        credits: 0,
        costEur: 0,
        durationMs,
        toolCallCount: managed.turnToolCallCount,
        hasChanges: false,
      }).catch(() => { /* best effort */ });
    }

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

/**
 * Try to extract a `{ verdict, reason }` payload from a tool call's content
 * blocks and, if found, record it onto `managed.turnVerdict`.
 *
 * This is the sole source of truth for verdict capture — deliberately NOT
 * gated on toolCallId correlation with a prior `tool_call` announcement (see
 * the removed `verdictToolCallId`/name-matching approach this replaced).
 * kiro-cli does not reliably emit MCP tool-call announcements as a
 * `sessionUpdate: "tool_call"` update before their completion; sometimes the
 * announcement instead falls into the catch-all `default:` case below (no
 * `toolCallId`, no `title` matching "report_verdict"), which meant the old
 * approach's `managed.verdictToolCallId` was never set, so a matching
 * `tool_call_update` never captured the verdict even though the tool call
 * genuinely completed successfully with a valid verdict payload (see task
 * about task #597 resetting to "todo" with "no verdict reported" despite
 * report_verdict having actually run and returned no_action_needed).
 *
 * Matching on content shape instead of on ID/name correlation is robust to
 * that — any completed tool call whose output happens to contain valid JSON
 * `{"verdict": "resolved" | "no_action_needed" | "changes_requested", ...}`
 * is accepted, regardless of which update type announced it or whether a
 * toolCallId was ever available to correlate against.
 */
const VALID_TURN_VERDICTS = new Set(["resolved", "no_action_needed", "changes_requested"]);

export function tryCaptureVerdictFromContent(
  managed: ManagedSession,
  content: unknown,
): void {
  if (!Array.isArray(content)) return;
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === "text" && block.text) {
      try {
        const parsed = JSON.parse(block.text);
        if (parsed && typeof parsed.verdict === "string" && VALID_TURN_VERDICTS.has(parsed.verdict)) {
          managed.turnVerdict = parsed.verdict;
        }
      } catch {
        /* not JSON — ignore */
      }
    }
  }
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

        // Track tool call count for the turn summary
        managed.turnToolCallCount++;

        // Generate a toolCallId if one isn't provided
        const acpToolCallId = (update as { toolCallId?: string }).toolCallId;
        const toolCallId = acpToolCallId || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Track the last generated fallback ID so tool_call_update (which also
        // won't have a toolCallId) can be correlated with this tool_call.
        managed.lastGeneratedToolCallId = acpToolCallId ? null : toolCallId;

        // Track the tool call start time for durationMs calculation
        managed.turnActiveToolCalls.set(toolCallId, Date.now());

        // Emit structured session-tool-call event
        broadcastToUser(managed.meta.userId, {
          type: "session-tool-call",
          sessionId: managed.meta.id,
          turnNumber: managed.turnNumber,
          toolCallId,
          label,
          icon,
          status: "running",
        });
        break;
      }

      case "tool_call_update": {
        // Use ACP-provided toolCallId, or fall back to the last generated one
        // (from a tool_call that also lacked a toolCallId — they arrive sequentially).
        const tcUpdateId = (update as { toolCallId?: string }).toolCallId || managed.lastGeneratedToolCallId;
        // Clear the fallback after use — it's a one-shot correlation.
        if (!((update as { toolCallId?: string }).toolCallId) && managed.lastGeneratedToolCallId) {
          managed.lastGeneratedToolCallId = null;
        }

        if (update.status === "completed") {
          // Capture a verdict from this update's content, regardless of
          // whether a prior "tool_call" announcement was seen for it — see
          // tryCaptureVerdictFromContent's doc comment for why toolCallId
          // correlation alone is not reliable enough to gate this on.
          const completedContent = (update as { content?: unknown }).content;
          tryCaptureVerdictFromContent(managed, completedContent);

          // Emit structured session-tool-call-update event
          if (tcUpdateId) {
            const startTime = managed.turnActiveToolCalls.get(tcUpdateId);
            const durationMs = startTime ? Date.now() - startTime : undefined;
            managed.turnActiveToolCalls.delete(tcUpdateId);

            // Extract output text from content blocks
            const content = (update as { content?: Array<{ type?: string; text?: string }> }).content;
            let output: string | undefined;
            if (Array.isArray(content)) {
              const texts = content
                .filter((b) => b?.type === "text" && b.text)
                .map((b) => b.text!);
              if (texts.length > 0) {
                // Truncate to first 2000 chars to keep WS messages reasonable
                const joined = texts.join("\n");
                output = joined.length > 2000 ? joined.slice(0, 2000) + "…" : joined;
              }
            }

            broadcastToUser(managed.meta.userId, {
              type: "session-tool-call-update",
              sessionId: managed.meta.id,
              turnNumber: managed.turnNumber,
              toolCallId: tcUpdateId,
              status: "completed",
              output,
              durationMs,
            });
          }

          setActivity(managed, { type: "working", detail: "Processing..." });
        } else if (update.status === "failed") {
          // Emit structured session-tool-call-update event for failure
          if (tcUpdateId) {
            const startTime = managed.turnActiveToolCalls.get(tcUpdateId);
            const durationMs = startTime ? Date.now() - startTime : undefined;
            managed.turnActiveToolCalls.delete(tcUpdateId);

            // Extract output text from content blocks (same as completed path)
            const content = (update as { content?: Array<{ type?: string; text?: string }> }).content;
            let output: string | undefined;
            if (Array.isArray(content)) {
              const texts = content
                .filter((b) => b?.type === "text" && b.text)
                .map((b) => b.text!);
              if (texts.length > 0) {
                const joined = texts.join("\n");
                output = joined.length > 2000 ? joined.slice(0, 2000) + "…" : joined;
              }
            }

            broadcastToUser(managed.meta.userId, {
              type: "session-tool-call-update",
              sessionId: managed.meta.id,
              turnNumber: managed.turnNumber,
              toolCallId: tcUpdateId,
              status: "failed",
              output,
              durationMs,
            });
          }

          // Tool failures are the most common reason an agent produces no
          // changes — always surface them.
          appendOutput(managed, {
            timestamp: now(),
            stream: "stderr",
            text: `⚠️ Tool call failed: ${update.title || tcUpdateId || "unknown tool"}`,
          });
        }
        break;
      }

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
        // Other update types — capture a verdict from content here too, in
        // case kiro-cli never emits a recognized "tool_call"/"tool_call_update"
        // pair for this MCP call (observed in practice — see
        // tryCaptureVerdictFromContent's doc comment).
        tryCaptureVerdictFromContent(managed, (update as { content?: unknown }).content);

        // Show only if meaningful, with a clean format
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

  const spawner = resolveContainerSpawner();
  managed.containerSpawner = spawner;

  try {
    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: spawner.kind === "aca"
        ? "Requesting ACA Job execution..."
        : "Starting local worker container (kirofactory-docker WSL distro)...",
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

    if (spawner.hasProxyImage()) {
      try {
        // 1. Decrypt user credentials (only held in memory during config build)
        const rawCreds = await getAllDecryptedCredentials(meta.userId);
        const credentials: SessionCredentials = {
          azureDevOpsPat: rawCreds.azureDevOpsPat,
          atlassianApiToken: rawCreds.atlassianApiToken,
          atlassianUsername: rawCreds.atlassianUsername,
          awsAccessKeyId: rawCreds.awsAccessKeyId,
          awsSecretAccessKey: rawCreds.awsSecretAccessKey,
        };

        // 2. Resolve agent-owned MCP servers (minus per-session exclusions)
        let acaAgentMcpServers: McpServerConfig[] = [];
        if (meta.agent) {
          try {
            const agentRecord = await getAgentByName(meta.agent);
            if (agentRecord?.mcpServers?.length) {
              acaAgentMcpServers = resolveAgentMcpServers(agentRecord.mcpServers, meta.excludedMcpServerNames);
            }
          } catch {
            // Non-fatal — continue without agent MCP servers
          }
        }

        // 3. Generate servers.json config for the proxy sidecar
        const serversConfig = buildProxyServersConfig({
          sessionMcpServers: [
            ...acaAgentMcpServers,
            ...(meta.mcpServers ?? []),
          ],
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

    const execution = await spawner.start(
      meta.id,
      meta.agent,
      meta.userId,
      meta.timeoutSeconds,
      mcpSidecar,
      gitOptions,
      agentKind,
      agentConfigBase64,
      meta.model
    );

    managed.acaExecutionName = execution.executionName;

    logWorkerEvent("worker-spawned", meta.id, {
      agent: meta.agent,
      executionName: execution.executionName,
      status: execution.status,
      msg: `${spawner.kind === "aca" ? "ACA worker job" : "Local worker container"} started: ${execution.executionName}`,
    });

    appendOutput(managed, {
      timestamp: now(),
      stream: "system",
      text: `${spawner.kind === "aca" ? "ACA Job" : "Local container"} started: ${execution.executionName} (status: ${execution.status})`,
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
      let oneShotPromptResult: WorkerPromptResult | undefined;
      if (meta.prompt.trim()) {
        oneShotPromptResult = await streamPromptAca(managed, meta.prompt);
      }

      // One-shot (scheduled) run: the prompt has completed exactly once —
      // signal success/failure and return so runOneShotTurn() can stop the
      // session. Unlike the local streamPrompt path (which throws on failure
      // and so reaches startSession's reject path directly), streamPromptAca
      // returns a WorkerPromptResult instead of throwing, so we must inspect
      // the same failure signals runLoopModeAca checks and reject explicitly.
      // Otherwise a failed scheduled turn in ACA/remote mode (the production
      // deployment mode) would resolve as success — the scheduler would never
      // retry and never record a per-attempt AgentError.
      if (managed.oneShot) {
        const classified = classifyOneShotAcaResult(oneShotPromptResult);
        if (classified.outcome === "reject") {
          appendOutput(managed, {
            timestamp: now(),
            stream: "stderr",
            text: `✖ ${classified.logText}`,
          });
          managed.oneShotRejecter?.(new Error(classified.reason));
        } else {
          managed.oneShotResolver?.();
        }
        return;
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
  const STATUS_POLL_INTERVAL_MS = 10_000; // Check worker job/container status every 10s
  const startTime = Date.now();
  let lastStatusCheck = 0;
  let lastLoggedStatus = "";
  const spawner = managed.containerSpawner;

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
      if (spawner && managed.acaExecutionName) {
        try {
          const jobStatus = await spawner.status(managed.acaExecutionName);
          finalStatus = jobStatus.status;
        } catch { /* best effort */ }
      }

      const errorMsg =
        `Worker did not connect within ${WORKER_CONNECT_TIMEOUT_MS / 1000}s. ` +
        `${spawner?.kind === "wsl" ? "Local container" : "ACA job"} status at timeout: "${finalStatus}". ` +
        `The container may have failed to start, crashed during init, or cannot reach the orchestrator URL. ` +
        `Check the worker container logs${spawner?.kind === "wsl" ? " (docker logs " + managed.acaExecutionName + " inside the kirofactory-docker WSL distro)" : " in Azure Portal"} for more details.`;

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

    // Periodically poll worker job/container status to detect early failures
    if (spawner && managed.acaExecutionName && elapsed - lastStatusCheck >= STATUS_POLL_INTERVAL_MS) {
      lastStatusCheck = elapsed;
      try {
        const jobStatus = await spawner.status(managed.acaExecutionName);
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
        const failedStates = ["failed", "terminated", "degraded", "unknown", "exited"];
        if (failedStates.includes(statusStr.toLowerCase())) {
          const errorMsg = spawner.kind === "wsl"
            ? `Local worker container entered terminal state "${statusStr}" before connecting. ` +
              `Container: ${managed.acaExecutionName}. The container likely crashed during startup. ` +
              `Check its logs: wsl -d kirofactory-docker -- docker logs ${managed.acaExecutionName}`
            : `ACA worker job entered terminal state "${statusStr}" before connecting. ` +
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
  /** Whether the agent's changes were actually committed (via MCP tools or worker). */
  committed?: boolean;
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

  // ─── Turn start ───
  managed.turnNumber++;
  managed.turnCountThisRun++;
  managed.turnStartedAt = now();
  managed.turnToolCallCount = 0;
  managed.turnActiveToolCalls.clear();

  const turnNumber = managed.turnNumber;
  const taskId = taskMeta?.id ?? managed.meta.currentTaskId;
  const taskTitle = taskMeta?.title;

  broadcastToUser(managed.meta.userId, {
    type: "session-turn-start",
    sessionId: managed.meta.id,
    turnNumber,
    taskId,
    taskTitle,
    startedAt: managed.turnStartedAt,
  });

  // Persist turn-start to DB (fire-and-forget)
  if (isDbAvailable()) {
    createTurn({
      sessionId: managed.meta.id,
      number: turnNumber,
      startedAt: managed.turnStartedAt,
      taskId: taskId ?? null,
      taskTitle: taskTitle ?? null,
    }).catch(() => { /* best effort */ });
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

  const promptResult = (result && typeof result === "object") ? result as WorkerPromptResult : {};

  // ─── Turn end ───
  const endedAt = now();
  const durationMs = managed.turnStartedAt
    ? new Date(endedAt).getTime() - new Date(managed.turnStartedAt).getTime()
    : 0;
  const turnCredits = promptResult.credits ?? 0;
  const costEur = turnCredits * 0.04;

  const summary: TurnEndSummary = {
    credits: turnCredits,
    costEur,
    durationMs: promptResult.durationMs ?? durationMs,
    toolCallCount: promptResult.toolCalls ?? managed.turnToolCallCount,
    hasChanges: promptResult.hasChanges ?? false,
    verdict: promptResult.verdict ?? undefined,
    prUrl: promptResult.prUrl ?? undefined,
    branchName: promptResult.branchName ?? undefined,
  };

  broadcastToUser(managed.meta.userId, {
    type: "session-turn-end",
    sessionId: managed.meta.id,
    turnNumber,
    summary,
  });

  // Persist turn-end to DB
  if (isDbAvailable()) {
    completeTurn({
      sessionId: managed.meta.id,
      number: turnNumber,
      endedAt,
      credits: turnCredits,
      costEur,
      verdict: promptResult.verdict ?? null,
      durationMs: promptResult.durationMs ?? durationMs,
      toolCallCount: promptResult.toolCalls ?? managed.turnToolCallCount,
      hasChanges: promptResult.hasChanges ?? false,
      prUrl: promptResult.prUrl ?? null,
      branchName: promptResult.branchName ?? null,
    }).catch(() => { /* best effort */ });
  }

  return promptResult;
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
        recordSessionError({
          sessionId: meta.id,
          sessionName: meta.name,
          agent: meta.agent,
          message: promptResult.error,
          context: `Standalone loop iteration ${iteration} reported error. stopReason: ${promptResult.stopReason ?? "none"}, tool calls: ${promptResult.toolCalls ?? 0}, duration: ${Math.round((promptResult.durationMs ?? 0) / 1000)}s.`,
          userId: meta.userId,
          managed,
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
      recordSessionError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: msg,
        context: `Error in standalone loop iteration ${iteration}`,
        userId: meta.userId,
        err,
        managed,
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

    const todoCount = await getAvailableTaskCount(effectiveTabIds, stages.claimState, stages.workingState);

    if (todoCount === 0) {
      setActivity(managed, {
        type: "idle",
        detail: "No tasks available. Waiting for new tasks...",
      });

      // Park here until a task is created/reset or the session is stopped.
      // waitForTaskAvailable does a single DB check, then suspends on an
      // in-process event — zero DB queries during the wait.
      await waitForTaskAvailable(effectiveTabIds, stages.claimState, signal, stages.workingState);
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
      const diagnosis = await describeClaimFailure(effectiveTabIds, stages.claimState, stages.workingState);
      appendOutput(managed, {
        timestamp: now(),
        stream: "system",
        text: describeClaimFailureMessage(diagnosis),
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
    meta.currentTaskTitle = task.title;
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
    //
    // Sanitize task.branch as soon as it's read here, before any sibling
    // lookup or use. This is the single point both the AC1 (task.branch set)
    // and AC2 (inherited from a sibling below) paths flow through, so it also
    // guards any row already persisted with a malformed value before the
    // write-side fix in resolveTask/resetTask/setTaskBranchAndPr.
    task.branch = sanitizeBranchName(task.branch);
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
            // Inherit the branch (and PR URL) from the sibling. Sanitized
            // defensively even though the write side (resolveTask/resetTask/
            // setTaskBranchAndPr) now sanitizes too — this guards any row
            // already persisted with a malformed value before that fix, so
            // an old poisoned branch doesn't keep failing sync_task_branch
            // for every future sibling that inherits it.
            task.branch = sanitizeBranchName(siblingWithBranch.branch);
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
      recordSessionError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: msg,
        context: `Error while executing task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority})`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
        err,
        managed,
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
      recordSessionError({
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
        managed,
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
      recordSessionError({
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
        managed,
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
      recordSessionError({
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
        managed,
      });
    }

    // Changes were made but never successfully committed via the git-delivery
    // MCP tools. The agent edited files but never called submit_task_changes
    // (or it failed). Treat this the same as a cancelled turn — the work is
    // incomplete/undelivered.
    if (success && promptResult.hasChanges && promptResult.committed === false) {
      success = false;
      failureReason = `Agent made file changes but never successfully committed them (submit_task_changes was not called or failed) — work is undelivered`;
      appendOutput(managed, {
        timestamp: now(),
        stream: "stderr",
        text: `✖ Agent produced file changes but they were never committed via submit_task_changes — task reset to "${stages.claimState}".`,
      });
      recordSessionError({
        sessionId: meta.id,
        sessionName: meta.name,
        agent: meta.agent,
        message: failureReason,
        context:
          `Task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority}) had uncommitted ` +
          `changes at end of turn. The agent may have forgotten to call submit_task_changes or it failed.`,
        taskId: task.id,
        taskTitle: task.title,
        userId: meta.userId,
        managed,
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
      //
      // Safety net: an inspector-kind agent reporting "no_action_needed" with NO
      // PR URL recorded anywhere (neither this turn's promptResult.prUrl nor the
      // task's own pullRequestUrl from a prior stage) means nothing was ever
      // delivered to review — there is no implementation to have passed. This
      // guards against an inspector rubber-stamping a task the developer forgot
      // to implement (or forgot to open a PR for) — see task #1554. Scoped
      // strictly to "no PR at all"; a PR that exists but has an empty/insufficient
      // diff is left to the inspector's own judgment (see buildReviewPrompt()).
      if (
        stages.kind === "inspector" &&
        promptResult.verdict === "no_action_needed" &&
        !promptResult.prUrl &&
        !task.pullRequestUrl
      ) {
        await resetTask(task.id, "todo", promptResult.branchName || undefined, promptResult.prUrl || undefined);
        appendOutput(managed, {
          timestamp: now(),
          stream: "stderr",
          text: `✖ Inspector reported "no_action_needed" but task ${task.id} has no pull request recorded — nothing was delivered to review. Task sent back to "todo".`,
        });
        recordSessionError({
          sessionId: meta.id,
          sessionName: meta.name,
          agent: meta.agent,
          message: `Inspector agent (${meta.agent}) passed task with "no_action_needed" but no PR URL was recorded — nothing was actually implemented/delivered`,
          context: `Task "${task.title}" (ID: ${task.id}, type: ${task.type}, priority: P${task.priority}) has no pullRequestUrl on the task and none reported this turn. The developer likely forgot to implement the change or forgot to open a PR.`,
          taskId: task.id,
          taskTitle: task.title,
          userId: meta.userId,
          managed,
        });
      } else if (promptResult.verdict === "no_action_needed" && !promptResult.hasChanges) {
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
        meta.currentTaskTitle = undefined;
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
        recordSessionError({
          sessionId: meta.id,
          sessionName: meta.name,
          agent: meta.agent,
          message: `Task "${task.title}" failed ${failures} consecutive times — blocked for this session`,
          context: `Task ID: ${task.id}, type: ${task.type}, priority: P${task.priority}. Last failure: ${failureReason || "unknown"}. Manual investigation is required.`,
          taskId: task.id,
          taskTitle: task.title,
          userId: meta.userId,
          managed,
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
    meta.currentTaskTitle = undefined;
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

/** Cap on how much of each container's captured logs gets appended to the session's own output. */
const CAPTURED_CONTAINER_LOG_CHAR_LIMIT = 4000;

/**
 * Best-effort `docker logs` capture for a session's worker container and MCP proxy sidecar,
 * fired on unexpected exits (crashes, or a clean exit before any turn completed — see the two
 * call sites in initWorkerEventHandler below).
 *
 * Local WSL/Docker mode only: both containers run with `--rm`, self-deleting on exit, so their
 * logs are gone within roughly a second of the disconnect being detected unless fetched
 * immediately (see wsl-worker-spawner.ts's captureContainerLogs() doc comment for the exact
 * timing). ACA mode is not covered here — ACA job execution logs are retained by Azure and
 * queryable after the fact through Log Analytics, so there's no equivalent loss-of-evidence
 * problem to race against there.
 *
 * Never throws and never blocks the caller — this is fire-and-forget diagnostic capture, not
 * part of the session lifecycle itself.
 */
function captureContainerLogsOnFailure(session: ManagedSession, sessionId: number): void {
  if (session.containerSpawner?.kind !== "wsl" || !wslConfig) return;

  captureWslContainerLogs(wslConfig, sessionId)
    .then((results) => {
      for (const { containerName, logs, error } of results) {
        if (logs === null) {
          logWorkerEvent("worker-container-logs-unavailable", sessionId, { containerName, error });
          continue;
        }
        const truncated = logs.length > CAPTURED_CONTAINER_LOG_CHAR_LIMIT;
        const snippet = truncated ? logs.slice(-CAPTURED_CONTAINER_LOG_CHAR_LIMIT) : logs;
        logWorkerEvent("worker-container-logs-captured", sessionId, {
          containerName,
          fullLength: logs.length,
          truncated,
        });
        appendOutput(session, {
          timestamp: now(),
          stream: "system",
          text:
            `── Captured container logs: ${containerName}${truncated ? ` (last ${CAPTURED_CONTAINER_LOG_CHAR_LIMIT} chars)` : ""} ──\n` +
            snippet,
        });
      }
    })
    .catch((err) => {
      // captureWslContainerLogs() itself is documented to never reject, but guard anyway —
      // this must never throw into the caller's event-handling path.
      logWorkerEvent("worker-container-logs-capture-failed", sessionId, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

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

    onWorkerAgentError(sessionId: number, message: string, context: string) {
      handleWorkerAgentError(sessionId, message, context);
    },

    onWorkerTaskCreate(sessionId: number, spec) {
      void handleWorkerTaskCreate(sessionId, spec);
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

      // Best-effort container-level log capture for unexpected exits — see
      // captureContainerLogsOnFailure()'s doc comment for why this races
      // container --rm removal and must fire as early as possible.
      if (crashed) {
        captureContainerLogsOnFailure(session, sessionId);
      }

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

      // exitCode 0 with zero completed turns AND containerSpawner still set is the
      // "died mid-handshake, exited cleanly" pattern: kiro-cli or the container
      // died on its own before completing any work. This must be distinguished
      // from a legitimate exit-0 zero-turn shutdown — an intentional user/backend
      // stop (stopSession()) already sends "stop" to the worker and synchronously
      // nulls containerSpawner/acaExecutionName in the same tick, before this
      // async callback can ever run, so containerSpawner still being non-null here
      // means the worker exited on its own, not because it was told to.
      const suspiciousEarlyExit =
        exitCode === 0 && session.turnCountThisRun === 0 && session.containerSpawner !== null;
      const isFailure = exitCode !== 0 || suspiciousEarlyExit;

      logWorkerEvent(isFailure ? "worker-crashed" : "worker-exited", sessionId, {
        agent: session.meta.agent,
        exitCode,
        suspiciousEarlyExit,
        msg: `Worker shutdown (exit code: ${exitCode})`,
      });
      appendOutput(session, {
        timestamp: now(),
        stream: "system",
        text: suspiciousEarlyExit
          ? `Worker shutdown (exit code: ${exitCode}) — exited before completing any task turn; treating as a failure.`
          : `Worker shutdown (exit code: ${exitCode})`,
      });

      // exitCode 0 with zero completed turns is the "died mid-handshake, exited
      // cleanly" pattern (see worker-container-mid-handshake-exit.md) that
      // otherwise looks identical to a normal completed session — capture logs
      // for it too, not just nonzero exits.
      if (exitCode !== 0 || session.turnCountThisRun === 0) {
        captureContainerLogsOnFailure(session, sessionId);
      }

      if (!isFailure) {
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

// Initialize the worker event handler immediately (runs at module load time).
// Always initialized — both ACA and local WSL/Docker workers connect back
// over the same internal WebSocket, so this is needed in both modes, not
// just ACA_MODE. (forceLocal/KiroRunner sessions don't use this at all, so
// there's no meaningful "no containerized workers ever" case to skip it for.)
initWorkerEventHandler();

// ---------------------------------------------------------------------------
// Stop all running sessions for a specific user
// ---------------------------------------------------------------------------

/**
 * Stop every currently-running session belonging to the given user.
 * Used when the user switches UI view mode — all their sessions must be
 * torn down so the new mode starts from a clean slate.
 */
export async function stopAllSessionsForUser(userId: number): Promise<void> {
  const userSessions = getAllSessions(userId);
  const running = userSessions.filter((s) => s.status === "running");
  await Promise.allSettled(running.map((s) => stopSession(s.id)));
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
