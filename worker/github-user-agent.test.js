#!/usr/bin/env node
/**
 * Tests that every worker-side GitHub API caller sets an explicit
 * `User-Agent` request header.
 *
 * GitHub's REST and GraphQL APIs officially require a `User-Agent` and
 * document that requests without one are rejected with 403. Node's global
 * fetch (undici) sends a default `User-Agent: node`, which GitHub currently
 * tolerates, so this doesn't hard-fail today — but relying on an undocumented
 * default UA is fragile. These tests pin the documented-correct behaviour:
 * every place that builds GitHub request headers must include an explicit,
 * descriptive User-Agent.
 *
 * The header builders (`githubHeaders()`) and the inline header objects in
 * worker.js are module-private in stdio MCP servers whose API base URL is
 * hardcoded to https://api.github.com, so they can't be exercised behaviourally
 * without out-of-scope refactoring. Instead we assert on the source of each
 * verified location directly.
 *
 * Uses Node's built-in test runner (node:test) — no external dependencies.
 * Run: node --test worker/github-user-agent.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workerDir = import.meta.dirname;

/** Read a worker source file as UTF-8 text. */
function readSource(name) {
  return readFileSync(join(workerDir, name), "utf-8");
}

/**
 * Extract every `githubHeaders() { return { ... }; }` body from a source file.
 * Returns an array of the object-literal bodies (as strings).
 */
function githubHeadersBodies(source) {
  const bodies = [];
  const re = /function\s+githubHeaders\s*\(\s*\)\s*\{\s*return\s*\{([\s\S]*?)\};?\s*\}/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    bodies.push(m[1]);
  }
  return bodies;
}

/** True if a header object-literal body declares a User-Agent header. */
function hasUserAgent(headerBody) {
  return /["']?User-Agent["']?\s*:/.test(headerBody);
}

describe("GitHub API callers set an explicit User-Agent", () => {
  for (const file of [
    "git-delivery-mcp-server.js",
    "pr-review-mcp-server.js",
    "pr-complete-mcp-server.js",
  ]) {
    it(`${file}: githubHeaders() includes a User-Agent`, () => {
      const source = readSource(file);
      const bodies = githubHeadersBodies(source);
      assert.ok(bodies.length > 0, `expected a githubHeaders() function in ${file}`);
      for (const body of bodies) {
        assert.ok(
          hasUserAgent(body),
          `githubHeaders() in ${file} must set a User-Agent header`
        );
      }
    });
  }

  it("pr-review-mcp-server.js: the inline GraphQL fetch sets a User-Agent", () => {
    const source = readSource("pr-review-mcp-server.js");

    // The GraphQL helper uses its own inline header object rather than
    // githubHeaders(); it still targets api.github.com and must set a UA.
    const re = /fetch\(\s*["']https:\/\/api\.github\.com\/graphql["'][\s\S]*?headers:\s*\{((?:[^{}]|\$\{[^}]*\})*)\}/g;
    let m;
    let blocks = 0;
    while ((m = re.exec(source)) !== null) {
      blocks++;
      assert.ok(
        hasUserAgent(m[1]),
        "the inline GraphQL fetch headers in pr-review-mcp-server.js must set a User-Agent header"
      );
    }
    assert.ok(blocks > 0, "expected an inline GraphQL fetch in pr-review-mcp-server.js");
  });

  it("worker.js: every inline GitHub api.github.com fetch sets a User-Agent", () => {
    const source = readSource("worker.js");

    // Find each `headers: { ... }` object literal. The non-greedy body match
    // allows `${...}` template-literal interpolations (e.g. `${GITHUB_PAT}`)
    // whose embedded `}` would otherwise terminate the match prematurely.
    // GitHub request header objects are identified by the API-version header.
    const re = /headers:\s*\{((?:[^{}]|\$\{[^}]*\})*)\}/g;
    let m;
    let githubHeaderBlocks = 0;
    while ((m = re.exec(source)) !== null) {
      const body = m[1];
      if (/X-GitHub-Api-Version/.test(body)) {
        githubHeaderBlocks++;
        assert.ok(
          hasUserAgent(body),
          "inline GitHub fetch headers in worker.js must set a User-Agent header"
        );
      }
    }

    assert.ok(
      githubHeaderBlocks >= 2,
      `expected at least 2 inline GitHub header blocks in worker.js, found ${githubHeaderBlocks}`
    );
  });
});
