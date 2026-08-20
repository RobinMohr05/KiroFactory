/**
 * Builds a safe environment object for the kiro-cli child process.
 *
 * Instead of spreading `process.env` (which leaks secrets like GITHUB_PAT,
 * AZURE_DEVOPS_PAT, WORKER_SECRET), this uses an explicit allowlist of keys
 * that the agent's shell tools legitimately need (PATH, HOME, NODE_ENV, etc.).
 *
 * Mirrors the approach used by backend/src/agent/kiro-runner.ts for local mode.
 */

/**
 * Keys that are always forwarded if present in the source environment.
 * These are standard OS/shell variables needed by build tools, package managers,
 * and git read-only commands.
 */
const FORWARD_KEYS = [
  // Core OS / shell
  "PATH",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "USER",
  "USERNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // Node / build tools
  "NODE_ENV",
  "NODE_PATH",
  "NODE_OPTIONS",
  "NPM_CONFIG_REGISTRY",
  // Temp directories (needed by npm, build tools)
  "TMPDIR",
  "TEMP",
  "TMP",
  // System (Linux container basics)
  "HOSTNAME",
  // SSH (for git operations via ssh, though workers use HTTPS)
  "SSH_AUTH_SOCK",
  // Windows-specific (for cross-platform compat, matching kiro-runner.ts)
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "SystemRoot",
];

/**
 * Env var prefixes that are forwarded in their entirety (all keys starting
 * with these prefixes). Currently empty — AWS_* is NOT forwarded because the
 * worker container doesn't use AWS credentials for agent shell commands, and
 * forwarding them would be unnecessary exposure. If AWS tooling becomes needed
 * in agent shells, add "AWS_" here.
 */
const FORWARD_PREFIXES = [];

/**
 * Keys that are NEVER forwarded, regardless of other rules. This is a safety
 * net — even if a future change accidentally adds a prefix that covers these,
 * they'll be excluded.
 */
const BLOCKED_KEYS = [
  "GITHUB_PAT",
  "AZURE_DEVOPS_PAT",
  "WORKER_SECRET",
  "KIRO_API_KEY", // Forwarded explicitly below, not via the allowlist
  "SESSION_ID",
  "ORCHESTRATOR_URL",
  "AGENT_CONFIG_JSON_B64",
  "REPO_URL",
  "MCP_SIDECAR_SERVER_NAMES",
  "TASK_PR_URL",
  "PR_BRANCH",
  "AUTO_MERGE_ENABLED",
  "ALL_GROUP_TASKS_DONE",
  "TASK_ID",
  "AGENT_NAME",
  "AGENT_KIND",
  "DEV_BRANCH",
  "GIT_USER_NAME",
  "GIT_USER_EMAIL",
  "GIT_PROVIDER",
  "PROMPT_TEXT",
  "TIMEOUT_SECONDS",
  "PERSISTENT_BRANCH_NAME",
];

/**
 * Build a safe env object for spawning kiro-cli.
 *
 * @param {Record<string, string|undefined>} sourceEnv - The source environment (typically process.env)
 * @param {string} [kiroApiKey] - The Kiro API key to inject
 * @returns {Record<string, string>} Safe environment for the child process
 */
export function buildSpawnEnv(sourceEnv, kiroApiKey) {
  const env = {};

  // Forward allowlisted keys
  for (const key of FORWARD_KEYS) {
    if (sourceEnv[key]) {
      env[key] = sourceEnv[key];
    }
  }

  // Forward allowlisted prefixes
  for (const prefix of FORWARD_PREFIXES) {
    for (const key of Object.keys(sourceEnv)) {
      if (key.startsWith(prefix) && !BLOCKED_KEYS.includes(key) && sourceEnv[key]) {
        env[key] = sourceEnv[key];
      }
    }
  }

  // Always set these for kiro-cli
  if (kiroApiKey) {
    env.KIRO_API_KEY = kiroApiKey;
  }
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";

  return env;
}
