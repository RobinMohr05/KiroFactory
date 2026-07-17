import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { WsServerMessage, WsClientMessage } from "./types.js";
import { startSession, stopSession, sendPrompt, getSessionOutput } from "./session-manager.js";

const clients = new Set<WebSocket>();

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
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
