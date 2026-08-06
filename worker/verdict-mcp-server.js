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
import { readFileSync } from "node:fs";

const SERVER_NAME = "verdict-mcp-server";
const SERVER_VERSION = "1.0.0";

const VALID_VERDICTS = ["resolved", "no_action_needed", "changes_requested"];

/**
 * Path to the review-comment counter file shared with pr-review-mcp-server.js
 * (set by worker.js's buildMcpServers(), reset to "0" at the start of every
 * turn in deliverPrompt()). Absent for editor-kind sessions, which never need
 * this check since they never report "changes_requested".
 */
const REVIEW_MARKER_PATH = process.env.REVIEW_MARKER_PATH || "";

/**
 * Read how many review comments were posted so far this turn.
 * Fails open (returns null, meaning "unknown, don't block") on any read
 * error — a missing/corrupt counter file must never make a legitimate
 * verdict call fail.
 */
function getReviewCommentCount() {
  if (!REVIEW_MARKER_PATH) return null;
  try {
    const raw = readFileSync(REVIEW_MARKER_PATH, "utf-8").trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

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
          '(you made changes). Use "changes_requested" when your review/QA found one or ' +
          "more issues and you have posted them as PR comments — the task will be sent " +
          "back for rework.",
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

  // Hard guard: "changes_requested" claims issues were found AND posted as PR
  // comments (see the tool description). Without this check, an agent could
  // describe findings only in its own chat transcript, report
  // "changes_requested", and send the task back to "todo" with feedback that
  // literally does not exist anywhere the next agent can read it — the task
  // then bounces forever since get_pr_review_comments returns nothing to fix.
  if (verdict === "changes_requested") {
    const commentCount = getReviewCommentCount();
    if (commentCount === 0) {
      respond(id, {
        content: [
          {
            type: "text",
            text:
              'Error: verdict "changes_requested" requires at least one post_review_comment ' +
              "call this turn, but none were made. Post a comment for each issue you found " +
              "using the post_review_comment tool, THEN call report_verdict again. If you " +
              'found no issues, use verdict "no_action_needed" instead.',
          },
        ],
        isError: true,
      });
      return;
    }
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
