#!/usr/bin/env node
/**
 * Tests that worker.js's inline GitHub owner/repo parsing (in
 * createGitHubPullRequest) does not truncate repo names that contain a dot.
 *
 * Regression context (task #1991): the repo capture group `[^/.]+` stops at
 * the first dot, so a repo like `org/my.repo` was parsed as repo="my",
 * producing `https://api.github.com/repos/org/my/pulls` and a 404 on PR
 * creation. The two MCP servers (git-delivery / pr-review) were fixed to use
 * `([^/]+)` + `.replace(/\.git$/, "")`, but the same buggy regex remained in
 * worker.js's live PR-creation path.
 *
 * worker.js runs top-level side effects on import (connects to the
 * orchestrator, spawns kiro-cli), so createGitHubPullRequest can't be imported
 * and exercised behaviourally without out-of-scope refactoring. Following the
 * same convention as github-user-agent.test.js, we assert on the source text
 * of the relevant regex directly, and also verify the extracted regex behaves
 * correctly on a dotted repo name.
 *
 * Uses Node's built-in test runner (node:test) — no external dependencies.
 * Run: node --test worker/worker-parse-github-repo.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workerDir = import.meta.dirname;

function readSource(name) {
  return readFileSync(join(workerDir, name), "utf-8");
}

describe("worker.js GitHub owner/repo parsing keeps dotted repo names", () => {
  it("does not use the truncating [^/.]+ repo capture group", () => {
    const source = readSource("worker.js");
    assert.ok(
      !/github\\\.com\[\/:\]\(\[\^\/\]\+\)\\\/\(\[\^\/\.\]\+\)/.test(source) &&
        !source.includes("github\\.com[/:]([^/]+)\\/([^/.]+)"),
      "worker.js must not use the truncating [^/.]+ repo capture group"
    );
  });

  it("strips a trailing .git from the parsed repo name in createGitHubPullRequest", () => {
    const source = readSource("worker.js");
    // Scope to the parse portion of createGitHubPullRequest (from the function
    // header up to the buildPrContent() call) so a `.replace(/\.git$/, "")`
    // elsewhere in the file can't satisfy this assertion.
    const fn = source.match(
      /function createGitHubPullRequest\([\s\S]*?buildPrContent\(\)/
    );
    assert.ok(fn, "expected a createGitHubPullRequest function in worker.js");
    assert.ok(
      /\.replace\(\/\\\.git\$\/,\s*""\)/.test(fn[0]),
      'createGitHubPullRequest must strip a trailing ".git" from the parsed repo name'
    );
  });

  it("the repo-parsing regex in worker.js keeps a dot in the repo name intact", () => {
    const source = readSource("worker.js");
    // Extract the github.com owner/repo regex literal actually used in
    // worker.js. The literal runs from `/github` up to the closing `/` that
    // sits immediately before the `.match(...)` call's own `)`. Match lazily
    // up to `/)` so the capture-group parens inside the regex don't end it.
    const m = source.match(/REPO_URL\.match\((\/github\\\.com\[\/:\].*?\/)\)/);
    assert.ok(m, "expected a REPO_URL.match(/github.com.../) call in worker.js");
    // Rebuild a RegExp from the captured literal body (strip leading/trailing "/").
    const body = m[1].slice(1, -1);
    const re = new RegExp(body);
    const match = "https://github.com/org/my.repo".match(re);
    assert.ok(match, "regex should match a dotted repo URL");
    assert.equal(match[2], "my.repo", "repo capture group must keep the dot");
  });
});
