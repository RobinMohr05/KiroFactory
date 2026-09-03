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

// Mirrors the spawner-side fallback in wsl-worker-spawner.ts's loadWslConfig():
// either var authenticates a worker, since ACA and WSL/Docker workers share
// this same handler and either one may be the source of truth depending on
// which mode/deployment set it.
const WORKER_SECRET = process.env.ACA_WORKER_SECRET || process.env.WSL_WORKER_SECRET || "";
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

export interface WorkerAgentErrorMessage extends WorkerMessage {
  action: "agent-error";
  message: string;
  context?: string;
}

export interface WorkerTaskCreateMessage extends WorkerMessage {
  action: "task-create";
  title: string;
  description: string;
  type: "improvement" | "bug" | "feature";
  priority: 1 | 2 | 3 | 4;
  files?: string[];
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
    /** Whether the agent's changes were actually committed (via MCP tools or worker). */
    committed?: boolean;
    prUrl?: string | null;
    branchName?: string | null;
    /** Kiro credits consumed this turn (from _kiro.dev/metadata meteringUsage). */
    credits?: number;
    /** Agent-reported verdict via the report_verdict MCP tool. Cross-checked against git diff. */
    verdict?: "resolved" | "no_action_needed" | "changes_requested";
    /** MCP servers that failed to init this turn — see WorkerPromptResult in session-manager.ts. */
    mcpServerInitFailures?: Array<{ name: string | null }>;
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
  onWorkerAgentError: (sessionId: number, message: string, context: string) => void;
  onWorkerTaskCreate: (sessionId: number, spec: { title: string; description: string; type: "improvement" | "bug" | "feature"; priority: 1 | 2 | 3 | 4; files: string[] }) => void;
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
    attachWorkerConnectionHandlers(ws);
  });

  return wss;
}

/**
 * Dial out to a worker container that is itself listening (WORKER_LISTEN_MODE,
 * see worker/worker.js and wsl-worker-spawner.ts), instead of waiting for it
 * to connect in here.
 *
 * This exists because the WSL/Docker local-worker path cannot use the normal
 * "worker dials the orchestrator" direction: the WSL2 VM's outbound
 * connections to the Windows host are blocked by Windows Firewall by default
 * (and allowing them needs admin rights we can't assume every developer
 * machine has), while the reverse direction — Windows host dialing into the
 * VM/container via a published port — works with no firewall rule needed.
 * See ARCHITECTURE.md §12 and worker/.devcontainer/README.md.
 *
 * The returned promise resolves once the worker has authenticated (mirrors
 * the ACA path's "wait for the worker to show up in workerConnections"
 * behavior in session-manager.ts's waitForWorkerOrAbort(), but pushed down
 * here since dialing is what makes the connection exist at all in this mode).
 * Rejects if the connection or the auth handshake fails.
 */
export function connectToLocalWorker(url: string, sessionId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let currentSocket: WebSocket | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { currentSocket?.terminate(); } catch { /* noop */ }
      reject(new Error(`Timed out connecting to local worker at ${url} after ${timeoutMs}ms`));
    }, timeoutMs);

    // The container's WORKER_LISTEN_MODE server needs a moment to boot
    // (Node startup, requiring "ws", binding the port) after `docker run -d`
    // returns — that command only confirms the container itself started, not
    // that the process inside has begun listening yet. Docker's port mapping
    // exists immediately at the OS level, so a connection attempt in that
    // window doesn't hang — it actively refuses (ECONNREFUSED) or, per
    // Node's happy-eyeballs dual-stack resolution of "localhost", surfaces as
    // an AggregateError wrapping both the IPv4 and IPv6 attempts. Either way
    // it's transient, not fatal — retry with a short backoff instead of
    // failing the whole session on what is normally a sub-second race.
    const attempt = () => {
      if (settled) return;
      const ws = new WebSocket(url);
      currentSocket = ws;

      ws.once("error", (err) => {
        if (settled) return;
        // Swallow and retry — a connection-establishment failure this early
        // (before any auth exchange) is almost always the startup race
        // described above. attachWorkerConnectionHandlers() below only ever
        // gets invoked once we're actually inside the "open" flow, so no
        // auth-related error can reach this handler; if it turns out this
        // retry masks a real problem (e.g. the container crashed instead of
        // being slow to start), the outer `timer` above still bounds total
        // wait time and surfaces a clear timeout error either way.
        setTimeout(attempt, 300);
      });

      attachWorkerConnectionHandlers(ws, {
        expectedSessionId: sessionId,
        onAuthenticated: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        onAuthMismatchOrFailure: (reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Local worker connection at ${url} failed to authenticate: ${reason}`));
        },
      });
    };

    attempt();
  });
}

/**
 * Per-connection message/close/error wiring shared by both directions:
 *  - setupWorkerWebSocket()'s wss.on("connection", ...) — ACA workers and any
 *    future mode where the worker dials in.
 *  - connectToLocalWorker() — WSL/Docker workers, where the backend dials out
 *    and gets handed a "connection" from the worker's own listen-mode server.
 *
 * Extracted so both paths get identical auth handling, message routing, and
 * workerConnections bookkeeping — the rest of the system (isWorkerConnected,
 * sendWorkerPrompt, etc.) doesn't need to know or care which side dialed.
 */
/**
 * Optional hooks for callers that need to know the outcome of the auth
 * handshake directly (currently only connectToLocalWorker(), which is
 * dialing out and needs to resolve/reject its own promise on the result).
 * setupWorkerWebSocket()'s server-side path doesn't need these — a worker
 * dialing in has nothing waiting on the handshake's outcome beyond what
 * workerConnections/eventHandler already provide.
 */
interface WorkerConnectionHooks {
  /** If set, the connection is expected to authenticate as this exact session. A mismatch is treated as a failure, not silently accepted. */
  expectedSessionId?: number;
  onAuthenticated?: (sessionId: number) => void;
  onAuthMismatchOrFailure?: (reason: string) => void;
}

function attachWorkerConnectionHandlers(ws: WebSocket, hooks: WorkerConnectionHooks = {}): void {
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
      hooks.onAuthMismatchOrFailure?.("authentication timeout");
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
        const sessionMismatch = hooks.expectedSessionId !== undefined && msg.sessionId !== hooks.expectedSessionId;
        if (secret === WORKER_SECRET && msg.sessionId && !sessionMismatch) {
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
          hooks.onAuthenticated?.(sessionId);
        } else {
          const reason = sessionMismatch
            ? `sessionId mismatch (expected ${hooks.expectedSessionId}, got ${msg.sessionId ?? "none"})`
            : !msg.sessionId ? "missing sessionId" : "invalid secret";
          log.warn("worker-auth-failed", {
            component: "worker-ws",
            sessionId: msg.sessionId ?? null,
            reason,
            msg: "Worker authentication rejected",
          });
          ws.send(JSON.stringify({ action: "auth-failed", reason: "Invalid credentials" }));
          ws.close(4003, "Authentication failed");
          hooks.onAuthMismatchOrFailure?.(reason);
        }
      } else {
        log.warn("worker-auth-missing", {
          component: "worker-ws",
          action: msg.action,
          msg: "Worker sent a non-auth message before authenticating; closing connection",
        });
        ws.close(4001, "Must authenticate first");
        hooks.onAuthMismatchOrFailure?.("worker sent a non-auth message first");
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

      case "agent-error": {
        const m = msg as WorkerAgentErrorMessage;
        eventHandler.onWorkerAgentError(sessionId, m.message, m.context ?? "");
        break;
      }

      case "task-create": {
        const m = msg as WorkerTaskCreateMessage;
        eventHandler.onWorkerTaskCreate(sessionId, {
          title: m.title,
          description: m.description,
          type: m.type,
          priority: m.priority,
          files: m.files ?? [],
        });
        break;
      }

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
}

/** Task metadata sent alongside a prompt so the worker can construct commit messages and PRs. */
export interface WorkerTaskMeta {
  id: number;
  title: string;
  type?: string;
  description: string;
  files: string[];
  /** Existing branch from a previous pipeline stage (null = create new branch) */
  branch?: string | null;
  /** Pull request URL from a previous pipeline stage (null = no PR yet) */
  pullRequestUrl?: string | null;
  /** Sibling tasks sharing the same branch (for grouped PR content). */
  siblingTasks?: Array<{ id: number; title: string; type: string; description: string; pullRequestUrl: string | null }>;
  /** Whether the task's tab has autoMergePrs enabled (for pr-complete MCP server injection). */
  autoMergePrs?: boolean;
  /** Whether all sibling tasks in the group are done (for pr-complete group guard). */
  allGroupTasksDone?: boolean;
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
