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
import { loadSessions, saveSessions } from "./session-store.js";
import { recordError } from "./error-store.js";
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
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Persist all session metadata to disk.
 * Called after every state mutation so sessions survive server restarts.
 */
function persistSessions(): void {
  const allMeta = Array.from(sessions.values()).map((s) => s.meta);
  saveSessions(allMeta);
}

/**
 * Initialize sessions from disk on server startup.
 * Sessions that were "running" before the restart are automatically re-started.
 * This handles the case where `tsx watch` restarts the server mid-agent-execution.
 */
export function initSessions(): void {
  const persisted = loadSessions();
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
    console.log(`[session-manager] Restored ${persisted.length} session(s) from disk.`);
  }

  // Auto-restart sessions that were running before the server restarted.
  // Use a short delay to allow the rest of the server to finish initializing.
  if (toRestart.length > 0) {
    console.log(`[session-manager] Auto-restarting ${toRestart.length} session(s) that were active before restart...`);
    setTimeout(async () => {
      // Reset any orphaned in-progress tasks (their kiro-cli process is dead)
      try {
        const { resetOrphanedTasks } = await import("./agent/task-claimer.js");
        const resetCount = await resetOrphanedTasks();
        if (resetCount > 0) {
          console.log(`[session-manager] Reset ${resetCount} orphaned in-progress task(s) back to "todo".`);
        }
      } catch (err) {
        console.warn("[session-manager] Could not reset orphaned tasks:", err);
      }

      for (const id of toRestart) {
        startSession(id).catch((err) => {
          console.error(`[session-manager] Failed to auto-restart session ${id}:`, err);
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
      boardIds: input.boardIds,
      createdAt: now(),
      output: [],
    },
    runner: null,
    abortController: null,
    messageBuffer: "",
    messageFlushTimer: null,
  };

  sessions.set(id, session);
  broadcast({ type: "session-created", session: session.meta });
  persistSessions();
  return session.meta;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)?.meta;
}

export function getAllSessions(): Session[] {
  return Array.from(sessions.values()).map((s) => ({
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

  appendOutput(session, {
    timestamp: now(),
    stream: "system",
    text: `Starting agent "${session.meta.agent}" in ${session.meta.cwd}...`,
  });

  // Spawn async — don't block the caller
  runSession(session).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    appendOutput(session, { timestamp: now(), stream: "stderr", text: `Fatal: ${msg}` });
    setStatus(session, "error");
    setActivity(session, { type: "idle" });

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

  // Close runner
  if (session.runner) {
    try {
      await session.runner.close();
    } catch {
      /* best effort */
    }
    session.runner = null;
  }

  appendOutput(session, { timestamp: now(), stream: "system", text: "Session stopped by user." });
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
    // Create the KiroRunner
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
    });

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

    // Check for available tasks (filtered by session's board assignments)
    const todoCount = await getAvailableTaskCount(meta.boardIds);

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

    const task = await claimTask();
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
          const detail = `${update.title}${update.status ? ` (${update.status})` : ""}`;
          setActivity(managed, { type: "tool-call", detail });
          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: `🔧 Tool: ${detail}`,
          });
        }
        break;

      case "tool_call_update":
        if (update.status === "completed") {
          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: "   ✓ Tool completed",
          });
        }
        break;

      case "thinking":
        setActivity(managed, { type: "thinking", detail: "Thinking..." });
        break;

      default:
        // Other update types — log as system
        if (update.title || update.status) {
          appendOutput(managed, {
            timestamp: now(),
            stream: "system",
            text: `[${update.sessionUpdate}] ${update.title || update.status || ""}`,
          });
        }
        break;
    }
  }
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
