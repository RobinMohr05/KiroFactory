#!/usr/bin/env node
/**
 * Verdict MCP Server — Lightweight stdio MCP server exposing `report_verdict`.
 *
 * Agents call this tool to signal that a task requires no further pipeline
 * stages (e.g. nothing to change, nothing to review). The server validates the
 * input and echoes the verdict back in its response so the orchestrator can
 * capture it from the ACP tool_call_update content stream.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

import { createInterface } from "node:readline";

const SERVER_NAME = "verdict-mcp-server";
const SERVER_VERSION = "1.0.0";

const VALID_VERDICTS = ["resolved", "no_action_needed"];

const TOOL_DEFINITION = {
  name: "report_verdict",
  description:
    "Report the outcome of your work on this task. Call this tool ONLY when you have " +
    "determined that no file changes are needed — the task is already implemented, " +
    "there is nothing to fix, or the review found no issues. Do NOT call this tool if " +
    "you made (or intend to make) any file changes.",
  inputSchema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: VALID_VERDICTS,
        description:
          'Use "no_action_needed" when no changes are required (task is already done, ' +
          'nothing to fix/review). Use "resolved" when the task was completed normally ' +
          "(you made changes).",
      },
      reason: {
        type: "string",
        description:
          "Brief explanation of why this verdict was chosen (e.g. 'Feature already " +
          "implemented in commit abc123', 'Code review found no issues').",
      },
    },
    required: ["verdict", "reason"],
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

  if (toolName !== "report_verdict") {
    respondError(id, -32602, `Unknown tool: ${toolName}`);
    return;
  }

  const { verdict, reason } = args;

  if (!verdict || !VALID_VERDICTS.includes(verdict)) {
    respond(id, {
      content: [
        {
          type: "text",
          text: `Error: verdict must be one of: ${VALID_VERDICTS.join(", ")}. Got: "${verdict}"`,
        },
      ],
      isError: true,
    });
    return;
  }

  if (!reason || typeof reason !== "string") {
    respond(id, {
      content: [
        { type: "text", text: 'Error: "reason" is required and must be a non-empty string.' },
      ],
      isError: true,
    });
    return;
  }

  // Echo the verdict back as structured JSON so the orchestrator can parse it
  // from the tool_call_update content stream.
  respond(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify({ verdict, reason }),
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
