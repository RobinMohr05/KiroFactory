import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { IncomingMessage } from "http";
import jwt from "jsonwebtoken";
import type { WsServerMessage, WsClientMessage } from "./types.js";
import { startSession, stopSession, sendPrompt, getSessionOutput } from "./session-manager.js";

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

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req: IncomingMessage) => {
    // Authenticate the WebSocket connection
    const token = extractWsToken(req);
    if (!token) {
      ws.close(4001, "Authentication required");
      return;
    }

    const userId = verifyWsToken(token);
    if (!userId) {
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

export function broadcast(msg: WsServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}
