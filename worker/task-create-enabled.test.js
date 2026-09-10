#!/usr/bin/env node
/**
 * Tests for the TASK_CREATE_ENABLED gating of the task-create MCP server
 * in buildMcpServers() (worker/worker.js).
 *
 * Verifies:
 *   1. task-create is included when AGENT_KIND=inspector AND TASK_CREATE_ENABLED=true
 *   2. task-create is NOT included when AGENT_KIND=inspector but TASK_CREATE_ENABLED is unset/false
 *   3. task-create is NOT included when AGENT_KIND=editor even if TASK_CREATE_ENABLED=true
 *
 * These tests exercise the REAL buildMcpServers() in worker.js — not a copy of
 * its gating condition. worker.js can't be imported as a module (it calls
 * connectWithRetry / listenForOrchestrator at load time and process.exit(1) on
 * missing env), so it exposes a test seam instead: when WORKER_PRINT_MCP_SERVERS=1
 * is set (with the required SESSION_ID / WORKER_SECRET / WORKER_LISTEN_MODE env),
 * it calls buildMcpServers(), prints the resulting server names as
 * {"__mcpServers":[...]} to stdout, and exits(0) before starting any real I/O.
 * We spawn worker.js itself here and assert on that output, so a change to the
 * real gating condition in worker.js would be caught by these tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

const WORKER_PATH = join(import.meta.dirname, "worker.js");

/**
 * Spawn the real worker.js with the print-servers test seam enabled and the
 * given env overrides, then parse the {"__mcpServers":[...]} line it prints.
 *
 * SESSION_ID / WORKER_SECRET / WORKER_LISTEN_MODE satisfy worker.js's startup
 * env validation so the seam is reached; WORKER_PRINT_MCP_SERVERS=1 makes it
 * print buildMcpServers()'s output and exit before any WebSocket/kiro-cli I/O.
 * REPO_URL is deliberately left unset so buildMcpServers() doesn't add the
 * repo-dependent pr-review/git-delivery servers — keeping the assertions
 * focused on the task-create gating.
 */
function runWorkerMcpServers(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKER_PATH],
      {
        env: {
          // Minimal env to pass worker.js's startup validation and reach the seam.
          SESSION_ID: "1",
          WORKER_SECRET: "test-secret",
          WORKER_LISTEN_MODE: "9099",
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
      // worker.js also emits logInfo() JSON lines to stdout; find the one
      // carrying our distinct __mcpServers marker.
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
      } catch (e) {
        reject(new Error(`Could not parse __mcpServers line: ${line}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildMcpServers — TASK_CREATE_ENABLED gating", () => {
  it("includes task-create when AGENT_KIND=inspector AND TASK_CREATE_ENABLED=true", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "inspector", TASK_CREATE_ENABLED: "true" });
    assert.ok(
      servers.includes("task-create"),
      `Expected task-create in servers, got: ${JSON.stringify(servers)}`
    );
  });

  it("omits task-create when AGENT_KIND=inspector but TASK_CREATE_ENABLED is not set", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "inspector", TASK_CREATE_ENABLED: "" });
    assert.ok(
      !servers.includes("task-create"),
      `Expected task-create NOT in servers, got: ${JSON.stringify(servers)}`
    );
  });

  it("omits task-create when AGENT_KIND=inspector and TASK_CREATE_ENABLED=false", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "inspector", TASK_CREATE_ENABLED: "false" });
    assert.ok(
      !servers.includes("task-create"),
      `Expected task-create NOT in servers, got: ${JSON.stringify(servers)}`
    );
  });

  it("omits task-create when AGENT_KIND=editor even if TASK_CREATE_ENABLED=true", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "editor", TASK_CREATE_ENABLED: "true" });
    assert.ok(
      !servers.includes("task-create"),
      `Expected task-create NOT in servers for editor kind, got: ${JSON.stringify(servers)}`
    );
  });

  it("omits task-create when neither AGENT_KIND nor TASK_CREATE_ENABLED is set", async () => {
    const servers = await runWorkerMcpServers({ AGENT_KIND: "editor" });
    assert.ok(
      !servers.includes("task-create"),
      `Expected task-create NOT in servers by default, got: ${JSON.stringify(servers)}`
    );
  });
});
