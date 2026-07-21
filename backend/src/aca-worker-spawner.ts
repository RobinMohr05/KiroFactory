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
  /** ACR image reference (e.g., kirofactoryacr.azurecr.io/kirofactory-worker:latest) */
  workerImage: string;
  /** ACR image reference for the MCP proxy sidecar (e.g., kirofactoryacr.azurecr.io/kirofactory-mcp-proxy:latest) */
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
  const jobName = process.env.ACA_JOB_NAME || "kirofactory-worker";
  const workerImage = process.env.ACA_WORKER_IMAGE;
  const proxyImage = process.env.ACA_PROXY_IMAGE || "";
  const orchestratorUrl = process.env.ACA_ORCHESTRATOR_URL;
  const workerSecret = process.env.ACA_WORKER_SECRET;
  const gitUserName = process.env.GIT_USER_NAME || "KiroFactory Agent";
  const gitUserEmail = process.env.GIT_USER_EMAIL || "agent@kirofactory.dev";
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
  /** Branch to use as reference base (default: "develop") */
  devBranch?: string;
  /** Task title (used to generate the working branch name: kirofactory/<slug>-<short-id>) */
  taskTitle?: string;
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
  sessionId: string,
  agentName: string,
  userId: number,
  timeoutSeconds: number,
  mcpSidecar?: McpProxySidecarConfig | null,
  gitOptions?: WorkerGitOptions | null
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
    { name: "SESSION_ID", value: sessionId },
    { name: "ORCHESTRATOR_WS_URL", value: config.orchestratorUrl },
    { name: "WORKER_SECRET", value: config.workerSecret },
    { name: "KIRO_API_KEY", value: kiroApiKey },
    { name: "AGENT_NAME", value: agentName },
    { name: "GIT_USER_NAME", value: config.gitUserName },
    { name: "GIT_USER_EMAIL", value: config.gitUserEmail },
    { name: "TIMEOUT_SECONDS", value: String(timeoutSeconds || 900) },
  ];

  // MCP proxy sidecar: tell the worker where to connect (localhost because same pod)
  if (mcpSidecar) {
    envVars.push(
      { name: "MCP_PROXY_HOST", value: "localhost" },
      { name: "MCP_PROXY_PORT", value: "9090" }
    );
  }

  // Git workspace configuration (clone + branch in worker)
  if (gitOptions) {
    envVars.push(
      { name: "REPOSITORY_URL", value: gitOptions.repositoryUrl },
      { name: "DEV_BRANCH", value: gitOptions.devBranch || "develop" }
    );
    if (config.azureDevOpsPat) {
      envVars.push({ name: "AZURE_DEVOPS_EXT_PAT", value: config.azureDevOpsPat });
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

  // The request body overrides the container template for this execution
  const body = {
    template: {
      containers,
    },
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
    throw new Error(
      `ACA Job start failed (${response.status}): ${errorText}`
    );
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
  const url =
    `https://management.azure.com/subscriptions/${config.subscriptionId}` +
    `/resourceGroups/${config.resourceGroup}` +
    `/providers/Microsoft.App/jobs/${config.jobName}` +
    `/executions/${executionName}` +
    `?api-version=${apiVersion}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  // 200, 202, 204 are all acceptable
  if (!response.ok && response.status !== 404) {
    const errorText = await response.text();
    console.warn(
      `[aca-spawner] Failed to stop job execution ${executionName}: ${response.status} ${errorText}`
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
    throw new Error(`Failed to get job status: ${response.status}`);
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
