/**
 * WSL Worker Spawner — Spawns Kiro worker sessions as local Docker containers,
 * inside a dedicated WSL2 distro ("kirofactory-docker" by default), running
 * Docker Engine directly (not Docker Desktop).
 *
 * This is the local-mode sibling of aca-worker-spawner.ts: instead of
 * creating an Azure Container Apps Job execution, it runs
 * `docker run --rm -d <image>` inside the dedicated distro via `wsl.exe -d
 * <distro> -- docker ...`. The container is the exact same image
 * (worker/.devcontainer/Dockerfile) used for the ACA path, so worker.js
 * behaves identically in both environments — it only knows "connect back
 * over WebSocket," not which host started it.
 *
 * See ARCHITECTURE.md §12 for the full design and rationale (concurrency
 * model, why the distro is just a Docker host and not a shared sandbox,
 * why the git clone happens entirely inside the container).
 *
 * Each session gets its own MCP proxy sidecar container for full credential
 * isolation, joined to the worker container via a per-session Docker network
 * so they can reach each other over a stable hostname — the local analogue
 * of ACA's same-revision "shared localhost networking" (Docker containers on
 * different network namespaces cannot share localhost the way ACA sidecars
 * do, so a bridge network + hostname is used instead).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getUserKiroApiKey } from "./db/users.js";
import type { ProxyServersConfig } from "./mcp-proxy-config.js";
import { encodeServersConfigBase64, buildProxyCredentialEnvVars, type SessionCredentials } from "./mcp-proxy-config.js";

const execFileAsync = promisify(execFile);

/** MCP proxy sidecar configuration passed to startWorkerJob */
export interface McpProxySidecarConfig {
  /** The servers.json config to inject into the proxy container */
  serversConfig: ProxyServersConfig;
  /** Decrypted credentials to inject as env vars into the proxy container */
  credentials: SessionCredentials;
}

// ---------------------------------------------------------------------------
// Configuration (from environment variables)
// ---------------------------------------------------------------------------

export interface WslWorkerConfig {
  /** Name of the dedicated WSL distro running Docker Engine */
  distroName: string;
  /** Local worker image reference (built from worker/.devcontainer/Dockerfile) */
  workerImage: string;
  /** Local MCP proxy sidecar image reference */
  proxyImage: string;
  /**
   * Fixed TCP port the worker container listens on internally (WORKER_LISTEN_MODE).
   * Published to a random host port per container via `docker run -p 0:<listenPort>`;
   * the backend then dials `ws://localhost:<publishedPort>` to reach it. See the
   * module doc comment above for why the connection direction is reversed for WSL.
   */
  workerListenPort: number;
  /** Shared secret for worker ↔ orchestrator authentication */
  workerSecret: string;
  /** Git user name for commits inside the worker */
  gitUserName: string;
  /** Git user email for commits inside the worker */
  gitUserEmail: string;
  /** Azure DevOps Personal Access Token for git clone authentication (org-wide fallback) */
  azureDevOpsPat: string;
}

/**
 * Loads local WSL worker configuration from environment variables.
 * Returns null if WSL mode is not configured (missing required vars).
 *
 * Mirrors loadAcaConfig()'s shape — see aca-worker-spawner.ts.
 */
export function loadWslConfig(): WslWorkerConfig | null {
  const distroName = process.env.WSL_DISTRO_NAME || "kirofactory-docker";
  const workerImage = process.env.WSL_WORKER_IMAGE || "kirofactory-worker:local";
  const proxyImage = process.env.WSL_PROXY_IMAGE || "";
  const workerListenPort = Number(process.env.WSL_WORKER_LISTEN_PORT || "9091");
  const workerSecret = process.env.ACA_WORKER_SECRET || process.env.WSL_WORKER_SECRET;
  const gitUserName = process.env.GIT_USER_NAME || "KiroFactory Agent (local)";
  const gitUserEmail = process.env.GIT_USER_EMAIL || "agent@kirofactory.local";
  const azureDevOpsPat = process.env.AZURE_DEVOPS_EXT_PAT || "";

  // A worker secret is the only truly required piece — the rest have sane
  // local defaults. Without it the worker <-> orchestrator WebSocket
  // handshake (shared-secret auth) cannot succeed.
  if (!workerSecret) {
    return null;
  }

  return {
    distroName,
    workerImage,
    proxyImage,
    workerListenPort,
    workerSecret,
    gitUserName,
    gitUserEmail,
    azureDevOpsPat,
  };
}

/**
 * Check if WSL local worker mode is enabled (required env vars are set).
 */
export function isWslModeEnabled(): boolean {
  return loadWslConfig() !== null;
}

// ---------------------------------------------------------------------------
// wsl.exe / docker exec helper
// ---------------------------------------------------------------------------

/** Run a command inside the dedicated WSL distro via `wsl.exe -d <distro> -- <cmd>`. */
async function runInDistro(
  distroName: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("wsl.exe", ["-d", distroName, "--", ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Turn a failed `docker` invocation inside the distro into an actionable
 * error message. The most common failure is the distro or its Docker daemon
 * not being provisioned yet — see worker/.devcontainer/setup-wsl.ps1.
 */
function explainWslError(operation: string, config: WslWorkerConfig, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const distroRef = `WSL distro "${config.distroName}"`;

  if (/not recognized|not found|ENOENT/i.test(msg)) {
    return (
      `WSL ${operation} failed: 'wsl.exe' was not found on PATH. WSL2 must be installed on this ` +
      `machine. See worker/.devcontainer/README.md.`
    );
  }
  if (/There is no distribution|the distribution name is invalid/i.test(msg)) {
    return (
      `WSL ${operation} failed: ${distroRef} does not exist yet. Run ` +
      `worker/.devcontainer/setup-wsl.ps1 to provision it (creates the distro and installs ` +
      `Docker Engine). See ARCHITECTURE.md §12.`
    );
  }
  if (/Cannot connect to the Docker daemon/i.test(msg)) {
    return (
      `WSL ${operation} failed: Docker daemon is not running inside ${distroRef}. Run ` +
      `worker/.devcontainer/setup-wsl.ps1 to start it.`
    );
  }
  return `WSL ${operation} failed for ${distroRef}: ${msg}`;
}

// ---------------------------------------------------------------------------
// Worker container lifecycle
// ---------------------------------------------------------------------------

/** Result of starting a local worker container */
export interface WslWorkerExecution {
  /** Docker container name (used for status checks and stop) */
  executionName: string;
  /** Container status, mirroring AcaJobExecution's shape */
  status: string;
  /** Host-side port (inside the WSL distro) the backend should dial to reach the worker. */
  publishedPort: number;
}

/** Options for git workspace setup in the worker container — same shape as ACA's WorkerGitOptions. */
export interface WorkerGitOptions {
  repositoryUrl: string;
  devBranch?: string;
  taskTitle?: string;
  githubPat?: string;
  azureDevOpsPat?: string;
  gitProvider?: string;
  persistentBranchName?: string;
}

/** Build the docker network name dedicated to one session's worker + proxy sidecar. */
function sessionNetworkName(sessionId: number): string {
  return `kirofactory-session-${sessionId}`;
}

function containerName(sessionId: number): string {
  return `kirofactory-worker-${sessionId}`;
}

function proxyContainerName(sessionId: number): string {
  return `kirofactory-mcp-proxy-${sessionId}`;
}

/**
 * Start a new local worker container for a session.
 *
 * Mirrors startWorkerJob() in aca-worker-spawner.ts: same parameter shape,
 * same env var contract passed to worker.js, so worker.js requires no
 * changes to run under either spawner.
 */
export async function startWorkerJob(
  config: WslWorkerConfig,
  sessionId: number,
  agentName: string,
  userId: number,
  timeoutSeconds: number,
  mcpSidecar?: McpProxySidecarConfig | null,
  gitOptions?: WorkerGitOptions | null,
  agentKind?: "editor" | "inspector",
  agentConfigBase64?: string
): Promise<WslWorkerExecution> {
  const kiroApiKey = await getUserKiroApiKey(userId);
  if (!kiroApiKey) {
    throw new Error(`Cannot start worker: user ${userId} has no Kiro API key configured`);
  }

  const name = containerName(sessionId);
  const network = sessionNetworkName(sessionId);

  try {
    // Fresh per-session Docker network — the local analogue of ACA's
    // same-revision shared networking (containers on a shared bridge network
    // can reach each other by container name, unlike separate `docker run`
    // invocations with no network in common).
    await runInDistro(config.distroName, ["docker", "network", "create", network]).catch(() => {
      // Ignore "already exists" — defensive only; session IDs shouldn't collide.
    });

    const envArgs: string[] = [
      "-e", `SESSION_ID=${sessionId}`,
      "-e", `WORKER_LISTEN_MODE=${config.workerListenPort}`,
      "-e", `WORKER_SECRET=${config.workerSecret}`,
      "-e", `KIRO_API_KEY=${kiroApiKey}`,
      "-e", `AGENT_NAME=${agentName}`,
      "-e", `AGENT_KIND=${agentKind || "editor"}`,
      "-e", `GIT_USER_NAME=${config.gitUserName}`,
      "-e", `GIT_USER_EMAIL=${config.gitUserEmail}`,
      "-e", `TIMEOUT_SECONDS=${timeoutSeconds || 900}`,
    ];

    if (agentConfigBase64) {
      envArgs.push("-e", `AGENT_CONFIG_JSON_B64=${agentConfigBase64}`);
    }

    let proxyHostname = "";
    if (mcpSidecar) {
      proxyHostname = proxyContainerName(sessionId);
      const serverNames = Object.keys(mcpSidecar.serversConfig);
      envArgs.push(
        "-e", `MCP_PROXY_HOST=${proxyHostname}`,
        "-e", "MCP_PROXY_PORT=9090",
        "-e", `MCP_SIDECAR_SERVER_NAMES=${serverNames.join(",")}`
      );
    }

    if (gitOptions) {
      envArgs.push(
        "-e", `REPO_URL=${gitOptions.repositoryUrl}`,
        "-e", `DEV_BRANCH=${gitOptions.devBranch || "develop,dev,main"}`
      );
      if (gitOptions.gitProvider) {
        envArgs.push("-e", `GIT_PROVIDER=${gitOptions.gitProvider}`);
      }
      if (gitOptions.persistentBranchName) {
        envArgs.push("-e", `PERSISTENT_BRANCH_NAME=${gitOptions.persistentBranchName}`);
      }
      const effectiveAdoPat = gitOptions.azureDevOpsPat || config.azureDevOpsPat;
      if (effectiveAdoPat) {
        envArgs.push("-e", `AZURE_DEVOPS_PAT=${effectiveAdoPat}`);
      }
      if (gitOptions.githubPat) {
        envArgs.push("-e", `GITHUB_PAT=${gitOptions.githubPat}`);
      }
    }

    // MCP proxy sidecar container, if configured — started first so its
    // hostname is resolvable on the shared network by the time the worker
    // connects to it.
    if (mcpSidecar && config.proxyImage) {
      const proxyEnvArgs: string[] = [
        "-e", "MCP_PROXY_PORT=9090",
        "-e", `MCP_SERVERS_JSON_B64=${encodeServersConfigBase64(mcpSidecar.serversConfig)}`,
      ];
      for (const { name: envName, value } of buildProxyCredentialEnvVars(mcpSidecar.credentials)) {
        proxyEnvArgs.push("-e", `${envName}=${value}`);
      }

      await runInDistro(config.distroName, [
        "docker", "run", "-d", "--rm",
        "--name", proxyContainerName(sessionId),
        "--network", network,
        ...proxyEnvArgs,
        config.proxyImage,
      ]);
    }

    await runInDistro(config.distroName, [
      "docker", "run", "-d", "--rm",
      "--name", name,
      "--network", network,
      // Publish the worker's listen port to a random host port inside the
      // distro. The backend (Windows host) dials into it via WSL2's
      // automatic localhost port-forwarding — see the module doc comment
      // for why this direction, rather than the worker dialing out, is used.
      "-p", `0.0.0.0:0:${config.workerListenPort}`,
      ...envArgs,
      config.workerImage,
    ]);

    const publishedPort = await getPublishedPort(config, name);

    return { executionName: name, status: "Running", publishedPort };
  } catch (err) {
    throw new Error(explainWslError("job start", config, err));
  }
}

/**
 * Read back the host-side port Docker assigned to the worker's published
 * listen port (`docker run -p 0.0.0.0:0:<listenPort>` picks a random free
 * port on the distro's own network stack — we need to know which one).
 */
async function getPublishedPort(config: WslWorkerConfig, containerName: string): Promise<number> {
  const { stdout } = await runInDistro(config.distroName, [
    "docker", "port", containerName, String(config.workerListenPort),
  ]);
  // Output looks like "0.0.0.0:54321\n" (and possibly a second "[::]:54321" line for IPv6).
  const match = stdout.match(/:(\d+)/);
  if (!match) {
    throw new Error(
      `Could not determine published port for container ${containerName} (docker port output: ${stdout.trim() || "<empty>"})`
    );
  }
  return Number(match[1]);
}

/**
 * Stop a running local worker container (and its MCP proxy sidecar + network, if any).
 *
 * Mirrors stopWorkerJob() in aca-worker-spawner.ts — best-effort, never throws
 * (failures are logged, not propagated, matching the ACA behavior).
 */
export async function stopWorkerJob(
  config: WslWorkerConfig,
  executionName: string
): Promise<void> {
  try {
    await runInDistro(config.distroName, ["docker", "stop", executionName]);
  } catch (err) {
    // "No such container" is fine — it may have already exited (--rm cleans it up).
    const msg = err instanceof Error ? err.message : String(err);
    if (!/No such container/i.test(msg)) {
      console.warn(`[wsl-spawner] ${explainWslError(`stop of container ${executionName}`, config, err)}`);
    }
  }

  // Best-effort cleanup of the sidecar + network; both are named deterministically
  // from the session ID embedded in the worker container's name.
  const sessionIdMatch = executionName.match(/kirofactory-worker-(\d+)/);
  if (sessionIdMatch) {
    const sessionId = Number(sessionIdMatch[1]);
    await runInDistro(config.distroName, ["docker", "stop", proxyContainerName(sessionId)]).catch(() => {});
    await runInDistro(config.distroName, ["docker", "network", "rm", sessionNetworkName(sessionId)]).catch(() => {});
  }
}

/**
 * Get the status of a local worker container.
 *
 * Mirrors getWorkerJobStatus() in aca-worker-spawner.ts.
 */
export async function getWorkerJobStatus(
  config: WslWorkerConfig,
  executionName: string
): Promise<{ status: string; startTime?: string; endTime?: string }> {
  try {
    const { stdout } = await runInDistro(config.distroName, [
      "docker", "inspect", "--format",
      "{{.State.Status}}|{{.State.StartedAt}}|{{.State.FinishedAt}}",
      executionName,
    ]);
    const [status, startTime, endTime] = stdout.trim().split("|");
    return {
      status: status === "running" ? "Running" : (status || "Unknown"),
      startTime: startTime && startTime !== "0001-01-01T00:00:00Z" ? startTime : undefined,
      endTime: endTime && endTime !== "0001-01-01T00:00:00Z" ? endTime : undefined,
    };
  } catch (err) {
    throw new Error(explainWslError("job status check", config, err));
  }
}

/** Result of the startup access preflight — mirrors AcaAccessCheck's shape. */
export interface WslAccessCheck {
  ok: boolean;
  message: string;
}

/**
 * Preflight check: verify the dedicated WSL distro exists and its Docker
 * daemon is responding. Never throws — returns a structured result intended
 * for logging at startup, mirroring verifyAcaAccess()'s contract.
 *
 * Does not auto-provision — that's setup-wsl.ps1's job. This just reports
 * whether it's ready, so a missing/unhealthy distro surfaces as a clear
 * startup log line instead of a confusing failure on first "start session".
 */
export async function verifyWslAccess(config: WslWorkerConfig): Promise<WslAccessCheck> {
  try {
    await runInDistro(config.distroName, ["docker", "info"]);
    return {
      ok: true,
      message: `WSL distro "${config.distroName}" is present and Docker is responding.`,
    };
  } catch (err) {
    return {
      ok: false,
      message:
        `${explainWslError("access preflight", config, err)} ` +
        `Run 'pwsh worker/.devcontainer/setup-wsl.ps1' to provision it.`,
    };
  }
}
