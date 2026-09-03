#!/usr/bin/env node
/**
 * Task Create MCP Server — Lightweight stdio MCP server exposing
 * `create_task`.
 *
 * Available only to inspector-kind agent sessions (AGENT_KIND=inspector —
 * e.g. code-reviewer-agent, qa-improvement-agent; see worker.js's
 * buildMcpServers()), so a review/QA pass can turn findings into DB-backed
 * tasks on the board instead of only reporting them in prose.
 *
 * Like agent-error-mcp-server.js, this tool makes NO external HTTP calls: it
 * validates the input and echoes a distinctive envelope back in its response
 * so the worker's output parser (worker.js's logSessionUpdate()) can capture
 * it from the ACP tool_call_update content stream and forward it to the
 * orchestrator over the existing WebSocket connection, which is what
 * actually calls createTask() against Neo4j (see session-manager.ts's
 * handleWorkerTaskCreate()). This mirrors report_agent_error's
 * {"agentError":...} envelope and verdict-mcp-server.js's {"verdict":...}
 * envelope.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

import { createInterface } from "node:readline";

const SERVER_NAME = "task-create-mcp-server";
const SERVER_VERSION = "1.0.0";

const VALID_TYPES = ["bug", "feature", "improvement"];
const VALID_PRIORITIES = [1, 2, 3, 4];

const TOOL_DEFINITION = {
  name: "create_task",
  description:
    "Create a new task on the board for an issue you found during this review. " +
    "Use this to turn a concrete, verified finding into actionable follow-up work " +
    "instead of only describing it in your response. Only available to " +
    "review/inspection sessions.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A short, specific title for the task (e.g. 'Hardcoded JWT secret fallback in auth.ts').",
      },
      description: {
        type: "string",
        description:
          "A clear description of the issue: what's wrong, where (file/line if known), why it matters, and how to fix it.",
      },
      type: {
        type: "string",
        enum: VALID_TYPES,
        description: "The kind of work this task represents.",
      },
      priority: {
        type: "number",
        enum: VALID_PRIORITIES,
        description: "Priority, 1 (Critical) through 4 (Low).",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of file paths relevant to this task, if known.",
      },
    },
    required: ["title", "description", "type", "priority"],
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

function notify(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  process.stdout.write(msg + "\n");
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
      // Send initialized notification after responding
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
      // Unknown method — respond with method-not-found
      if (id !== undefined) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

function handleToolCall(id, params) {
  const toolName = params?.name;
  const args = params?.arguments ?? {};

  if (toolName !== "create_task") {
    respondError(id, -32602, `Unknown tool: ${toolName}`);
    return;
  }

  const { title, description, type, priority, files } = args;

  if (!title || typeof title !== "string" || title.trim() === "") {
    respond(id, {
      content: [{ type: "text", text: 'Error: "title" is required and must be a non-empty string.' }],
      isError: true,
    });
    return;
  }

  if (!description || typeof description !== "string" || description.trim() === "") {
    respond(id, {
      content: [{ type: "text", text: 'Error: "description" is required and must be a non-empty string.' }],
      isError: true,
    });
    return;
  }

  if (!VALID_TYPES.includes(type)) {
    respond(id, {
      content: [{ type: "text", text: `Error: "type" must be one of: ${VALID_TYPES.join(", ")}.` }],
      isError: true,
    });
    return;
  }

  if (!VALID_PRIORITIES.includes(priority)) {
    respond(id, {
      content: [{ type: "text", text: `Error: "priority" must be one of: ${VALID_PRIORITIES.join(", ")}.` }],
      isError: true,
    });
    return;
  }

  const filesArr = Array.isArray(files) ? files.filter((f) => typeof f === "string") : [];

  // Echo the task spec back as a distinctive JSON envelope so the
  // orchestrator can parse it from the tool_call_update content stream (see
  // worker.js's logSessionUpdate()). Mirrors agent-error-mcp-server.js's
  // {"agentError":...} shape and verdict-mcp-server.js's {"verdict":...} shape.
  respond(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          taskCreated: { title, description, type, priority, files: filesArr },
        }),
      },
    ],
  });
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
