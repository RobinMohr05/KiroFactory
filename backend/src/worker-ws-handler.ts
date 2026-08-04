/**
 * Worker WebSocket Handler — Accepts connections from ACA worker containers.
 *
 * Workers connect to /ws/worker and authenticate with session ID + worker secret.
 * Once authenticated, bidirectional communication is established:
 *   - Worker → Orchestrator: output, session-update, prompt-done, worker-ready, worker-exited
 *   - Orchestrator → Worker: prompt, stop
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { OutputEntry, Activity } from "./types.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORKER_SECRET = process.env.ACA_WORKER_SECRET || "";
const AUTH_TIMEOUT_MS = 10_000; // 10s to authenticate after connecting

// ---------------------------------------------------------------------------
// Types for worker messages
// ---------------------------------------------------------------------------

export interface WorkerMessage {
  action: string;
  sessionId: number;
  [key: string]: unknown;
}

export interface WorkerOutputMessage extends WorkerMessage {
  action: "output";
  entry: OutputEntry;
}

export interface WorkerSessionUpdateMessage extends WorkerMessage {
  action: "session-update";
  update: unknown;
}

export interface WorkerReadyMessage extends WorkerMessage {
  action: "worker-ready";
  acpSessionId: string;
}

export interface WorkerPromptDoneMessage extends WorkerMessage {
  action: "prompt-done";
  result: {
    stopReason?: string | null;
    error?: string | null;
    deliveryFailed?: boolean;
    toolCalls?: number;
    durationMs?: number;
    hasChanges?: boolean;
    prUrl?: string | null;
    /** Kiro credits consumed this turn (from _kiro.dev/metadata meteringUsage). */
    credits?: number;
    /** Agent-reported verdict via the report_verdict MCP tool. Cross-checked against git diff. */
    verdict?: "resolved" | "no_action_needed";
  };
}

export interface WorkerExitedMessage extends WorkerMessage {
  action: "worker-exited";
  exitCode: number | null;
  signal: string | null;
}

export interface WorkerShutdownMessage extends WorkerMessage {
  action: "worker-shutdown";
  exitCode: number;
}

// Callback type for handling worker events in session-manager
export interface WorkerEventHandler {
  onWorkerReady: (sessionId: number, acpSessionId: string) => void;
  onWorkerOutput: (sessionId: number, entry: OutputEntry) => void;
  onWorkerSessionUpdate: (sessionId: number, update: unknown) => void;
  onWorkerPromptDone: (sessionId: number, result: unknown) => void;
  onWorkerExited: (sessionId: number, exitCode: number | null, signal: string | null) => void;
  onWorkerShutdown: (sessionId: number, exitCode: number) => void;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Map of sessionId → authenticated worker WebSocket */
const workerConnections = new Map<number, WebSocket>();

let eventHandler: WorkerEventHandler | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the event handler that session-manager uses to receive worker events.
 */
export function setWorkerEventHandler(handler: WorkerEventHandler): void {
  eventHandler = handler;
}

/**
 * Set up the worker WebSocket server for the "/internal/worker" path.
 *
 * Uses `noServer: true`; the HTTP `upgrade` event is routed to this server by a
 * single handler in index.ts. See the note in websocket-handler.ts for why
 * attaching multiple `WebSocketServer` instances to one HTTP server via the
 * `{ server, path }` option does not work (the first-registered server destroys
 * upgrade requests for the others).
 */
export function setupWorkerWebSocket(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    let authenticated = false;
    let sessionId: number | null = null;

    // Auth timeout — close if not authenticated within 10s
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        log.warn("worker-auth-timeout", {
          component: "worker-ws",
          timeoutMs: AUTH_TIMEOUT_MS,
          msg: "Worker did not authenticate within the timeout window; closing connection",
        });
        ws.close(4001, "Authentication timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg: WorkerMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // Ignore malformed messages
      }

      // First message must be auth
      if (!authenticated) {
        if (msg.action === "worker-auth") {
          const secret = (msg as { secret?: string }).secret;
          if (secret === WORKER_SECRET && msg.sessionId) {
            authenticated = true;
            sessionId = msg.sessionId;
            clearTimeout(authTimer);

            // Register this worker connection
            workerConnections.set(sessionId, ws);

            log.info("worker-authenticated", {
              component: "worker-ws",
              sessionId,
              msg: "Worker authenticated and connected",
            });
            ws.send(JSON.stringify({ action: "auth-ok" }));
          } else {
            log.warn("worker-auth-failed", {
              component: "worker-ws",
              sessionId: msg.sessionId ?? null,
              reason: !msg.sessionId ? "missing sessionId" : "invalid secret",
              msg: "Worker authentication rejected",
            });
            ws.send(JSON.stringify({ action: "auth-failed", reason: "Invalid credentials" }));
            ws.close(4003, "Authentication failed");
          }
        } else {
          log.warn("worker-auth-missing", {
            component: "worker-ws",
            action: msg.action,
            msg: "Worker sent a non-auth message before authenticating; closing connection",
          });
          ws.close(4001, "Must authenticate first");
        }
        return;
      }

      // Authenticated — route messages to event handler
      if (!sessionId || !eventHandler) return;

      switch (msg.action) {
        case "worker-ready":
          eventHandler.onWorkerReady(sessionId, (msg as WorkerReadyMessage).acpSessionId);
          break;

        case "output":
          eventHandler.onWorkerOutput(sessionId, (msg as WorkerOutputMessage).entry);
          break;

        case "session-update":
          eventHandler.onWorkerSessionUpdate(sessionId, (msg as WorkerSessionUpdateMessage).update);
          break;

        case "prompt-done":
          eventHandler.onWorkerPromptDone(sessionId, (msg as WorkerPromptDoneMessage).result);
          break;

        case "worker-exited":
          eventHandler.onWorkerExited(
            sessionId,
            (msg as WorkerExitedMessage).exitCode,
            (msg as WorkerExitedMessage).signal
          );
          break;

        case "worker-shutdown":
          eventHandler.onWorkerShutdown(sessionId, (msg as WorkerShutdownMessage).exitCode);
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (sessionId) {
        workerConnections.delete(sessionId);
        // Notify handler that worker disconnected (treat as exited)
        if (authenticated && eventHandler) {
          log.info("worker-disconnected", {
            component: "worker-ws",
            sessionId,
            msg: "Worker socket closed",
          });
          eventHandler.onWorkerExited(sessionId, null, "disconnected");
        }
      }
    });

    ws.on("error", (err) => {
      clearTimeout(authTimer);
      log.warn("worker-ws-error", {
        component: "worker-ws",
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (sessionId) {
        workerConnections.delete(sessionId);
      }
    });
  });

  return wss;
}

/** Task metadata sent alongside a prompt so the worker can construct commit messages and PRs. */
export interface WorkerTaskMeta {
  id: number;
  title: string;
  type?: string;
  description: string;
  files: string[];
}

/**
 * Send a prompt command to a connected worker.
 * Optionally includes task metadata for git commit/PR operations.
 */
export function sendWorkerPrompt(sessionId: number, text: string, taskMeta?: WorkerTaskMeta): boolean {
  const ws = workerConnections.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  const msg: Record<string, unknown> = { action: "prompt", text };
  if (taskMeta) {
    msg.taskMeta = taskMeta;
  }
  ws.send(JSON.stringify(msg));
  return true;
}

/**
 * Send a stop command to a connected worker.
 */
export function sendWorkerStop(sessionId: number): boolean {
  const ws = workerConnections.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  ws.send(JSON.stringify({ action: "stop" }));
  return true;
}

/**
 * Check if a worker is connected for a given session.
 */
export function isWorkerConnected(sessionId: number): boolean {
  const ws = workerConnections.get(sessionId);
  return ws !== undefined && ws.readyState === WebSocket.OPEN;
}

/**
 * Close all worker connections (for graceful shutdown).
 */
export function closeAllWorkerConnections(): void {
  for (const [, ws] of workerConnections) {
    ws.close(1000, "Server shutting down");
  }
  workerConnections.clear();
}
