/**
 * ACA Worker Spawner — Spawns Kiro ACP workers as Azure Container Apps Jobs.
 *
 * Instead of spawning local child processes (KiroRunner), this module creates
 * ACA Job executions via the Azure REST API. Each worker container connects
 * back to the orchestrator via WebSocket for bidirectional communication.
 *
 * Each session gets its own MCP proxy sidecar container for full credential
 * isolation (no sharing between sessions). The proxy runs alongside the worker
 * in the same ACA Job revision, sharing localhost networking.
 *
 * ACA Jobs are event-driven: they scale to zero and you only pay while running.
 */

import { getUserKiroApiKey } from "./db/users.js";
import type { ProxyServersConfig } from "./mcp-proxy-config.js";
import { encodeServersConfigBase64, buildProxyCredentialEnvVars, type SessionCredentials } from "./mcp-proxy-config.js";

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

export interface AcaWorkerConfig {
  /** Azure subscription ID */
  subscriptionId: string;
  /** Azure resource group containing the ACA environment */
  resourceGroup: string;
  /** ACA Job name (must exist — created by infra/Bicep) */
  jobName: string;
  /** ACR image reference (e.g., kirofactoryacr.azurecr.io/vibecode-heaven-worker:latest) */
  workerImage: string;
  /** ACR image reference for the MCP proxy sidecar (e.g., kirofactoryacr.azurecr.io/vibecode-heaven-mcp-proxy:latest) */
  proxyImage: string;
  /** Internal URL the worker uses to connect back to the orchestrator WebSocket */
  orchestratorUrl: string;
  /** Shared secret for worker ↔ orchestrator authentication */
  workerSecret: string;
  /** Git user name for commits inside the worker */
  gitUserName: string;
  /** Git user email for commits inside the worker */
  gitUserEmail: string;
  /** Azure DevOps Personal Access Token for git clone authentication */
  azureDevOpsPat: string;
}

/**
 * Loads ACA worker configuration from environment variables.
 * Returns null if ACA mode is not configured (missing required vars).
 */
export function loadAcaConfig(): AcaWorkerConfig | null {
  const subscriptionId = process.env.ACA_SUBSCRIPTION_ID;
  const resourceGroup = process.env.ACA_RESOURCE_GROUP;
  const jobName = process.env.ACA_JOB_NAME || "vibecode-heaven-worker";
  const workerImage = process.env.ACA_WORKER_IMAGE;
  const proxyImage = process.env.ACA_PROXY_IMAGE || "";
  const orchestratorUrl = process.env.ACA_ORCHESTRATOR_URL;
  const workerSecret = process.env.ACA_WORKER_SECRET;
  const gitUserName = process.env.GIT_USER_NAME || "Vibecode Heaven Agent";
  const gitUserEmail = process.env.GIT_USER_EMAIL || "agent@vibecode-heaven.dev";
  const azureDevOpsPat = process.env.AZURE_DEVOPS_EXT_PAT || "";

  // All required vars must be present to enable ACA mode
  if (!subscriptionId || !resourceGroup || !workerImage || !orchestratorUrl || !workerSecret) {
    return null;
  }

  return {
    subscriptionId,
    resourceGroup,
    jobName,
    workerImage,
    proxyImage,
    orchestratorUrl,
    workerSecret,
    gitUserName,
    gitUserEmail,
    azureDevOpsPat,
  };
}

// ---------------------------------------------------------------------------
// Azure access token acquisition
// ---------------------------------------------------------------------------

/**
 * Get an Azure access token using the Azure Identity default credential chain.
 * Works with managed identity (in ACA), Azure CLI, environment variables, etc.
 *
 * Uses the Azure REST management API scope.
 */
async function getAzureAccessToken(): Promise<string> {
  // Dynamic import to avoid hard dependency — only needed when ACA mode is active
  const { DefaultAzureCredential } = await import("@azure/identity");
  const credential = new DefaultAzureCredential();
  const tokenResponse = await credential.getToken("https://management.azure.com/.default");
  return tokenResponse.token;
}

// ---------------------------------------------------------------------------
// Error diagnostics
// ---------------------------------------------------------------------------

/** Trim a raw Azure error body so it stays readable in logs and the Errors tab. */
function truncate(text: string, max = 400): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Turn a failed Azure management API response into an actionable error message.
 *
 * The most common failure by far is an RBAC problem: the orchestrator's managed
 * identity is missing the "Container Apps Jobs Operator" role on the worker job.
 * That surfaces as HTTP 403 with code "AuthorizationFailed" and is NOT a user
 * credential problem — the Azure DevOps / Atlassian / AWS credentials are injected
 * into the worker only AFTER it starts, so they cannot cause this. This helper makes
 * the distinction explicit so the failure is self-explanatory in the UI.
 */
function explainAcaHttpError(
  operation: string,
  status: number,
  errorText: string,
  config: AcaWorkerConfig
): string {
  const jobRef =
    `job "${config.jobName}" (resource group "${config.resourceGroup}", ` +
    `subscription ${config.subscriptionId})`;

  // 401/403/AuthorizationFailed: the identity reached Azure but isn't permitted.
  if (status === 401 || status === 403 || /AuthorizationFailed/i.test(errorText)) {
    return (
      `ACA ${operation} was denied by Azure (HTTP ${status}) for ${jobRef}. ` +
      `This is an Azure RBAC problem, not a user credential problem: the orchestrator's ` +
      `managed identity lacks permission to act on the job. Grant it the built-in ` +
      `"Container Apps Jobs Operator" role scoped to the job (least privilege — avoid Contributor). ` +
      `See ARCHITECTURE.md → "Managed Identity & permissions". Azure detail: ${truncate(errorText)}`
    );
  }

  // 404: the job (or execution) does not exist / config points at the wrong place.
  if (status === 404) {
    return (
      `ACA ${operation} failed: Azure returned 404 Not Found for ${jobRef}. ` +
      `The Container Apps Job may not exist, or ACA_JOB_NAME / ACA_RESOURCE_GROUP / ` +
      `ACA_SUBSCRIPTION_ID may be misconfigured. Azure detail: ${truncate(errorText)}`
    );
  }

  return `ACA ${operation} failed (HTTP ${status}) for ${jobRef}: ${truncate(errorText)}`;
}

// ---------------------------------------------------------------------------
// ACA Job Execution API
// ---------------------------------------------------------------------------

/** Result of starting a job execution */
export interface AcaJobExecution {
  /** Execution name (used for status checks and cancellation) */
  executionName: string;
  /** Provisioning state */
  status: string;
}

/** Options for git workspace setup in the worker container */
export interface WorkerGitOptions {
  /** Repository URL to clone (e.g., https://dev.azure.com/org/project/_git/repo) */
  repositoryUrl: string;
  /** Comma-separated list of candidate branches to try (default: "develop,dev,main") */
  devBranch?: string;
  /** Task title (used to generate the working branch name: kirofactory/<slug>-<short-id>) */
  taskTitle?: string;
  /** GitHub Personal Access Token for push/PR operations */
  githubPat?: string;
  /**
   * Azure DevOps Personal Access Token for clone/push/PR operations.
   * Per-user credential; takes precedence over the orchestrator-wide
   * AZURE_DEVOPS_EXT_PAT fallback in AcaWorkerConfig.
   */
  azureDevOpsPat?: string;
  /**
   * Resolved git provider ("github" | "azure-devops"). Sent to the worker so it
   * uses the selected provider instead of guessing from the URL — required for
   * self-hosted hosts the worker cannot recognise.
   */
  gitProvider?: string;
}

/**
 * Start a new ACA Job execution for a session.
 *
 * This calls the Azure REST API:
 * POST /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/jobs/{job}/start
 *
 * The job template is overridden with session-specific environment variables.
 * When an MCP proxy sidecar config is provided, a second container is added to the
 * same revision — sharing localhost networking with the worker container.
 */
export async function startWorkerJob(
  config: AcaWorkerConfig,
  sessionId: number,
  agentName: string,
  userId: number,
  timeoutSeconds: number,
  mcpSidecar?: McpProxySidecarConfig | null,
  gitOptions?: WorkerGitOptions | null,
  agentKind?: "editor" | "inspector",
  /**
   * Base64-encoded `.kiro/agents/<name>.json` content (see
   * agent-config-writer.ts), built from the session's DB Agent record.
   * The worker writes this to the workspace before invoking kiro-cli, unless
   * the target repo already ships its own file of the same name.
   */
  agentConfigBase64?: string
): Promise<AcaJobExecution> {
  // Decrypt the user's Kiro API key
  const kiroApiKey = await getUserKiroApiKey(userId);
  if (!kiroApiKey) {
    throw new Error(`Cannot start worker: user ${userId} has no Kiro API key configured`);
  }

  const token = await getAzureAccessToken();
  const apiVersion = "2024-03-01";
  const url =
    `https://management.azure.com/subscriptions/${config.subscriptionId}` +
    `/resourceGroups/${config.resourceGroup}` +
    `/providers/Microsoft.App/jobs/${config.jobName}/start` +
    `?api-version=${apiVersion}`;

  // Build environment variables for the worker container
  const envVars: Array<{ name: string; value: string }> = [
    { name: "SESSION_ID", value: String(sessionId) },
    { name: "ORCHESTRATOR_URL", value: config.orchestratorUrl },
    { name: "WORKER_SECRET", value: config.workerSecret },
    { name: "KIRO_API_KEY", value: kiroApiKey },
    { name: "AGENT_NAME", value: agentName },
    { name: "AGENT_KIND", value: agentKind || "editor" },
    { name: "GIT_USER_NAME", value: config.gitUserName },
    { name: "GIT_USER_EMAIL", value: config.gitUserEmail },
    { name: "TIMEOUT_SECONDS", value: String(timeoutSeconds || 900) },
  ];

  if (agentConfigBase64) {
    envVars.push({ name: "AGENT_CONFIG_JSON_B64", value: agentConfigBase64 });
  }

  // MCP proxy sidecar: tell the worker where to connect (localhost because same pod)
  // and which server names the sidecar was actually configured with, so the
  // worker can bridge each one into kiro-cli's mcpServers list via ta-mcp-connect.
  // Without MCP_SIDECAR_SERVER_NAMES the worker has no way to discover those
  // names — the server list itself (MCP_SERVERS_JSON_B64) is only ever sent to
  // the mcp-proxy container below, not to the worker.
  if (mcpSidecar) {
    const serverNames = Object.keys(mcpSidecar.serversConfig);
    envVars.push(
      { name: "MCP_PROXY_HOST", value: "localhost" },
      { name: "MCP_PROXY_PORT", value: "9090" },
      { name: "MCP_SIDECAR_SERVER_NAMES", value: serverNames.join(",") }
    );
  }

  // Git workspace configuration (clone + branch in worker)
  if (gitOptions) {
    envVars.push(
      { name: "REPO_URL", value: gitOptions.repositoryUrl },
      { name: "DEV_BRANCH", value: gitOptions.devBranch || "develop,dev,main" }
    );
    if (gitOptions.gitProvider) {
      envVars.push({ name: "GIT_PROVIDER", value: gitOptions.gitProvider });
    }
    // Per-user credential wins; the orchestrator-wide PAT is a fallback for
    // deployments that use a single service account for all Azure DevOps access.
    const effectiveAdoPat = gitOptions.azureDevOpsPat || config.azureDevOpsPat;
    if (effectiveAdoPat) {
      envVars.push({ name: "AZURE_DEVOPS_PAT", value: effectiveAdoPat });
    }
    if (gitOptions.githubPat) {
      envVars.push({ name: "GITHUB_PAT", value: gitOptions.githubPat });
    }
  }

  // Build the containers array: always includes worker, optionally includes proxy sidecar
  const containers: Array<{
    name: string;
    image: string;
    env: Array<{ name: string; value: string }>;
    resources: { cpu: number; memory: string };
  }> = [
    {
      name: "worker",
      image: config.workerImage,
      env: envVars,
      resources: {
        cpu: 1.0,
        memory: "2Gi",
      },
    },
  ];

  // Add MCP proxy sidecar container if configured
  if (mcpSidecar && config.proxyImage) {
    const proxyEnvVars: Array<{ name: string; value: string }> = [
      { name: "MCP_PROXY_PORT", value: "9090" },
      { name: "MCP_SERVERS_JSON_B64", value: encodeServersConfigBase64(mcpSidecar.serversConfig) },
    ];

    // Inject credential env vars into the proxy container so spawned MCP servers
    // inherit them (some servers read credentials from the process environment)
    const credEnvVars = buildProxyCredentialEnvVars(mcpSidecar.credentials);
    proxyEnvVars.push(...credEnvVars);

    containers.push({
      name: "mcp-proxy",
      image: config.proxyImage,
      env: proxyEnvVars,
      resources: {
        cpu: 0.25,
        memory: "512Mi",
      },
    });
  }

  // The request body is a JobExecutionTemplate — containers directly at the top level.
  // See: https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/jobs/start
  const body = {
    containers,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(explainAcaHttpError("job start", response.status, errorText, config));
  }

  const result = await response.json() as {
    name?: string;
    properties?: { status?: string };
  };

  return {
    executionName: result.name || `${config.jobName}-${sessionId}`,
    status: result.properties?.status || "Running",
  };
}

/**
 * Stop/cancel a running ACA Job execution.
 *
 * DELETE /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/jobs/{job}/executions/{exec}/stop
 */
export async function stopWorkerJob(
  config: AcaWorkerConfig,
  executionName: string
): Promise<void> {
  const token = await getAzureAccessToken();
  const apiVersion = "2024-03-01";
  // There is no "delete a job execution" operation in the Container Apps Jobs
  // API — executions are terminated via a dedicated `stop` action, not a
  // generic DELETE. A DELETE on this path 403s even for a fully-privileged
  // identity because `Microsoft.App/jobs/executions/delete` isn't a real
  // permission (jobs/executions only exposes `read`); the actual permission
  // this needs is `Microsoft.App/jobs/stop/execution/action`, which IS
  // covered by the built-in "Container Apps Jobs Operator" role already
  // assigned to this identity. See:
  // https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/jobs/stop-execution
  const url =
    `https://management.azure.com/subscriptions/${config.subscriptionId}` +
    `/resourceGroups/${config.resourceGroup}` +
    `/providers/Microsoft.App/jobs/${config.jobName}` +
    `/executions/${executionName}/stop` +
    `?api-version=${apiVersion}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  // 200, 202, 204 are all acceptable
  if (!response.ok && response.status !== 404) {
    const errorText = await response.text();
    console.warn(
      `[aca-spawner] ${explainAcaHttpError(`stop of execution ${executionName}`, response.status, errorText, config)}`
    );
  }
}

/**
 * Get the status of a job execution.
 *
 * GET /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/jobs/{job}/executions/{exec}
 */
export async function getWorkerJobStatus(
  config: AcaWorkerConfig,
  executionName: string
): Promise<{ status: string; startTime?: string; endTime?: string }> {
  const token = await getAzureAccessToken();
  const apiVersion = "2024-03-01";
  const url =
    `https://management.azure.com/subscriptions/${config.subscriptionId}` +
    `/resourceGroups/${config.resourceGroup}` +
    `/providers/Microsoft.App/jobs/${config.jobName}` +
    `/executions/${executionName}` +
    `?api-version=${apiVersion}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(explainAcaHttpError("job status check", response.status, errorText, config));
  }

  const result = await response.json() as {
    properties?: {
      status?: string;
      startTime?: string;
      endTime?: string;
    };
  };

  return {
    status: result.properties?.status || "Unknown",
    startTime: result.properties?.startTime,
    endTime: result.properties?.endTime,
  };
}

/**
 * Check if ACA worker mode is enabled (all required env vars are set).
 */
export function isAcaModeEnabled(): boolean {
  return loadAcaConfig() !== null;
}

/** Result of the startup access preflight. Never represents an exception — see verifyAcaAccess. */
export interface AcaAccessCheck {
  ok: boolean;
  status?: number;
  message: string;
}

/**
 * Preflight check: verify the orchestrator's managed identity can operate the worker job.
 *
 * Performs a GET on the job resource, which requires the same `Microsoft.App/jobs/read`
 * permission that "Container Apps Jobs Operator" grants alongside start/stop. A success
 * therefore strongly implies that starting a session will work, letting us surface an RBAC
 * or identity misconfiguration at boot instead of at the first "start session" click.
 *
 * This never throws — it returns a structured result intended for logging at startup.
 */
export async function verifyAcaAccess(config: AcaWorkerConfig): Promise<AcaAccessCheck> {
  try {
    const token = await getAzureAccessToken();
    const apiVersion = "2024-03-01";
    const url =
      `https://management.azure.com/subscriptions/${config.subscriptionId}` +
      `/resourceGroups/${config.resourceGroup}` +
      `/providers/Microsoft.App/jobs/${config.jobName}` +
      `?api-version=${apiVersion}`;

    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        message: `managed identity can access ACA job "${config.jobName}" in "${config.resourceGroup}".`,
      };
    }

    const errorText = await response.text();
    return {
      ok: false,
      status: response.status,
      message: explainAcaHttpError("job access preflight", response.status, errorText, config),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message:
        `Could not verify ACA job access (token acquisition or network error): ${msg}. ` +
        `The orchestrator's system-assigned managed identity may be disabled or unreachable.`,
    };
  }
}
