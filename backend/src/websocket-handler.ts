import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import jwt from "jsonwebtoken";
import type { WsServerMessage, WsClientMessage } from "./types.js";
import { startSession, stopSession, sendPrompt, getSessionOutput } from "./session-manager.js";
import { log } from "./logger.js";

const JWT_SECRET = process.env.JWT_SECRET || "kirofactory-dev-secret-change-in-production";
const COOKIE_NAME = "kf_session";

const clients = new Set<WebSocket>();

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

    clients.add(ws);
    ws.send(
      JSON.stringify({ type: "connected", message: "KiroFactory WebSocket connected" })
    );

    ws.on("message", (data) => {
      try {
        const msg: WsClientMessage = JSON.parse(data.toString());
        handleClientMessage(ws, msg);
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

async function handleClientMessage(ws: WebSocket, msg: WsClientMessage): Promise<void> {
  switch (msg.action) {
    case "session-start":
      await startSession(msg.sessionId);
      break;

    case "session-stop":
      await stopSession(msg.sessionId);
      break;

    case "session-prompt":
      if ("text" in msg && msg.text) {
        await sendPrompt(msg.sessionId, msg.text);
      }
      break;

    case "session-get-output": {
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

export function broadcast(msg: WsServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}
