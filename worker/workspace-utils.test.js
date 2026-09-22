/**
 * Tests for workspace-utils.js — verifies the clone-retry workspace cleanup
 * preserves the workspace directory itself (only clears its contents).
 *
 * Run with: node --test worker/workspace-utils.test.js
 *
 * Regression context (task #1985): the worker image now runs as the
 * unprivileged `node` user (UID 1000). The clone-retry loop used to run
 * `rm -rf /workspace` between branch attempts, which deletes the /workspace
 * directory itself. Recreating a direct child of root-owned `/` fails with
 * EACCES for a non-root user, so the next `git clone .../workspace` attempt
 * died with a confusing permission error instead of "branch not found".
 * clearWorkspaceContents() must empty the directory WITHOUT removing it.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearWorkspaceContents } from "./workspace-utils.js";

describe("clearWorkspaceContents", () => {
  let dir;

  beforeEach(() => {
    dir = join(tmpdir(), `ws-utils-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes all contents but preserves the directory itself", () => {
    // Regular file, nested dir with a file, and a dotfile
    writeFileSync(join(dir, "file.txt"), "hello");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.txt"), "nested");
    writeFileSync(join(dir, ".gitconfig"), "dotfile");

    clearWorkspaceContents(dir);

    assert.equal(existsSync(dir), true, "workspace directory must still exist");
    assert.equal(statSync(dir).isDirectory(), true, "workspace must still be a directory");
    assert.deepEqual(readdirSync(dir), [], "workspace must be empty (including dotfiles)");
  });

  it("is a no-op when the directory is already empty", () => {
    clearWorkspaceContents(dir);
    assert.equal(existsSync(dir), true);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("does not throw when the directory does not exist", () => {
    const missing = join(dir, "does-not-exist");
    rmSync(dir, { recursive: true, force: true });
    assert.doesNotThrow(() => clearWorkspaceContents(missing));
  });
});
