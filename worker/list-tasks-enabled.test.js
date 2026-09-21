#!/usr/bin/env node
/**
 * Tests for the gating of the list-tasks MCP server in buildMcpServers()
 * (worker/worker.js).
 *
 * The list-tasks server gives inspector-kind sessions that can create tasks
 * read access to the board. It is gated on the EXACT same condition as the
 * task-create server — AGENT_KIND=inspector AND TASK_CREATE_ENABLED=true —
 * with no independent toggle (read access is bundled with create access).
 *
 * Verifies:
 *   1. list-tasks is included when AGENT_KIND=inspector AND TASK_CREATE_ENABLED=true
 *   2. list-tasks is NOT included when AGENT_KIND=inspector but TASK_CREATE_ENABLED is unset/false
 *   3. list-tasks is NOT included when AGENT_KIND=editor even if TASK_CREATE_ENABLED=true
 *
 * Like task-create-enabled.test.js, these tests exercise the REAL
 * buildMcpServers() in worker.js via the WORKER_PRINT_MCP_SERVERS=1 test seam.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

const WORKER_PATH = join(import.meta.dirname, "worker.js");

function runWorkerMcpServers(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKER_PATH],
      {
        env: {
          SESSION_ID: "1",
          WORKER_SECRET: "test-secret",
          WORKER_LISTEN_MODE: "9098",
          WORKER_PRINT_MCP_SERVERS: "1",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`worker.js exited ${code}: ${stderr}`));
        return;
      }
      const line = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse()
        .find((l) => l.includes("__mcpServers"));
      if (!line) {
        reject(new Error(`Could not find __mcpServers output line. stdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line).__mcpServers);
      } catch {
        reject(new Error(`Could not parse __mcpServers line: ${line}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildMcpServers — list-tasks gating (bundled with task-create)", () => {
  it("includes list-tasks when AGENT_KIND=inspector AND TASK_CREATE_ENABLED=true", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "inspector", TASK_CREATE_ENABLED: "true" });
    assert.ok(
      servers.includes("list-tasks"),
      `Expected list-tasks in servers, got: ${JSON.stringify(servers)}`
    );
  });

  it("omits list-tasks when AGENT_KIND=inspector but TASK_CREATE_ENABLED is not set", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "inspector", TASK_CREATE_ENABLED: "" });
    assert.ok(
      !servers.includes("list-tasks"),
      `Expected list-tasks NOT in servers, got: ${JSON.stringify(servers)}`
    );
  });

  it("omits list-tasks when AGENT_KIND=inspector and TASK_CREATE_ENABLED=false", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "inspector", TASK_CREATE_ENABLED: "false" });
    assert.ok(
      !servers.includes("list-tasks"),
      `Expected list-tasks NOT in servers, got: ${JSON.stringify(servers)}`
    );
  });

  it("omits list-tasks when AGENT_KIND=editor even if TASK_CREATE_ENABLED=true", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "editor", TASK_CREATE_ENABLED: "true" });
    assert.ok(
      !servers.includes("list-tasks"),
      `Expected list-tasks NOT in servers for editor kind, got: ${JSON.stringify(servers)}`
    );
  });

  it("omits list-tasks when neither AGENT_KIND nor TASK_CREATE_ENABLED is set", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "editor" });
    assert.ok(
      !servers.includes("list-tasks"),
      `Expected list-tasks NOT in servers by default, got: ${JSON.stringify(servers)}`
    );
  });
});
