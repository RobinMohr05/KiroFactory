/**
 * Tests for spawn-env.js — verifies the kiro-cli child process env allowlist.
 *
 * Run with: node --test worker/spawn-env.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnEnv } from "./spawn-env.js";

describe("buildSpawnEnv", () => {
  const FAKE_SOURCE_ENV = {
    // Standard OS vars that SHOULD be forwarded
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/agent",
    USER: "agent",
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    NODE_ENV: "production",
    TMPDIR: "/tmp",
    HOSTNAME: "worker-container-abc123",
    // Secrets that MUST NOT be forwarded
    GITHUB_PAT: "ghp_secrettoken123456",
    AZURE_DEVOPS_PAT: "ado_secrettoken789",
    WORKER_SECRET: "shared-worker-secret-xyz",
    KIRO_API_KEY: "kiro-key-from-env",
    // Worker-internal vars that MUST NOT be forwarded
    SESSION_ID: "42",
    ORCHESTRATOR_URL: "wss://kirofactory-api.example.com/internal/worker",
    AGENT_CONFIG_JSON_B64: "eyJuYW1lIjoiZGV2In0=",
    REPO_URL: "https://github.com/example/repo.git",
    MCP_SIDECAR_SERVER_NAMES: "pr-review,verdict",
    TASK_PR_URL: "https://github.com/example/repo/pull/42",
    PR_BRANCH: "feature/#42_some-task",
    AUTO_MERGE_ENABLED: "true",
    ALL_GROUP_TASKS_DONE: "false",
    TASK_ID: "594",
    AGENT_NAME: "developer-agent",
    AGENT_KIND: "editor",
    DEV_BRANCH: "develop",
    GIT_USER_NAME: "Agent Bot",
    GIT_USER_EMAIL: "agent@example.com",
    GIT_PROVIDER: "github",
    PROMPT_TEXT: "Implement X",
    TIMEOUT_SECONDS: "900",
    PERSISTENT_BRANCH_NAME: "",
  };

  it("does NOT forward GITHUB_PAT", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.GITHUB_PAT, undefined);
  });

  it("does NOT forward AZURE_DEVOPS_PAT", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.AZURE_DEVOPS_PAT, undefined);
  });

  it("does NOT forward WORKER_SECRET", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.WORKER_SECRET, undefined);
  });

  it("does NOT forward SESSION_ID", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.SESSION_ID, undefined);
  });

  it("does NOT forward ORCHESTRATOR_URL", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.ORCHESTRATOR_URL, undefined);
  });

  it("does NOT forward TASK_PR_URL", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.TASK_PR_URL, undefined);
  });

  it("does NOT forward PR_BRANCH", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.PR_BRANCH, undefined);
  });

  it("does NOT forward AUTO_MERGE_ENABLED", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.AUTO_MERGE_ENABLED, undefined);
  });

  it("does NOT forward ALL_GROUP_TASKS_DONE", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.ALL_GROUP_TASKS_DONE, undefined);
  });

  it("does NOT forward AGENT_CONFIG_JSON_B64", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.AGENT_CONFIG_JSON_B64, undefined);
  });

  it("does NOT forward REPO_URL", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.REPO_URL, undefined);
  });

  it("does NOT forward MCP_SIDECAR_SERVER_NAMES", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "explicit-key");
    assert.equal(env.MCP_SIDECAR_SERVER_NAMES, undefined);
  });

  it("does NOT forward KIRO_API_KEY from sourceEnv (only via explicit param)", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, null);
    // KIRO_API_KEY from the source env should NOT be forwarded via the allowlist
    assert.equal(env.KIRO_API_KEY, undefined);
  });

  it("forwards KIRO_API_KEY when provided explicitly", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "my-explicit-key");
    assert.equal(env.KIRO_API_KEY, "my-explicit-key");
  });

  it("forwards PATH", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.PATH, FAKE_SOURCE_ENV.PATH);
  });

  it("forwards HOME", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.HOME, FAKE_SOURCE_ENV.HOME);
  });

  it("forwards USER", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.USER, FAKE_SOURCE_ENV.USER);
  });

  it("forwards SHELL", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.SHELL, FAKE_SOURCE_ENV.SHELL);
  });

  it("forwards TERM", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.TERM, FAKE_SOURCE_ENV.TERM);
  });

  it("forwards LANG", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.LANG, FAKE_SOURCE_ENV.LANG);
  });

  it("forwards NODE_ENV", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.NODE_ENV, FAKE_SOURCE_ENV.NODE_ENV);
  });

  it("forwards TMPDIR", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.TMPDIR, FAKE_SOURCE_ENV.TMPDIR);
  });

  it("forwards HOSTNAME", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.HOSTNAME, FAKE_SOURCE_ENV.HOSTNAME);
  });

  it("always sets NO_COLOR=1", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.NO_COLOR, "1");
  });

  it("always sets FORCE_COLOR=0", () => {
    const env = buildSpawnEnv(FAKE_SOURCE_ENV, "key");
    assert.equal(env.FORCE_COLOR, "0");
  });

  it("omits keys not in allowlist", () => {
    const source = { ...FAKE_SOURCE_ENV, RANDOM_CUSTOM_VAR: "should-not-appear" };
    const env = buildSpawnEnv(source, "key");
    assert.equal(env.RANDOM_CUSTOM_VAR, undefined);
  });

  it("handles empty source env gracefully", () => {
    const env = buildSpawnEnv({}, "key");
    assert.equal(env.KIRO_API_KEY, "key");
    assert.equal(env.NO_COLOR, "1");
    assert.equal(env.FORCE_COLOR, "0");
    assert.equal(env.PATH, undefined);
  });
});
