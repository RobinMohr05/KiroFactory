#!/usr/bin/env node
/**
 * List Tasks MCP Server — Lightweight stdio MCP server exposing `list_tasks`.
 *
 * Available only to inspector-kind agent sessions that can also create tasks
 * (AGENT_KIND=inspector + TASK_CREATE_ENABLED=true — see worker.js's
 * buildMcpServers()). Read access is deliberately bundled with create access:
 * every session that can file tasks onto a tab should be able to see all tasks
 * already on that tab first.
 *
 * Unlike task-create-mcp-server.js/agent-error-mcp-server.js (which just echo
 * a distinctive envelope back for the worker's output parser to forward), this
 * tool needs a SYNCHRONOUS answer — the list of tasks — before it can return.
 * It therefore reaches back to the worker process over a local unix-domain
 * socket (LIST_TASKS_IPC_PATH, set by worker.js). worker.js relays the request
 * to the orchestrator over its existing WebSocket connection (a correlated
 * request/response pair) and writes the resulting task array back over the
 * socket. This server has NO DB access and NO orchestrator connection of its
 * own.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

import { createInterface } from "node:readline";
import { createConnection } from "node:net";

const SERVER_NAME = "list-tasks-mcp-server";
const SERVER_VERSION = "1.0.0";

const LIST_TASKS_IPC_PATH = process.env.LIST_TASKS_IPC_PATH || "";
/** Upper bound on how long we wait for the worker to answer over the socket. */
const IPC_TIMEOUT_MS = 30_000;

const TOOL_DEFINITION = {
  name: "list_tasks",
  description:
    "List all tasks on the board for the tab this session is assigned to. " +
    "Returns id, title, type, priority, and state for each task. Use this to " +
    "check what's already tracked before creating a new task, so you don't file " +
    "a duplicate. Only available to review/inspection sessions.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

// ---------------------------------------------------------------------------
// IPC — ask the worker (which owns the orchestrator WebSocket) for the board.
// One request per connection: connect, write a single JSON line, read a single
// JSON line back ({ tasks: [...] } or { error: "..." }), then close.
// ---------------------------------------------------------------------------

function fetchTasksFromWorker() {
  return new Promise((resolve, reject) => {
    if (!LIST_TASKS_IPC_PATH) {
      reject(new Error("LIST_TASKS_IPC_PATH is not set — cannot reach the worker to list tasks."));
      return;
    }

    const conn = createConnection(LIST_TASKS_IPC_PATH);
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { conn.destroy(); } catch { /* noop */ }
      reject(new Error(`Timed out after ${IPC_TIMEOUT_MS / 1000}s waiting for the worker to return the task list.`));
    }, IPC_TIMEOUT_MS);

    conn.on("connect", () => {
      conn.write(JSON.stringify({ type: "list-tasks" }) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* noop */ }
      try {
        const parsed = JSON.parse(line || "{}");
        if (parsed.error) {
          reject(new Error(String(parsed.error)));
        } else {
          resolve(Array.isArray(parsed.tasks) ? parsed.tasks : []);
        }
      } catch (err) {
        reject(new Error(`Malformed response from worker: ${err?.message || String(err)}`));
      }
    });

    conn.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not reach the worker over IPC: ${err?.message || String(err)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      notify("notifications/initialized", {});
      break;

    case "tools/list":
      respond(id, { tools: [TOOL_DEFINITION] });
      break;

    case "tools/call":
      handleToolCall(id, params);
      break;

    case "ping":
      respond(id, {});
      break;

    default:
      if (id !== undefined) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

async function handleToolCall(id, params) {
  const toolName = params?.name;

  if (toolName !== "list_tasks") {
    respondError(id, -32602, `Unknown tool: ${toolName}`);
    return;
  }

  try {
    const tasks = await fetchTasksFromWorker();
    respond(id, {
      content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
    });
  } catch (err) {
    respond(id, {
      content: [{ type: "text", text: `Error listing tasks: ${err?.message || String(err)}` }],
      isError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.method && msg.id !== undefined) {
      handleRequest(msg);
    }
    // Notifications (no id) — ignore silently
  } catch {
    // Non-JSON line — ignore
  }
});

rl.on("close", () => {
  process.exit(0);
});
