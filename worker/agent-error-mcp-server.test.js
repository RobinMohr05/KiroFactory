#!/usr/bin/env node
/**
 * Tests for agent-error-mcp-server.js — verifies JSON-RPC protocol handling
 * (initialize, tools/list, tools/call, ping) by spawning the server as a child
 * process and communicating over stdio.
 *
 * Uses Node's built-in test runner (node:test) — no external dependencies.
 * Run: node --test worker/agent-error-mcp-server.test.js
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the MCP server and return a helper to send/receive JSON-RPC messages.
 */
function spawnServer(env = {}) {
  const proc = spawn("node", [join(import.meta.dirname, "agent-error-mcp-server.js")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const messages = [];
  let resolveWait = null;

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          messages.push(msg);
          if (resolveWait) resolveWait();
        } catch { /* ignore non-JSON */ }
      }
    }
  });

  function send(msg) {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  async function waitForMessage(predicate, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => {
        resolveWait = resolve;
        setTimeout(resolve, 50);
      });
    }
    throw new Error(`Timed out waiting for message. Received: ${JSON.stringify(messages, null, 2)}`);
  }

  async function sendAndWaitResponse(msg, timeoutMs = 5000) {
    send(msg);
    return waitForMessage((m) => m.id === msg.id, timeoutMs);
  }

  function kill() {
    proc.stdin.end();
    proc.kill();
  }

  return { proc, send, waitForMessage, sendAndWaitResponse, kill, messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-error-mcp-server", () => {
  let server;

  afterEach(() => {
    if (server) server.kill();
  });

  it("responds to initialize with correct serverInfo", async () => {
    server = spawnServer();

    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "agent-error-mcp-server");
    assert.equal(response.result.protocolVersion, "2024-11-05");
    assert.deepEqual(response.result.capabilities, { tools: {} });
  });

  it("responds to ping", async () => {
    server = spawnServer();

    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
      params: {},
    });

    assert.equal(response.id, 2);
    assert.deepEqual(response.result, {});
  });

  it("lists the report_agent_error tool", async () => {
    server = spawnServer();

    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });

    assert.equal(response.result.tools.length, 1);
    assert.equal(response.result.tools[0].name, "report_agent_error");
    // message is required; context is optional
    assert.deepEqual(response.result.tools[0].inputSchema.required, ["message"]);
    assert.ok(response.result.tools[0].inputSchema.properties.message);
    assert.ok(response.result.tools[0].inputSchema.properties.context);
  });

  it("returns method-not-found for unknown methods", async () => {
    server = spawnServer();

    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 4,
      method: "unknown/method",
      params: {},
    });

    assert.equal(response.error.code, -32601);
  });

  it("tools/call with a valid message returns the agentError envelope", async () => {
    server = spawnServer();

    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "report_agent_error",
        arguments: {
          message: "The atlassian MCP server failed to initialize",
          context: "MCP config issue: the atlassian server failed to initialize",
        },
      },
    });

    assert.equal(response.result.isError, undefined);
    const parsed = JSON.parse(response.result.content[0].text);
    assert.deepEqual(parsed, {
      agentError: {
        message: "The atlassian MCP server failed to initialize",
        context: "MCP config issue: the atlassian server failed to initialize",
      },
    });
  });

  it("tools/call with a valid message but no context defaults context to empty string", async () => {
    server = spawnServer();

    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "report_agent_error",
        arguments: { message: "Something broke" },
      },
    });

    assert.equal(response.result.isError, undefined);
    const parsed = JSON.parse(response.result.content[0].text);
    assert.equal(parsed.agentError.message, "Something broke");
    assert.equal(parsed.agentError.context, "");
  });

  it("tools/call with a missing message returns an isError result", async () => {
    server = spawnServer();

    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "report_agent_error", arguments: {} },
    });

    assert.equal(response.result.isError, true);
    assert.ok(response.result.content[0].text.includes("message"));
  });

  it("tools/call with an empty message returns an isError result", async () => {
    server = spawnServer();

    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "report_agent_error", arguments: { message: "   " } },
    });

    assert.equal(response.result.isError, true);
    assert.ok(response.result.content[0].text.includes("message"));
  });

  it("tools/call with an unknown tool name returns a JSON-RPC error", async () => {
    server = spawnServer();

    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "not_a_real_tool", arguments: {} },
    });

    assert.equal(response.error.code, -32602);
  });
});
