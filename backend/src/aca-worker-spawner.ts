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
 *
 * ## Secret handling
 *
 * Sensitive values (WORKER_SECRET, KIRO_API_KEY, GITHUB_PAT, AZURE_DEVOPS_PAT,
 * and the MCP proxy sidecar's per-user credentials — Atlassian / Azure DevOps /
 * AWS) are NOT passed as plaintext `value` entries in the per-execution env
 * override. Doing so exposes them in `az containerapp job execution show` and the
 * Azure Portal's execution detail blade, readable by anyone with Reader on the job.
 * The proxy sidecar runs in the same execution, so its env leaks just as badly.
 *
 * Instead, before each execution start we PATCH the job's `configuration.secrets`
 * array to register session-scoped secrets (named `<base>-sess-<sessionId>`), then
 * reference them via `secretRef` in the execution's container env. After stopping
 * we remove those secrets by PATCHing the job again to clear the session entries.
 * If the start POST itself fails, we remove those just-registered secrets
 * (best-effort) before re-throwing, so a failed start never leaves live
 * credentials orphaned on the job.
 *
 * Session-scoped names (e.g., `kiro-api-key-sess-42`) prevent name collisions
 * between concurrent sessions that may have different per-user credentials.
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
// ACA env-var types
// ---------------------------------------------------------------------------

/**
 * An ACA container environment variable.
 *
 * Exactly one of `value` or `secretRef` should be set:
 * - `value`     — plaintext, visible in execution metadata (for non-sensitive vars).
 * - `secretRef` — references a secret in the job's `configuration.secrets` array;
 *                 the secret value is never returned in execution metadata.
 */
interface EnvironmentVar {
  name: string;
  value?: string;
  secretRef?: string;
}

// ---------------------------------------------------------------------------
// Session-scoped secret management
// ---------------------------------------------------------------------------

/**
 * Build a session-scoped ACA secret name for a given base name.
 *
 * ACA secret names must be lowercase alphanumeric + hyphens, so we lower-case
 * the base and append the session ID to guarantee uniqueness across concurrent
 * sessions (each session may have different per-user credentials).
 *
 * Examples: workerSecretName(42) = "worker-secret-sess-42"
 */
function sessionSecretName(base: string, sessionId: number): string {
  return `${base}-sess-${sessionId}`;
}

/**
 * Derive an ACA-safe secret *base* name from an environment variable name.
 *
 * ACA secret names must be lowercase alphanumeric plus hyphens, so we lower-case
 * the env name and replace any run of non-alphanumeric characters (e.g. the
 * underscores in `ATLASSIAN_API_TOKEN`) with a single hyphen. The result is fed
 * to {@link sessionSecretName} to make it session-scoped.
 *
 * Example: secretBaseFromEnvName("ATLASSIAN_API_TOKEN") = "atlassian-api-token"
 */
function secretBaseFromEnvName(envName: string): string {
  return envName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One secret entry in the job's `configuration.secrets` array.
 */
interface AcaJobSecret {
  name: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Concurrency control for the shared job `configuration.secrets` list
// ---------------------------------------------------------------------------
//
// The autoscaler runs a POOL of concurrent worker sessions against the SAME
// Container Apps Job resource. Registering / removing session-scoped secrets is
// a read-modify-write on that job's single `configuration.secrets` list
// (listSecrets to read the real values + GET for the ETag → merge/filter in
// memory → PATCH full list). Without coordination, two sessions starting (or one
// starting while another stops) can interleave so that the losing writer merges
// onto a STALE snapshot and silently drops the other session's just-registered
// secrets — whose `secretRef` then dangles and the execution start fails / the
// worker boots without its creds.
//
// We defend against this on two levels (coding_guidelines §26):
//   1. An in-process async mutex serialises all secret mutations for a given job
//      within this orchestrator process (the common case — one orchestrator).
//   2. ARM optimistic concurrency: each mutation reads the current list (values
//      via `listSecrets`, ETag via GET — a plain GET redacts secret values),
//      then PATCHes with `If-Match: <etag>`. If ARM reports 412
//      (Precondition Failed) — e.g. another orchestrator instance wrote
//      concurrently — we re-read and re-apply, up to a bounded number of retries.

/** Minimal FIFO async mutex (see coding_guidelines §26). */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively; callers are serialised in acquisition order. */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Keep the chain alive regardless of whether `fn` resolves or rejects.
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/** One mutex per job resource path, so unrelated jobs don't serialise together. */
const jobSecretMutexes = new Map<string, AsyncMutex>();

function getJobSecretMutex(jobUrl: string): AsyncMutex {
  let mutex = jobSecretMutexes.get(jobUrl);
  if (!mutex) {
    mutex = new AsyncMutex();
    jobSecretMutexes.set(jobUrl, mutex);
  }
  return mutex;
}

/** Build the ARM URL for the job resource. */
function jobResourceUrl(config: AcaWorkerConfig): string {
  const apiVersion = "2024-03-01";
  return (
    `https://management.azure.com/subscriptions/${config.subscriptionId}` +
    `/resourceGroups/${config.resourceGroup}` +
    `/providers/Microsoft.App/jobs/${config.jobName}` +
    `?api-version=${apiVersion}`
  );
}

/** Max attempts for the GET→PATCH cycle when ARM reports a 412 ETag conflict. */
const SECRET_MUTATION_MAX_ATTEMPTS = 5;

/**
 * Fetch the job's secrets *with their real values* via the `listSecrets` POST
 * action.
 *
 * A plain ARM `GET` on `Microsoft.App/jobs/{job}` returns each secret's `name`
 * but REDACTS/omits its `value` — Azure never returns secret values on GET.
 * The values are only retrievable via this separate `listSecrets` action
 * (which is exactly why the "Container Apps Jobs Operator" role carries
 * `Microsoft.App/jobs/listSecrets/action`).
 *
 * We need the real values because ACA requires the *full* secrets list on every
 * PATCH (it replaces the list wholesale). Merging onto the redacted GET result
 * would re-PATCH pre-existing secrets (e.g. the Bicep-seeded `acr-password`)
 * with an empty value, breaking ACR image pulls for every subsequent execution.
 *
 * Returns the resolved list, or `null` if the action failed (so callers can
 * abort rather than clobber the list with redacted values).
 */
async function listJobSecrets(
  config: AcaWorkerConfig,
  token: string
): Promise<AcaJobSecret[] | null> {
  const apiVersion = "2024-03-01";
  const url =
    `https://management.azure.com/subscriptions/${config.subscriptionId}` +
    `/resourceGroups/${config.resourceGroup}` +
    `/providers/Microsoft.App/jobs/${config.jobName}` +
    `/listSecrets` +
    `?api-version=${apiVersion}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    return null;
  }

  const result = (await response.json()) as { value?: AcaJobSecret[] };
  return result.value ?? [];
}

/**
 * Atomically read-modify-write the job's `configuration.secrets` list.
 *
 * Serialised per-job via {@link AsyncMutex} and guarded with ARM's `If-Match`
 * optimistic concurrency: we GET the current list (+ETag), apply `transform` to
 * produce the next list, then PATCH with `If-Match: <etag>`. On HTTP 412 we
 * re-read and retry (up to {@link SECRET_MUTATION_MAX_ATTEMPTS}) so a losing
 * writer re-merges onto fresh state instead of clobbering it.
 *
 * Because a plain GET redacts secret VALUES (Azure only returns names on GET),
 * we resolve the current secrets' real values via the `listSecrets` action
 * (see {@link listJobSecrets}) and pass those to `transform` — otherwise a
 * merge would re-PATCH pre-existing secrets (e.g. `acr-password`) with empty
 * values. The GET is still used to obtain the ETag for optimistic concurrency.
 *
 * `transform` receives the current list and returns the desired next list, or
 * `null` to indicate "no change needed" (the PATCH is then skipped).
 *
 * Returns `true` if the desired state was achieved (patched or already correct),
 * `false` if the mutation ultimately failed (logged as a warning by callers).
 */
async function mutateJobSecrets(
  config: AcaWorkerConfig,
  token: string,
  transform: (current: AcaJobSecret[]) => AcaJobSecret[] | null,
  opContext: string
): Promise<boolean> {
  const jobUrl = jobResourceUrl(config);
  const mutex = getJobSecretMutex(jobUrl);

  return mutex.runExclusive(async () => {
    for (let attempt = 1; attempt <= SECRET_MUTATION_MAX_ATTEMPTS; attempt++) {
      // ── GET current job (for the ETag; secret values are redacted here) ──
      const getResponse = await fetch(jobUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!getResponse.ok) {
        // If GET fails (e.g., RBAC issue), we cannot safely merge. Surface a
        // warning; the subsequent start will fail anyway if secrets are missing.
        console.warn(
          `[aca-spawner] Could not GET job to ${opContext} (HTTP ${getResponse.status})`
        );
        return false;
      }

      const etag = getResponse.headers.get("ETag") ?? undefined;

      // ── Resolve the current secrets' REAL values via listSecrets ────────
      // The GET above redacts secret values, so merging onto it would clobber
      // pre-existing secrets (e.g. acr-password) with empty values on PATCH.
      const existingSecrets = await listJobSecrets(config, token);
      if (existingSecrets === null) {
        console.warn(
          `[aca-spawner] Could not listSecrets to ${opContext} (values redacted on GET); ` +
            `aborting to avoid clobbering existing secrets`
        );
        return false;
      }

      const nextSecrets = transform(existingSecrets);
      if (nextSecrets === null) {
        // Transform decided nothing needs to change.
        return true;
      }

      // ── PATCH with optimistic concurrency (If-Match) ─────────────────
      const patchHeaders: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      if (etag) {
        patchHeaders["If-Match"] = etag;
      }

      const patchResponse = await fetch(jobUrl, {
        method: "PATCH",
        headers: patchHeaders,
        body: JSON.stringify({
          properties: { configuration: { secrets: nextSecrets } },
        }),
      });

      if (patchResponse.ok) {
        return true;
      }

      // 412 Precondition Failed → another writer updated the list between our
      // GET and PATCH. Re-read and retry with fresh state.
      if (patchResponse.status === 412 && attempt < SECRET_MUTATION_MAX_ATTEMPTS) {
        continue;
      }

      const errorText = await patchResponse.text();
      console.warn(
        `[aca-spawner] Failed to ${opContext} (HTTP ${patchResponse.status}): ${errorText.slice(0, 200)}`
      );
      return false;
    }

    console.warn(
      `[aca-spawner] Gave up trying to ${opContext} after ${SECRET_MUTATION_MAX_ATTEMPTS} ETag-conflict retries`
    );
    return false;
  });
}

/**
 * Register/merge session-scoped secrets into the job's `configuration.secrets`.
 *
 * Azure Container Apps Jobs require the *full* secrets list on every PATCH — it
 * replaces the existing list entirely. We therefore merge onto the current list
 * (preserving e.g. the ACR password added by Bicep) inside an atomic
 * read-modify-write (see {@link mutateJobSecrets}) so concurrent sessions don't
 * clobber each other's entries.
 *
 * Note: PATCHing `configuration.secrets` requires `Microsoft.App/jobs/write`,
 * which the built-in "Container Apps Jobs Operator" role does NOT grant. The
 * orchestrator's managed identity therefore needs a role that includes
 * `jobs/write` — see `infra/modules/worker-job.bicep`, which assigns
 * "Contributor" scoped to this single job for exactly this reason.
 *
 * Returns `true` if the merge PATCH succeeded, `false` otherwise (GET/listSecrets
 * failure, PATCH failure, or exhausted 412 retries). Callers MUST check this and
 * refuse to start the execution on `false` — otherwise the start body's
 * `secretRef` entries would dangle (point at secrets that were never registered)
 * and ACA would reject the start with an opaque "secret not found" error.
 */
async function patchJobSecrets(
  config: AcaWorkerConfig,
  token: string,
  secretsToMerge: AcaJobSecret[]
): Promise<boolean> {
  return mutateJobSecrets(
    config,
    token,
    (existingSecrets) => {
      // Merge: new entries override any existing entry with the same name.
      const mergedSecretMap = new Map<string, AcaJobSecret>();
      for (const s of existingSecrets) {
        mergedSecretMap.set(s.name, s);
      }
      for (const s of secretsToMerge) {
        mergedSecretMap.set(s.name, s);
      }
      return Array.from(mergedSecretMap.values());
    },
    "patch job secrets"
  );
}

/**
 * Remove session-scoped secrets from the job after the execution has completed.
 *
 * ACA secrets can only be removed by PATCHing the full list without them — there
 * is no single-secret delete endpoint. We omit this session's entries from the
 * next PATCH. This runs inside the same atomic read-modify-write as
 * registration (see {@link mutateJobSecrets}), so a stop that overlaps another
 * session's start cannot clobber that session's live secrets.
 *
 * Best-effort: failures are logged but do not throw, since the execution is
 * already done and missing cleanup is preferable to an unhandled rejection here.
 */
async function removeSessionSecrets(
  config: AcaWorkerConfig,
  token: string,
  sessionId: number
): Promise<void> {
  const sessionSuffix = `-sess-${sessionId}`;
  await mutateJobSecrets(
    config,
    token,
    (existingSecrets) => {
      const filteredSecrets = existingSecrets.filter((s) => !s.name.endsWith(sessionSuffix));
      if (filteredSecrets.length === existingSecrets.length) {
        // Nothing to remove — already cleaned up or never registered.
        return null;
      }
      return filteredSecrets;
    },
    `remove session ${sessionId} secrets`
  );
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
 * identity lacks a role granting `Microsoft.App/jobs/write` on the worker job.
 * Note the built-in "Container Apps Jobs Operator" role covers start/stop but NOT
 * jobs/write, which the secret-PATCH path introduced for secretRef injection needs
 * — that's why worker-job.bicep grants "Contributor" scoped to the job. An RBAC
 * failure surfaces as HTTP 403 with code "AuthorizationFailed" and is NOT a user
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
      `managed identity lacks permission to act on the job. It needs a role that grants both ` +
      `start/stop AND \`Microsoft.App/jobs/write\` (the latter is required to PATCH the job's ` +
      `configuration.secrets for secretRef injection). The built-in "Container Apps Jobs Operator" ` +
      `role does NOT include jobs/write, so grant "Contributor" scoped to the job (least privilege — ` +
      `Contributor on one job only, not the resource group), matching infra/modules/worker-job.bicep. ` +
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
  /**
   * Persistent branch name for standalone (requiresTask=false) sessions.
   * When set, the worker checks out/creates this branch once on startup and
   * commits+pushes to it after each prompt turn — no PR, no task branching.
   */
  persistentBranchName?: string;
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
  agentConfigBase64?: string,
  /**
   * Session's stored model override (session.meta.model, e.g.
   * "claude-sonnet-4-5"). When unset/empty, kiro-cli picks its own default
   * (currently "Auto") — the worker never applies a model flag on its own.
   */
  model?: string | null,
  /**
   * Whether the create_task MCP tool should be injected into the worker.
   * Maps to the session's `createTasksEnabled` field. When false/undefined,
   * the tool is omitted regardless of AGENT_KIND.
   */
  createTasksEnabled?: boolean
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

  // ── Step 1: register session-scoped secrets on the job ─────────────────
  //
  // Sensitive values must never appear as plaintext `value` entries in the
  // per-execution env override — they would be returned verbatim by
  // `az containerapp job execution show` (and the equivalent ARM GET).
  //
  // We instead PATCH the job's configuration.secrets list with
  // session-scoped names (e.g., "kiro-api-key-sess-42") and then reference
  // them via secretRef in the execution. Session-scoped names prevent
  // collisions between concurrent sessions with different per-user creds.
  const sessionSecrets: AcaJobSecret[] = [
    { name: sessionSecretName("worker-secret", sessionId), value: config.workerSecret },
    { name: sessionSecretName("kiro-api-key", sessionId), value: kiroApiKey },
  ];

  // Add git credential secrets if they will be needed
  if (gitOptions) {
    const effectiveAdoPat = gitOptions.azureDevOpsPat || config.azureDevOpsPat;
    if (effectiveAdoPat) {
      sessionSecrets.push({ name: sessionSecretName("ado-pat", sessionId), value: effectiveAdoPat });
    }
    if (gitOptions.githubPat) {
      sessionSecrets.push({ name: sessionSecretName("github-pat", sessionId), value: gitOptions.githubPat });
    }
  }

  // Add MCP proxy sidecar credential secrets. The proxy container runs in the
  // SAME execution as the worker, so its env is returned by the same
  // `az containerapp job execution show` / ARM GET — these per-user credentials
  // (Atlassian / Azure DevOps / AWS) must be secretRef'd, not plaintext values.
  // We build the plaintext list once here (so it can be registered), and reuse
  // the same list below to emit the proxy container's secretRef env entries.
  let proxyCredEnvVars: Array<{ name: string; value: string }> = [];
  if (mcpSidecar && config.proxyImage) {
    proxyCredEnvVars = buildProxyCredentialEnvVars(mcpSidecar.credentials);
    for (const { name, value } of proxyCredEnvVars) {
      sessionSecrets.push({ name: sessionSecretName(secretBaseFromEnvName(name), sessionId), value });
    }
  }

  const registered = await patchJobSecrets(config, token, sessionSecrets);
  if (!registered) {
    // Secret registration failed (RBAC gap on Microsoft.App/jobs/write, a
    // listSecrets failure, or exhausted 412 retries). Do NOT proceed to /start:
    // the env below references these secrets via secretRef, and starting with
    // dangling refs yields an opaque "secret not found" error instead of the
    // actionable RBAC message below. Fail fast and clearly.
    throw new Error(
      `Could not register session ${sessionId} secrets on ` +
        `job "${config.jobName}" (resource group "${config.resourceGroup}", ` +
        `subscription ${config.subscriptionId}) before starting the execution. ` +
        `This is typically an Azure RBAC problem: the orchestrator's managed identity ` +
        `lacks \`Microsoft.App/jobs/write\` (required to PATCH the job's configuration.secrets ` +
        `for secretRef injection). The built-in "Container Apps Jobs Operator" role does NOT ` +
        `include jobs/write — grant "Contributor" scoped to the job, matching ` +
        `infra/modules/worker-job.bicep. The execution was NOT started.`
    );
  }

  // ── Step 2: build env vars — sensitive ones use secretRef ───────────────

  // Helper: build a secretRef env var entry
  function secretEnv(envName: string, secretBase: string): EnvironmentVar {
    return { name: envName, secretRef: sessionSecretName(secretBase, sessionId) };
  }

  const envVars: EnvironmentVar[] = [
    { name: "SESSION_ID", value: String(sessionId) },
    { name: "ORCHESTRATOR_URL", value: config.orchestratorUrl },
    secretEnv("WORKER_SECRET", "worker-secret"),
    secretEnv("KIRO_API_KEY", "kiro-api-key"),
    { name: "AGENT_NAME", value: agentName },
    { name: "AGENT_KIND", value: agentKind || "editor" },
    { name: "GIT_USER_NAME", value: config.gitUserName },
    { name: "GIT_USER_EMAIL", value: config.gitUserEmail },
    { name: "TIMEOUT_SECONDS", value: String(timeoutSeconds || 900) },
  ];

  if (agentConfigBase64) {
    envVars.push({ name: "AGENT_CONFIG_JSON_B64", value: agentConfigBase64 });
  }

  if (model) {
    envVars.push({ name: "MODEL", value: model });
  }

  if (createTasksEnabled) {
    envVars.push({ name: "TASK_CREATE_ENABLED", value: "true" });
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
    if (gitOptions.persistentBranchName) {
      envVars.push({ name: "PERSISTENT_BRANCH_NAME", value: gitOptions.persistentBranchName });
    }
    // Per-user credential wins; the orchestrator-wide PAT is a fallback for
    // deployments that use a single service account for all Azure DevOps access.
    const effectiveAdoPat = gitOptions.azureDevOpsPat || config.azureDevOpsPat;
    if (effectiveAdoPat) {
      // Registered as a session secret above; reference via secretRef
      envVars.push(secretEnv("AZURE_DEVOPS_PAT", "ado-pat"));
    }
    if (gitOptions.githubPat) {
      // Registered as a session secret above; reference via secretRef
      envVars.push(secretEnv("GITHUB_PAT", "github-pat"));
    }
  }

  // Build the containers array: always includes worker, optionally includes proxy sidecar
  const containers: Array<{
    name: string;
    image: string;
    env: EnvironmentVar[];
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
    const proxyEnvVars: EnvironmentVar[] = [
      { name: "MCP_PROXY_PORT", value: "9090" },
      { name: "MCP_SERVERS_JSON_B64", value: encodeServersConfigBase64(mcpSidecar.serversConfig) },
    ];

    // Inject credential env vars into the proxy container so spawned MCP servers
    // inherit them (some servers read credentials from the process environment).
    // These reference the session-scoped secrets registered above via secretRef,
    // never plaintext values — otherwise they'd leak in execution metadata.
    for (const { name } of proxyCredEnvVars) {
      proxyEnvVars.push(secretEnv(name, secretBaseFromEnvName(name)));
    }

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

  // ── Step 3: start the execution ─────────────────────────────────────────
  //
  // The session secrets are already registered on the job at this point. If the
  // start POST fails (or anything between here and a successful start throws),
  // those secrets — including a live GitHub/ADO PAT and KIRO_API_KEY — would be
  // left resident in the job's configuration.secrets indefinitely. Nothing else
  // cleans them up on this path: the session-manager only removes secrets via
  // stopWorkerJob, which it invokes only once an execution name is set (i.e.
  // after this function returns successfully). That both re-opens the credential
  // exposure this task set out to close and, over many failed starts, can exhaust
  // ACA's per-resource secret cap. So on any failure we remove the just-registered
  // session secrets (best-effort) before re-throwing the original error.
  let result: { name?: string; properties?: { status?: string } };
  try {
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

    result = (await response.json()) as {
      name?: string;
      properties?: { status?: string };
    };
  } catch (err) {
    // Best-effort cleanup of the orphaned session secrets. Never let a cleanup
    // failure mask the original start error — swallow it (removeSessionSecrets
    // already logs its own warnings) and re-throw what actually went wrong.
    try {
      await removeSessionSecrets(config, token, sessionId);
    } catch {
      /* best effort — the start error below is what matters */
    }
    throw err;
  }

  return {
    executionName: result.name || `${config.jobName}-${sessionId}`,
    status: result.properties?.status || "Running",
  };
}

/**
 * Stop/cancel a running ACA Job execution and clean up its session-scoped secrets.
 *
 * DELETE /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/jobs/{job}/executions/{exec}/stop
 *
 * When `sessionId` is provided, the session-scoped secrets registered by
 * startWorkerJob (see "Secret handling" in the module doc) are removed from
 * the job's configuration.secrets list after the execution is stopped. This
 * is best-effort — a cleanup failure never throws.
 */
export async function stopWorkerJob(
  config: AcaWorkerConfig,
  executionName: string,
  sessionId?: number
): Promise<void> {
  const token = await getAzureAccessToken();
  const apiVersion = "2024-03-01";
  // There is no "delete a job execution" operation in the Container Apps Jobs
  // API — executions are terminated via a dedicated `stop` action, not a
  // generic DELETE. A DELETE on this path 403s even for a fully-privileged
  // identity because `Microsoft.App/jobs/executions/delete` isn't a real
  // permission (jobs/executions only exposes `read`); the actual permission
  // this needs is `Microsoft.App/jobs/stop/execution/action`, which is covered
  // by the "Contributor" role scoped to this job that worker-job.bicep assigns
  // to this identity (it's also covered by "Container Apps Jobs Operator", but
  // that role lacks the jobs/write the secret-PATCH path needs). See:
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

  // Clean up session-scoped secrets after stopping (best-effort)
  if (sessionId !== undefined) {
    try {
      await removeSessionSecrets(config, token, sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[aca-spawner] Failed to clean up session ${sessionId} secrets: ${msg}`);
    }
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
 * Performs a GET on the job resource, which requires `Microsoft.App/jobs/read`.
 * A success confirms the identity can reach and read the job, surfacing an RBAC
 * or identity misconfiguration at boot instead of at the first "start session"
 * click. Note it does NOT prove the identity has `Microsoft.App/jobs/write` —
 * the permission the secret-PATCH path needs — since read is a strictly weaker
 * grant; a write-only RBAC gap would still only surface at first start.
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
