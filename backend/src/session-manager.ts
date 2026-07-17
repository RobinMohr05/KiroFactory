/**
 * Session Manager — Manages persistent ACP agent sessions.
 *
 * Each session spawns a KiroRunner that stays alive until manually stopped.
 * Output is buffered and broadcast via WebSocket to all connected clients.
 */

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { KiroRunner } from "./agent/kiro-runner.js";
import type { SessionUpdateChunk } from "./agent/kiro-runner.js";
import { broadcast } from "./websocket-handler.js";
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

function setActivity(session: ManagedSession, activity: Activity): void {
  session.meta.currentActivity = activity;
  broadcast({ type: "session-activity", sessionId: session.meta.id, activity });
}

function setStatus(session: ManagedSession, status: Session["status"]): void {
  session.meta.status = status;
  broadcast({ type: "session-updated", session: session.meta });
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
      cwd: input.cwd || DEFAULT_CWD,
      timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT,
      model: input.model,
      mcpServers: input.mcpServers,
      createdAt: now(),
      output: [],
    },
    runner: null,
    abortController: null,
  };

  sessions.set(id, session);
  broadcast({ type: "session-created", session: session.meta });
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
  });

  return true;
}

export async function stopSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.meta.status !== "running") return true;

  // Signal abort
  session.abortController?.abort();

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

async function streamPrompt(managed: ManagedSession, text: string): Promise<void> {
  if (!managed.runner) return;

  try {
    for await (const update of managed.runner.prompt(text)) {
      if (managed.abortController?.signal.aborted) break;
      processUpdate(managed, update);
    }
    setActivity(managed, { type: "idle", detail: "Ready for next prompt" });
  } catch (err) {
    if (managed.abortController?.signal.aborted) return;
    throw err;
  }
}

function processUpdate(managed: ManagedSession, update: SessionUpdateChunk): void {
  if (update.sessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content && typeof update.content.text === "string") {
          appendOutput(managed, {
            timestamp: now(),
            stream: "stdout",
            text: update.content.text,
          });
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
