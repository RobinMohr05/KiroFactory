#!/usr/bin/env node
/**
 * Tests for git-delivery-mcp-server.js — verifies JSON-RPC protocol handling
 * (initialize, tools/list, tools/call) by spawning the server as a child process
 * and communicating over stdio.
 *
 * Uses Node's built-in test runner (node:test) — no external dependencies.
 * Run: node --test worker/git-delivery-mcp-server.test.js
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the MCP server with the given env vars and return a helper to
 * send/receive JSON-RPC messages.
 */
function spawnServer(env = {}) {
  const proc = spawn("node", [join(import.meta.dirname, "git-delivery-mcp-server.js")], {
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

/**
 * Create a temporary git repository for testing.
 * Returns { dir, cleanup }.
 */
function createTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "git-delivery-test-"));
  execSync("git init", { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execSync("git add -A && git commit -m 'initial'", { cwd: dir });
  // Create a develop branch
  execSync("git checkout -b develop", { cwd: dir });
  execSync("git checkout -b main", { cwd: dir });
  execSync("git checkout develop", { cwd: dir });

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Create a bare remote repo and a workspace clone for testing push operations.
 * Returns { remoteDir, workspaceDir, cleanup }.
 */
function createTestWorkspace() {
  const base = mkdtempSync(join(tmpdir(), "git-delivery-ws-"));
  const remoteDir = join(base, "remote.git");
  const workspaceDir = join(base, "workspace");

  // Create bare remote
  mkdirSync(remoteDir);
  execSync("git init --bare", { cwd: remoteDir });

  // Clone it as workspace
  execSync(`git clone "${remoteDir}" workspace`, { cwd: base });
  execSync('git config user.email "test@test.com"', { cwd: workspaceDir });
  execSync('git config user.name "Test"', { cwd: workspaceDir });

  // Create an initial commit and a develop branch on remote
  writeFileSync(join(workspaceDir, "README.md"), "# Test Repo\n");
  execSync("git add -A && git commit -m 'initial'", { cwd: workspaceDir });
  execSync("git checkout -b develop", { cwd: workspaceDir });
  execSync("git push origin develop", { cwd: workspaceDir });
  execSync("git push origin HEAD:refs/heads/main", { cwd: workspaceDir });

  return {
    remoteDir,
    workspaceDir,
    base,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("git-delivery-mcp-server", () => {
  describe("protocol basics", () => {
    let server;

    afterEach(() => {
      if (server) server.kill();
    });

    it("responds to initialize with correct serverInfo", async () => {
      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#1_test",
        DEV_BRANCH: "develop",
        WORKSPACE: "/tmp/nonexistent",
        TASK_ID: "1",
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      assert.equal(response.jsonrpc, "2.0");
      assert.equal(response.id, 1);
      assert.equal(response.result.serverInfo.name, "git-delivery-mcp-server");
      assert.equal(response.result.protocolVersion, "2024-11-05");
      assert.deepEqual(response.result.capabilities, { tools: {} });
    });

    it("responds to ping", async () => {
      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#1_test",
        DEV_BRANCH: "develop",
        WORKSPACE: "/tmp/nonexistent",
        TASK_ID: "1",
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "ping",
        params: {},
      });

      assert.equal(response.id, 2);
      assert.deepEqual(response.result, {});
    });

    it("lists exactly three tools", async () => {
      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#1_test",
        DEV_BRANCH: "develop",
        WORKSPACE: "/tmp/nonexistent",
        TASK_ID: "1",
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      });

      assert.equal(response.result.tools.length, 3);
      const names = response.result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["finalize_branch_sync", "submit_task_changes", "sync_task_branch"]);
    });

    it("returns method-not-found for unknown methods", async () => {
      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#1_test",
        DEV_BRANCH: "develop",
        WORKSPACE: "/tmp/nonexistent",
        TASK_ID: "1",
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 4,
        method: "unknown/method",
        params: {},
      });

      assert.equal(response.error.code, -32601);
    });
  });

  describe("sync_task_branch", () => {
    let workspace;
    let server;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });

    afterEach(() => {
      if (server) server.kill();
      if (workspace) workspace.cleanup();
    });

    it("creates branch from DEV_BRANCH when it does not exist remotely", async () => {
      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#99_new-feature",
        DEV_BRANCH: "develop",
        WORKSPACE: workspace.workspaceDir,
        TASK_ID: "99",
        REPO_URL: workspace.remoteDir,
      });

      // Initialize first
      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sync_task_branch", arguments: {} },
      });

      assert.equal(response.result.isError, undefined);
      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.success, true);
      assert.equal(result.branchName, "feature/#99_new-feature");
      assert.equal(result.hadConflicts, false);

      // Verify the branch was created locally
      const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: workspace.workspaceDir,
        encoding: "utf-8",
      }).trim();
      assert.equal(currentBranch, "feature/#99_new-feature");
    });

    it("fetches and merges DEV_BRANCH when branch already exists remotely", async () => {
      // Create the task branch on remote first
      execSync("git checkout -b feature/#42_existing", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "task-file.txt"), "task work\n");
      execSync("git add -A && git commit -m 'task work'", { cwd: workspace.workspaceDir });
      execSync("git push origin feature/#42_existing", { cwd: workspace.workspaceDir });

      // Go back to develop and add a new commit (simulates new work on develop)
      execSync("git checkout develop", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "new-develop-file.txt"), "develop work\n");
      execSync("git add -A && git commit -m 'develop work'", { cwd: workspace.workspaceDir });
      execSync("git push origin develop", { cwd: workspace.workspaceDir });

      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#42_existing",
        DEV_BRANCH: "develop",
        WORKSPACE: workspace.workspaceDir,
        TASK_ID: "42",
        REPO_URL: workspace.remoteDir,
      });

      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sync_task_branch", arguments: {} },
      });

      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.success, true);
      assert.equal(result.branchName, "feature/#42_existing");
      assert.equal(result.hadConflicts, false);

      // Verify both files exist (task work + develop merge)
      const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: workspace.workspaceDir,
        encoding: "utf-8",
      }).trim();
      assert.equal(currentBranch, "feature/#42_existing");

      const files = execSync("ls", { cwd: workspace.workspaceDir, encoding: "utf-8" });
      assert.ok(files.includes("task-file.txt"));
      assert.ok(files.includes("new-develop-file.txt"));
    });

    it("reports conflicts without aborting the merge", async () => {
      // Create the task branch with a conflicting change
      execSync("git checkout -b feature/#50_conflict", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Task version\n");
      execSync("git add -A && git commit -m 'task change'", { cwd: workspace.workspaceDir });
      execSync("git push origin feature/#50_conflict", { cwd: workspace.workspaceDir });

      // Go back to develop and make a conflicting change
      execSync("git checkout develop", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Develop version\n");
      execSync("git add -A && git commit -m 'develop conflict'", { cwd: workspace.workspaceDir });
      execSync("git push origin develop", { cwd: workspace.workspaceDir });

      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#50_conflict",
        DEV_BRANCH: "develop",
        WORKSPACE: workspace.workspaceDir,
        TASK_ID: "50",
        REPO_URL: workspace.remoteDir,
      });

      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sync_task_branch", arguments: {} },
      });

      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.success, true);
      assert.equal(result.hadConflicts, true);
      assert.ok(Array.isArray(result.conflictedFiles));
      assert.ok(result.conflictedFiles.includes("README.md"));
    });
  });

  describe("finalize_branch_sync", () => {
    let workspace;
    let server;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });

    afterEach(() => {
      if (server) server.kill();
      if (workspace) workspace.cleanup();
    });

    it("completes a merge after conflicts are resolved", async () => {
      // Set up a conflicting merge state
      execSync("git checkout -b feature/#60_resolve", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Task version\n");
      execSync("git add -A && git commit -m 'task change'", { cwd: workspace.workspaceDir });
      execSync("git push origin feature/#60_resolve", { cwd: workspace.workspaceDir });

      execSync("git checkout develop", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Develop version\n");
      execSync("git add -A && git commit -m 'develop conflict'", { cwd: workspace.workspaceDir });
      execSync("git push origin develop", { cwd: workspace.workspaceDir });

      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#60_resolve",
        DEV_BRANCH: "develop",
        WORKSPACE: workspace.workspaceDir,
        TASK_ID: "60",
        REPO_URL: workspace.remoteDir,
      });

      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      // First, trigger the merge conflict via sync_task_branch
      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sync_task_branch", arguments: {} },
      });

      // Simulate agent resolving the conflict
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Resolved version\n");

      // Now finalize the merge
      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "finalize_branch_sync", arguments: {} },
      });

      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.success, true);

      // Verify there's no merge in progress
      const status = execSync("git status --porcelain", {
        cwd: workspace.workspaceDir,
        encoding: "utf-8",
      }).trim();
      assert.equal(status, "");
    });

    it("fails if conflict markers still present", async () => {
      // Set up a conflict
      execSync("git checkout -b feature/#61_unresolved", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Task version\n");
      execSync("git add -A && git commit -m 'task change'", { cwd: workspace.workspaceDir });
      execSync("git push origin feature/#61_unresolved", { cwd: workspace.workspaceDir });

      execSync("git checkout develop", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Develop version\n");
      execSync("git add -A && git commit -m 'develop conflict'", { cwd: workspace.workspaceDir });
      execSync("git push origin develop", { cwd: workspace.workspaceDir });

      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#61_unresolved",
        DEV_BRANCH: "develop",
        WORKSPACE: workspace.workspaceDir,
        TASK_ID: "61",
        REPO_URL: workspace.remoteDir,
      });

      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      // Trigger the merge conflict
      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sync_task_branch", arguments: {} },
      });

      // DON'T resolve the conflict — call finalize directly
      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "finalize_branch_sync", arguments: {} },
      });

      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.success, false);
      assert.ok(result.error.includes("conflict markers"));
    });

    it("does not false-positive on conflict markers in node_modules or .git", async () => {
      // Set up a conflict, then resolve it, but put conflict markers in node_modules
      execSync("git checkout -b feature/#62_false-positive", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Task version\n");
      execSync("git add -A && git commit -m 'task change'", { cwd: workspace.workspaceDir });
      execSync("git push origin feature/#62_false-positive", { cwd: workspace.workspaceDir });

      execSync("git checkout develop", { cwd: workspace.workspaceDir });
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Develop version\n");
      execSync("git add -A && git commit -m 'develop conflict'", { cwd: workspace.workspaceDir });
      execSync("git push origin develop", { cwd: workspace.workspaceDir });

      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#62_false-positive",
        DEV_BRANCH: "develop",
        WORKSPACE: workspace.workspaceDir,
        TASK_ID: "62",
        REPO_URL: workspace.remoteDir,
      });

      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      // Trigger the merge conflict
      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sync_task_branch", arguments: {} },
      });

      // Resolve the actual conflict in README.md
      writeFileSync(join(workspace.workspaceDir, "README.md"), "# Resolved version\n");

      // Put conflict markers in node_modules (should be ignored)
      mkdirSync(join(workspace.workspaceDir, "node_modules", "some-pkg"), { recursive: true });
      writeFileSync(
        join(workspace.workspaceDir, "node_modules", "some-pkg", "test-fixture.txt"),
        "<<<<<<< HEAD\nsome content\n=======\nother content\n>>>>>>> branch\n"
      );

      // finalize_branch_sync should succeed — node_modules markers are irrelevant
      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "finalize_branch_sync", arguments: {} },
      });

      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.success, true, `Expected success but got: ${JSON.stringify(result)}`);
    });
  });

  describe("submit_task_changes", () => {
    let workspace;
    let server;

    beforeEach(() => {
      workspace = createTestWorkspace();
      // Start on the task branch
      execSync("git checkout -b feature/#70_submit-test", { cwd: workspace.workspaceDir });
    });

    afterEach(() => {
      if (server) server.kill();
      if (workspace) workspace.cleanup();
    });

    it("returns no-changes result when nothing is modified", async () => {
      const deliveryPath = join(workspace.base, "delivery-result.json");

      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#70_submit-test",
        DEV_BRANCH: "develop",
        WORKSPACE: workspace.workspaceDir,
        TASK_ID: "70",
        REPO_URL: workspace.remoteDir,
        DELIVERY_RESULT_PATH: deliveryPath,
        GIT_PROVIDER: "github",
      });

      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "submit_task_changes", arguments: { title: "Test commit" } },
      });

      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.committed, false);
      assert.equal(result.pushed, false);
      // Not an error — this is a valid state
      assert.equal(response.result.isError, undefined);
    });

    it("commits and pushes changes to the current branch", async () => {
      const deliveryPath = join(workspace.base, "delivery-result.json");

      // Make a change
      writeFileSync(join(workspace.workspaceDir, "new-file.txt"), "hello world\n");

      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#70_submit-test",
        DEV_BRANCH: "develop",
        WORKSPACE: workspace.workspaceDir,
        TASK_ID: "70",
        REPO_URL: workspace.remoteDir,
        DELIVERY_RESULT_PATH: deliveryPath,
        GIT_PROVIDER: "github",
      });

      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "submit_task_changes", arguments: { title: "Add new file" } },
      });

      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.committed, true);
      assert.equal(result.pushed, true);
      assert.equal(result.branchName, "feature/#70_submit-test");

      // Verify the commit message format
      const log = execSync("git log -1 --format=%s", {
        cwd: workspace.workspaceDir,
        encoding: "utf-8",
      }).trim();
      assert.ok(log.includes("Add new file"));
      assert.ok(log.includes("[Vibecode Heaven #70]"));

      // Verify DELIVERY_RESULT_PATH was written
      const deliveryResult = JSON.parse(readFileSync(deliveryPath, "utf-8"));
      assert.equal(deliveryResult.committed, true);
      assert.equal(deliveryResult.pushed, true);
    });

    it("requires title parameter", async () => {
      server = spawnServer({
        TASK_BRANCH_NAME: "feature/#70_submit-test",
        DEV_BRANCH: "develop",
        WORKSPACE: workspace.workspaceDir,
        TASK_ID: "70",
        REPO_URL: workspace.remoteDir,
        DELIVERY_RESULT_PATH: join(workspace.base, "delivery-result.json"),
      });

      await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "submit_task_changes", arguments: {} },
      });

      assert.equal(response.result.isError, true);
      assert.ok(response.result.content[0].text.includes("title"));
    });
  });
});
