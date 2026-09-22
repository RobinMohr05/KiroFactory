#!/usr/bin/env node
/**
 * Tests for parseGitHubRepo() in the git-delivery and pr-review MCP servers.
 *
 * Uses Node's built-in test runner (node:test) — no external dependencies.
 * Run: node --test worker/parse-github-repo.test.js
 *
 * Regression context (task #1991): parseGitHubRepo used the regex
 * /github\.com[/:]([^/]+)\/([^/.]+)/, whose repo capture group [^/.]+ stops
 * at the first dot. A repository whose name legitimately contains a dot
 * (e.g. "org/my.repo" or "org/docs.site") was parsed as repo="my"/"docs",
 * producing wrong API URLs (404s). The fix must keep dotted names intact
 * while still stripping only a trailing ".git" suffix.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseGitHubRepo as parseGitDelivery } from "./git-delivery-mcp-server.js";
import { parseGitHubRepo as parsePrReview } from "./pr-review-mcp-server.js";

for (const [name, parseGitHubRepo] of [
  ["git-delivery-mcp-server", parseGitDelivery],
  ["pr-review-mcp-server", parsePrReview],
]) {
  describe(`parseGitHubRepo (${name})`, () => {
    it("parses a plain owner/repo HTTPS URL", () => {
      assert.deepEqual(parseGitHubRepo("https://github.com/org/repo"), {
        owner: "org",
        repo: "repo",
      });
    });

    it("keeps a dot in the repo name intact (HTTPS)", () => {
      assert.deepEqual(parseGitHubRepo("https://github.com/org/my.repo"), {
        owner: "org",
        repo: "my.repo",
      });
    });

    it("keeps a dot in the repo name intact (docs.site)", () => {
      assert.deepEqual(parseGitHubRepo("https://github.com/org/docs.site"), {
        owner: "org",
        repo: "docs.site",
      });
    });

    it("strips a trailing .git suffix", () => {
      assert.deepEqual(parseGitHubRepo("https://github.com/org/repo.git"), {
        owner: "org",
        repo: "repo",
      });
    });

    it("strips only the trailing .git on a dotted repo name", () => {
      assert.deepEqual(parseGitHubRepo("https://github.com/org/my.repo.git"), {
        owner: "org",
        repo: "my.repo",
      });
    });

    it("parses the SCP-style git@ URL and strips .git", () => {
      assert.deepEqual(parseGitHubRepo("git@github.com:org/my.repo.git"), {
        owner: "org",
        repo: "my.repo",
      });
    });

    it("strips a trailing ?query from the repo name", () => {
      assert.deepEqual(parseGitHubRepo("https://github.com/org/repo?tab=readme"), {
        owner: "org",
        repo: "repo",
      });
    });

    it("strips a trailing #fragment from the repo name", () => {
      assert.deepEqual(parseGitHubRepo("https://github.com/org/repo#anchor"), {
        owner: "org",
        repo: "repo",
      });
    });

    it("returns null for a non-GitHub URL", () => {
      assert.equal(parseGitHubRepo("https://example.com/org/repo"), null);
    });
  });
}
