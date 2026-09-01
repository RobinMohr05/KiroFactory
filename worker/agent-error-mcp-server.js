#!/usr/bin/env node
/**
 * Agent Error MCP Server — Lightweight stdio MCP server exposing
 * `report_agent_error`.
 *
 * Available to every Kiro agent session (all agent kinds, both ACA/hosted and
 * WSL/local worker modes), so the agent can proactively report a problem it
 * notices (e.g. an MCP server failing to initialize) instead of relying only
 * on the orchestrator's automatic error detection.
 *
 * Unlike pr-complete-mcp-server.js, this tool makes NO external HTTP calls: it
 * simply validates the input and echoes a distinctive envelope back in its
 * response so the worker's output parser (worker.js's logSessionUpdate()) can
 * capture it from the ACP tool_call_update content stream and forward it to
 * the orchestrator over the existing WebSocket connection. This mirrors how
 * verdict-mcp-server.js's `{"verdict":...}` shape is detected.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

import { createInterface } from "node:readline";

const SERVER_NAME = "agent-error-mcp-server";
const SERVER_VERSION = "1.0.0";

const TOOL_DEFINITION = {
  name: "report_agent_error",
  description:
    "Proactively report a problem you notice during this session (e.g. an MCP " +
    "server failing to initialize, a tool you expected to have being " +
    "unavailable, or any other environment/setup issue). Use this to surface " +
    "the problem to the orchestrator's Errors view instead of silently working " +
    "around it. This does not stop or fail the task — it just records the issue.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "A short, clear description of the problem (e.g. 'The atlassian MCP " +
          "server failed to initialize').",
      },
      context: {
        type: "string",
        description:
          "Optional free-text context about what you were doing when you " +
          "noticed the problem (e.g. 'MCP config issue: the atlassian server " +
          "failed to initialize').",
      },
    },
    required: ["message"],
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

  if (toolName !== "report_agent_error") {
    respondError(id, -32602, `Unknown tool: ${toolName}`);
    return;
  }

  const { message, context } = args;

  if (!message || typeof message !== "string" || message.trim() === "") {
    respond(id, {
      content: [
        { type: "text", text: 'Error: "message" is required and must be a non-empty string.' },
      ],
      isError: true,
    });
    return;
  }

  const contextStr = typeof context === "string" ? context : "";

  // Echo the error back as a distinctive JSON envelope so the orchestrator can
  // parse it from the tool_call_update content stream (see worker.js's
  // logSessionUpdate()). Mirrors verdict-mcp-server.js's {"verdict":...} shape.
  respond(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify({ agentError: { message, context: contextStr } }),
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
