#!/usr/bin/env node
/**
 * Tests for list-tasks-mcp-server.js — verifies JSON-RPC protocol handling
 * (initialize, tools/list, tools/call, ping) by spawning the server as a child
 * process and communicating over stdio.
 *
 * Unlike task-create-mcp-server.js (which just echoes an envelope), this
 * server has to reach back to the worker over a local unix-domain socket to
 * fetch the board. The tests stand up a fake IPC server on a temp socket path
 * (passed as LIST_TASKS_IPC_PATH) that replies with a canned task list, and
 * assert the tool returns exactly what came back.
 *
 * Uses Node's built-in test runner (node:test) — no external dependencies.
 * Run: node --test worker/list-tasks-mcp-server.test.js
 */

import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";

// ---------------------------------------------------------------------------
// Fake IPC server (stands in for worker.js's ensureListTasksIpcServer())
// ---------------------------------------------------------------------------

function startFakeIpcServer(socketPath, responder) {
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* noop */ }
  }
  const server = createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();
      buffer = "";
      let req = {};
      try { req = JSON.parse(line || "{}"); } catch { /* ignore */ }
      const reply = responder(req);
      conn.write(JSON.stringify(reply) + "\n");
      conn.end();
    });
    conn.on("error", () => { /* noop */ });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// MCP server child helper
// ---------------------------------------------------------------------------

function spawnServer(env = {}) {
  const proc = spawn("node", [join(import.meta.dirname, "list-tasks-mcp-server.js")], {
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
          messages.push(JSON.parse(line));
          if (resolveWait) resolveWait();
        } catch { /* ignore */ }
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

  return { proc, send, sendAndWaitResponse, waitForMessage, kill };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("list-tasks-mcp-server", () => {
  let server;
  let ipc;
  let socketPath;

  beforeEach(() => {
    socketPath = join(tmpdir(), `lt-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  });

  afterEach(() => {
    if (server) server.kill();
    server = null;
    if (ipc) {
      try { ipc.close(); } catch { /* noop */ }
      ipc = null;
    }
    if (socketPath && existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* noop */ }
    }
  });

  it("responds to initialize with correct serverInfo", async () => {
    server = spawnServer({ LIST_TASKS_IPC_PATH: socketPath });
    const response = await server.sendAndWaitResponse({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "list-tasks-mcp-server");
    assert.equal(response.result.protocolVersion, "2024-11-05");
    assert.deepEqual(response.result.capabilities, { tools: {} });
  });

  it("responds to ping", async () => {
    server = spawnServer({ LIST_TASKS_IPC_PATH: socketPath });
    const response = await server.sendAndWaitResponse({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
    assert.equal(response.id, 2);
    assert.deepEqual(response.result, {});
  });

  it("lists the list_tasks tool with an empty input schema", async () => {
    server = spawnServer({ LIST_TASKS_IPC_PATH: socketPath });
    const response = await server.sendAndWaitResponse({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.equal(response.result.tools.length, 1);
    assert.equal(response.result.tools[0].name, "list_tasks");
    assert.deepEqual(response.result.tools[0].inputSchema.required, []);
  });

  it("returns method-not-found for unknown methods", async () => {
    server = spawnServer({ LIST_TASKS_IPC_PATH: socketPath });
    const response = await server.sendAndWaitResponse({ jsonrpc: "2.0", id: 4, method: "unknown/method", params: {} });
    assert.equal(response.error.code, -32601);
  });

  it("tools/call returns the tasks fetched over the IPC socket", async () => {
    const tasks = [
      { id: 10, title: "Fix the thing", type: "bug", priority: 1, state: "todo" },
      { id: 11, title: "Add a feature", type: "feature", priority: 3, state: "in-progress" },
    ];
    ipc = await startFakeIpcServer(socketPath, () => ({ tasks }));

    server = spawnServer({ LIST_TASKS_IPC_PATH: socketPath });
    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "list_tasks", arguments: {} },
    });

    assert.equal(response.result.isError, undefined);
    const parsed = JSON.parse(response.result.content[0].text);
    assert.deepEqual(parsed, tasks);
  });

  it("tools/call surfaces an IPC error as an isError result", async () => {
    ipc = await startFakeIpcServer(socketPath, () => ({ error: "boom" }));

    server = spawnServer({ LIST_TASKS_IPC_PATH: socketPath });
    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "list_tasks", arguments: {} },
    });

    assert.equal(response.result.isError, true);
    assert.ok(response.result.content[0].text.includes("boom"));
  });

  it("tools/call with an unknown tool name returns a JSON-RPC error", async () => {
    server = spawnServer({ LIST_TASKS_IPC_PATH: socketPath });
    const response = await server.sendAndWaitResponse({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "not_a_real_tool", arguments: {} },
    });
    assert.equal(response.error.code, -32602);
  });
});
