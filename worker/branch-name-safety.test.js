#!/usr/bin/env node
/**
 * Tests for branch-name shell-injection hardening (task #2011).
 *
 * Regression context: worker.js's commitAndPush() "no uncommitted changes"
 * path interpolated a task/DB-derived branch name straight into a shell
 * string:
 *
 *   exec(`git rev-list origin/${branchName}..HEAD 2>/dev/null || echo ""`)
 *
 * Git ref names legitimately allow characters that are dangerous in a shell
 * (`$`, backtick, `;`, `(`, `)`, `|`, `&`). A branch such as `foo`id`` or
 * `foo$(cmd)` would be re-parsed by the shell and execute arbitrary commands
 * inside the worker container. This contradicts the codebase's own
 * execFileArgs() convention (used at the checkout path) whose whole point is
 * that nothing task/branch-derived ever reaches a shell.
 *
 * Two defenses are asserted here:
 *  1. A pure, importable `isValidBranchName()` allowlist helper rejects any
 *     branch name containing shell metacharacters (defense-in-depth).
 *  2. worker.js no longer interpolates branchName into an exec() shell string
 *     for the rev-list "ahead" check — it uses execFileArgs() instead.
 *
 * Uses Node's built-in test runner (node:test) — no external dependencies.
 * Run: node --test worker/branch-name-safety.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidBranchName } from "./shared-branch-utils.js";

const workerDir = import.meta.dirname;

describe("isValidBranchName allowlist", () => {
  it("accepts normal task branch names", () => {
    assert.equal(isValidBranchName("bug/#2011_shell-injection"), true);
    assert.equal(isValidBranchName("feature/#42_add-widget"), true);
    assert.equal(isValidBranchName("vibecode-heaven/session-abc123"), true);
    assert.equal(isValidBranchName("develop"), true);
    assert.equal(isValidBranchName("release/1.2.3"), true);
  });

  it("rejects names containing shell metacharacters", () => {
    for (const bad of [
      "foo`id`",
      "foo$(whoami)",
      "foo;rm -rf /",
      "foo|cat /etc/passwd",
      "foo&background",
      "foo>out",
      "foo<in",
      "foo bar",          // space
      "foo'quote",
      "foo\"quote",
      "foo\\backslash",
    ]) {
      assert.equal(isValidBranchName(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it("rejects empty / non-string input", () => {
    assert.equal(isValidBranchName(""), false);
    assert.equal(isValidBranchName(null), false);
    assert.equal(isValidBranchName(undefined), false);
    assert.equal(isValidBranchName(123), false);
  });
});

describe("worker.js commitAndPush rev-list uses no shell interpolation", () => {
  const source = readFileSync(join(workerDir, "worker.js"), "utf-8");

  it("does not interpolate branchName into an exec() shell string for rev-list", () => {
    assert.ok(
      !source.includes("git rev-list origin/${branchName}"),
      "worker.js must not interpolate branchName into a shell rev-list command"
    );
  });

  it("runs the rev-list ahead-check via execFileArgs (argv, no shell)", () => {
    assert.match(
      source,
      /execFileArgs\(\s*"git"\s*,\s*\[\s*"rev-list"/,
      "worker.js must run rev-list via execFileArgs with an argv array"
    );
  });
});
