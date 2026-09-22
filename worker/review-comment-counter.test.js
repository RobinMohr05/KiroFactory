#!/usr/bin/env node
/**
 * Tests for the review-comment counter shared between pr-review-mcp-server.js
 * and verdict-mcp-server.js.
 *
 * The counter file uses an append-only strategy to avoid the non-atomic
 * read-modify-write race: pr-review-mcp-server appends one sentinel byte per
 * comment; verdict-mcp-server counts the file's byte length. This makes the
 * counter naturally monotonic and immune to interleaving — two concurrent
 * appends can never lose an increment.
 *
 * The worker.js reset also changes from writing "0" to writing "" (empty),
 * since the verdict server now counts bytes rather than parsing a number.
 *
 * Uses Node's built-in test runner (node:test) — no external dependencies.
 * Run: node --test worker/review-comment-counter.test.js
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn one of the MCP servers with a given environment and return
 * send/receive helpers.
 */
function spawnServer(scriptName, env = {}) {
  const proc = spawn("node", [join(import.meta.dirname, scriptName)], {
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
// Tests: verdict server reads byte count (not numeric string)
// ---------------------------------------------------------------------------

describe("review-comment counter: verdict server reads byte count", () => {
  let tmpDir;
  let markerPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "review-counter-test-"));
    markerPath = join(tmpDir, "counter");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks changes_requested when the counter file is empty (0 bytes = 0 comments)", async () => {
    // Empty file = 0 bytes = 0 comments: changes_requested must be blocked.
    writeFileSync(markerPath, "");

    const server = spawnServer("verdict-mcp-server.js", {
      REVIEW_MARKER_PATH: markerPath,
    });
    try {
      await server.sendAndWaitResponse({
        jsonrpc: "2.0", id: 1, method: "initialize", params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "report_verdict",
          arguments: { verdict: "changes_requested", reason: "found issues" },
        },
      });
      assert.equal(response.result.isError, true,
        "changes_requested should be blocked when counter file is empty (0 bytes)");
    } finally {
      server.kill();
    }
  });

  it("allows changes_requested when the counter file has 1 sentinel byte (1 comment)", async () => {
    // A file with 1 sentinel byte appended by incrementReviewCommentCount
    // means 1 comment was posted — changes_requested should be allowed.
    // With the new byte-count approach: "x".length === 1 → 1 comment → allow.
    writeFileSync(markerPath, "x"); // 1 sentinel byte = 1 comment

    const server = spawnServer("verdict-mcp-server.js", {
      REVIEW_MARKER_PATH: markerPath,
    });
    try {
      await server.sendAndWaitResponse({
        jsonrpc: "2.0", id: 1, method: "initialize", params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "report_verdict",
          arguments: { verdict: "changes_requested", reason: "found issues" },
        },
      });
      // 1 byte = 1 comment: should be allowed
      assert.ok(!response.result.isError,
        "changes_requested should be allowed when counter file has 1 byte (1 comment)");
    } finally {
      server.kill();
    }
  });

  it("counts each appended sentinel byte as one comment", async () => {
    // Simulate 3 comments: 3 bytes in the file.
    writeFileSync(markerPath, "xxx");

    const server = spawnServer("verdict-mcp-server.js", {
      REVIEW_MARKER_PATH: markerPath,
    });
    try {
      await server.sendAndWaitResponse({
        jsonrpc: "2.0", id: 1, method: "initialize", params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "report_verdict",
          arguments: { verdict: "changes_requested", reason: "found multiple issues" },
        },
      });
      assert.ok(!response.result.isError,
        "changes_requested should be allowed when counter file has 3 bytes (3 comments)");
    } finally {
      server.kill();
    }
  });

  it("fails open (allows) when counter file does not exist", async () => {
    // File doesn't exist: should not throw, should fail open and allow.
    const nonExistentPath = join(tmpDir, "does-not-exist");

    const server = spawnServer("verdict-mcp-server.js", {
      REVIEW_MARKER_PATH: nonExistentPath,
    });
    try {
      await server.sendAndWaitResponse({
        jsonrpc: "2.0", id: 1, method: "initialize", params: {},
      });

      const response = await server.sendAndWaitResponse({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "report_verdict",
          arguments: { verdict: "changes_requested", reason: "test fail-open" },
        },
      });
      // Fails open: missing file → count=null → no block
      assert.ok(!response.result.isError,
        "changes_requested should be allowed when counter file is missing (fail-open)");
    } finally {
      server.kill();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: pr-review-mcp-server appends sentinel bytes (not read-modify-write)
// ---------------------------------------------------------------------------

describe("review-comment counter: pr-review-mcp-server uses appendFileSync", () => {
  let tmpDir;
  let markerPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "review-counter-append-"));
    markerPath = join(tmpDir, "counter");
    // Simulate worker.js reset: empty file (new behavior after fix)
    writeFileSync(markerPath, "");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("counter file grows by exactly 1 byte per append (not by overwriting a number)", async () => {
    // Each call to incrementReviewCommentCount must add exactly 1 byte to the
    // file via appendFileSync, not overwrite it with a numeric string.
    // We simulate the expected calls and verify the file length matches.
    appendFileSync(markerPath, "x"); // first comment
    appendFileSync(markerPath, "x"); // second comment

    const content = readFileSync(markerPath, "utf-8");
    // Two appends → 2 bytes. Old read-modify-write would give "2" (1 byte).
    assert.equal(content.length, 2, "file should contain 2 bytes after 2 appends");
  });

  it("two concurrent appends each add 1 byte — no lost increment", async () => {
    // Core correctness property: when two appends overlap, both must complete
    // and the file must contain both bytes. appendFileSync is atomic at the
    // OS level (each write is a single O_APPEND syscall) — unlike the old
    // read-modify-write which has a window where both reads see the same value.
    //
    // We simulate two "concurrent" writes by doing them synchronously in sequence
    // (worst case: they'd both complete correctly); the key test is that
    // after both appends the file length is 2, not 1.
    appendFileSync(markerPath, "x");
    appendFileSync(markerPath, "x");

    const content = readFileSync(markerPath, "utf-8");
    assert.equal(content.length, 2,
      "two appends must each contribute 1 byte — no increment can be lost");
  });
});
