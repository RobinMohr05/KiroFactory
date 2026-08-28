import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import jwt from "jsonwebtoken";
import type { WsServerMessage, WsClientMessage } from "./types.js";
import { startSession, stopSession, sendPrompt, getSessionOutput, getSession } from "./session-manager.js";
import { log } from "./logger.js";

const JWT_SECRET = process.env.JWT_SECRET || "vibecode-heaven-dev-secret-change-in-production";
const COOKIE_NAME = "kf_session";

// Maps each connected socket to the userId it authenticated as. Every
// broadcast() call MUST pass the target user(s) — sessions, tabs, tasks,
// agents, and errors are all single-tenant, so a message meant for one
// account must never reach another account's browser tab.
const clients = new Map<WebSocket, number>();

/**
 * Extracts the JWT token from an incoming WebSocket upgrade request.
 * Checks cookies first, then falls back to a `token` query parameter.
 */
function extractWsToken(req: IncomingMessage): string | null {
  // Parse cookies from the Cookie header
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(";").reduce((acc, cookie) => {
      const [key, ...valParts] = cookie.trim().split("=");
      acc[key] = valParts.join("=");
      return acc;
    }, {} as Record<string, string>);

    if (cookies[COOKIE_NAME]) {
      return cookies[COOKIE_NAME];
    }
  }

  // Fall back to ?token= query parameter (useful for non-browser clients)
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam) {
    return tokenParam;
  }

  return null;
}

/**
 * Verifies a JWT token and returns the userId if valid, null otherwise.
 */
function verifyWsToken(token: string): number | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number };
    if (payload.userId && typeof payload.userId === "number") {
      return payload.userId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create the client-facing WebSocket server (path "/ws").
 *
 * Uses `noServer: true` so the HTTP `upgrade` event can be routed by a single
 * handler in index.ts. Attaching multiple `WebSocketServer` instances directly
 * to the same HTTP server via the `{ server, path }` option does NOT work: each
 * instance registers its own `upgrade` listener and calls `handleUpgrade`, which
 * calls `abortHandshake` (destroying the socket) on any path mismatch. Whichever
 * server is registered first therefore destroys upgrade requests destined for the
 * others. Routing upgrades explicitly avoids that conflict.
 */
export function setupWebSocket(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req: IncomingMessage) => {
    // Authenticate the WebSocket connection
    const token = extractWsToken(req);
    if (!token) {
      log.warn("ws-auth-rejected", {
        component: "ws",
        reason: "missing token",
        remoteAddress: req.socket.remoteAddress,
      });
      ws.close(4001, "Authentication required");
      return;
    }

    const userId = verifyWsToken(token);
    if (!userId) {
      log.warn("ws-auth-rejected", {
        component: "ws",
        reason: "invalid or expired token",
        remoteAddress: req.socket.remoteAddress,
      });
      ws.close(4001, "Invalid or expired token");
      return;
    }

    clients.set(ws, userId);
    ws.send(
      JSON.stringify({ type: "connected", message: "Vibecode Heaven WebSocket connected" })
    );

    ws.on("message", (data) => {
      try {
        const msg: WsClientMessage = JSON.parse(data.toString());
        handleClientMessage(ws, userId, msg);
      } catch {
        /* ignore malformed messages */
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  return wss;
}

/**
 * All session-scoped WS actions must verify the session belongs to the
 * connection's authenticated user — otherwise any logged-in user could
 * start/stop/prompt/read another account's session just by guessing an id.
 */
function isOwnSession(sessionId: number, userId: number): boolean {
  const session = getSession(sessionId);
  return !!session && session.userId === userId;
}

async function handleClientMessage(ws: WebSocket, userId: number, msg: WsClientMessage): Promise<void> {
  switch (msg.action) {
    case "session-start":
      if (isOwnSession(msg.sessionId, userId)) {
        await startSession(msg.sessionId);
      }
      break;

    case "session-stop":
      if (isOwnSession(msg.sessionId, userId)) {
        await stopSession(msg.sessionId);
      }
      break;

    case "session-prompt":
      if ("text" in msg && msg.text && isOwnSession(msg.sessionId, userId)) {
        await sendPrompt(msg.sessionId, msg.text);
      }
      break;

    case "session-get-output": {
      if (!isOwnSession(msg.sessionId, userId)) break;
      const output = getSessionOutput(msg.sessionId);
      ws.send(JSON.stringify({
        type: "session-output-history",
        sessionId: msg.sessionId,
        entries: output,
      }));
      break;
    }

    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      break;
  }
}

/**
 * Returns the number of currently connected WebSocket clients.
 * Used by the poll loop to skip DB queries when nobody is listening.
 */
export function getConnectedClientCount(): number {
  return clients.size;
}

/**
 * Send a message to every connection belonging to a single user (a user may
 * have multiple tabs/devices open, so this is a "for each of their sockets"
 * send, not a single-socket send).
 *
 * Every tasks/tabs/sessions/agents/errors record is single-tenant, so all
 * call sites MUST pass the owning userId — there is no "broadcast to
 * everyone" use case for this data.
 */
export function broadcastToUser(userId: number, msg: WsServerMessage): void {
  const data = JSON.stringify(msg);
  for (const [client, clientUserId] of clients) {
    if (clientUserId === userId && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/**
 * Send a message to every currently authenticated WebSocket connection,
 * regardless of which user it belongs to.
 *
 * Unlike broadcastToUser(), this is intentionally NOT scoped to a single
 * account — it exists solely for host-machine-level data that has no
 * per-user ownership concept at all, most notably WSL/Docker diagnostics
 * (see wsl-diagnostics-collector.ts): there is exactly one local WSL distro
 * per developer machine (see ARCHITECTURE.md §12 on the single-developer
 * local-mode model), so "which user does this docker event belong to" is a
 * meaningless question — every authenticated client on this machine should
 * see it. Do NOT use this for tasks/tabs/sessions/agents/errors or any other
 * per-account data; those must keep using broadcastToUser().
 */
export function broadcastToAll(msg: WsServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients.keys()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}
