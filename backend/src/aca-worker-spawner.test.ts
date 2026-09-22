/**
 * Tests for aca-worker-spawner.ts — specifically verifying that secrets are
 * passed via secretRef (not plaintext value) in per-execution env overrides.
 *
 * Security regression guard for KF-1939: confirmed that WORKER_SECRET,
 * KIRO_API_KEY, GITHUB_PAT, and AZURE_DEVOPS_PAT were previously passed as
 * plaintext `value` entries in the ACA Job execution start body, making them
 * visible in `az containerapp job execution show`. The fix:
 *   - Registers session-scoped secrets on the job via PATCH before start
 *   - References them via `secretRef` in the per-execution container env
 *
 * These tests verify:
 * 1. The PATCH call to update job secrets fires before the start POST.
 * 2. The start body's env entries for sensitive vars use `secretRef`, not `value`.
 * 3. Non-sensitive vars (SESSION_ID, ORCHESTRATOR_URL, AGENT_NAME, etc.) still
 *    use plaintext `value`.
 * 4. The secret names used in PATCH and secretRef are session-scoped to prevent
 *    collisions between concurrent sessions.
 * 5. After stopWorkerJob, a PATCH is made to remove the session-scoped secrets.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Mock Azure Identity — we just need a token.
// The module uses dynamic import("@azure/identity") internally so we must
// mock it at the module level with vi.mock, which vitest hoists.
// NOTE: the constructor deliberately reads its getToken behavior lazily so that
// vi.clearAllMocks() (called in beforeEach) — which clears mock implementations —
// does not strand the token acquisition. Each construction returns a fresh stub
// resolving a fake token.
vi.mock("@azure/identity", () => {
  const DefaultAzureCredential = vi.fn(function (this: unknown) {
    return {
      getToken: async () => ({ token: "fake-azure-token" }),
    };
  });
  return { DefaultAzureCredential };
});

// Mock DB — per-user Kiro API key
vi.mock("./db/users.js", () => ({
  getUserKiroApiKey: vi.fn().mockResolvedValue("per-user-kiro-key"),
}));

// Mock mcp-proxy-config (not under test here)
vi.mock("./mcp-proxy-config.js", () => ({
  encodeServersConfigBase64: vi.fn().mockReturnValue("encoded-servers"),
  buildProxyCredentialEnvVars: vi.fn().mockReturnValue([]),
}));

import { getUserKiroApiKey } from "./db/users.js";
import { startWorkerJob, stopWorkerJob, type AcaWorkerConfig } from "./aca-worker-spawner.js";

/** Builds a minimal valid AcaWorkerConfig for tests. */
const baseConfig: AcaWorkerConfig = {
  subscriptionId: "sub-123",
  resourceGroup: "rg-test",
  jobName: "test-worker-job",
  workerImage: "acr.test/worker:latest",
  proxyImage: "",
  orchestratorUrl: "wss://orchestrator.test/internal/worker",
  workerSecret: "static-worker-secret",
  gitUserName: "Test Agent",
  gitUserEmail: "agent@test.local",
  azureDevOpsPat: "",
};

// ---------------------------------------------------------------------------
// Fetch mock infrastructure
// ---------------------------------------------------------------------------

type FetchCall = { method: string; url: string; body: unknown };

/** Tracks every fetch call made during a test. */
let fetchCalls: FetchCall[] = [];
/** Simulated job secrets state — updated by PATCH, returned by GET (stateful mock). */
let simulatedJobSecrets: Array<{ name: string; value: string }> = [];

function setupFetchMock() {
  fetchCalls = [];
  simulatedJobSecrets = [];

  const defaultStartOk = () =>
    new Response(
      JSON.stringify({ name: "test-worker-job-exec-1", properties: { status: "Running" } }),
      { status: 202, headers: { "Content-Type": "application/json" } }
    );

  const defaultStopOk = () => new Response(null, { status: 202 });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      let parsedBody: unknown = undefined;
      if (init?.body && typeof init.body === "string") {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }

      fetchCalls.push({ method: init?.method ?? "GET", url: String(url), body: parsedBody });

      const urlStr = String(url);

      if (urlStr.includes("/start")) return defaultStartOk();
      if (urlStr.includes("/stop")) return defaultStopOk();

      // PATCH job (for secrets management) — update simulated state
      if (init?.method === "PATCH" && !urlStr.includes("/executions/")) {
        const body = parsedBody as Record<string, unknown> | undefined;
        const newSecrets = (
          (body?.properties as Record<string, unknown>)?.configuration as Record<string, unknown>
        )?.secrets as Array<{ name: string; value: string }> | undefined;
        if (newSecrets !== undefined) {
          simulatedJobSecrets = newSecrets;
        }
        return new Response(
          JSON.stringify({
            name: "test-worker-job",
            properties: { configuration: { secrets: simulatedJobSecrets } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // GET job — return current simulated state
      if ((!init?.method || init.method === "GET") && !urlStr.includes("/executions/")) {
        return new Response(
          JSON.stringify({
            name: "test-worker-job",
            properties: { configuration: { secrets: simulatedJobSecrets } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // GET execution status
      return new Response(
        JSON.stringify({ name: "test-worker-job", properties: { status: "Running" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    })
  );
}

function getPatchCalls(): FetchCall[] {
  return fetchCalls.filter((c) => c.method === "PATCH");
}

function getStartCall(): FetchCall | undefined {
  return fetchCalls.find((c) => c.method === "POST" && c.url.includes("/start"));
}

function getStopCall(): FetchCall | undefined {
  return fetchCalls.find((c) => c.method === "POST" && c.url.includes("/stop"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aca-worker-spawner — secretRef for sensitive env vars", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserKiroApiKey).mockResolvedValue("per-user-kiro-key");
    setupFetchMock();
  });

  // ── 1. PATCH to register secrets before start ──────────────────────────

  it("issues a PATCH to add session-scoped secrets before the start POST", async () => {
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    const patches = getPatchCalls();
    expect(patches.length).toBeGreaterThanOrEqual(1);

    // PATCH must happen before the start
    const patchIdx = fetchCalls.findIndex((c) => c.method === "PATCH");
    const startIdx = fetchCalls.findIndex(
      (c) => c.method === "POST" && c.url.includes("/start")
    );
    expect(patchIdx).toBeLessThan(startIdx);
  });

  it("PATCH URL targets the job resource (not an execution-level endpoint)", async () => {
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    const patches = getPatchCalls();
    expect(patches.length).toBeGreaterThanOrEqual(1);
    for (const patch of patches) {
      expect(patch.url).toMatch(/providers\/Microsoft\.App\/jobs\/test-worker-job\?api-version=/);
      // Must NOT include /executions/ or /start
      expect(patch.url).not.toMatch(/\/executions\//);
      expect(patch.url).not.toMatch(/\/start/);
    }
  });

  it("PATCH body includes session-scoped secret entries for WORKER_SECRET and KIRO_API_KEY", async () => {
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    const patch = getPatchCalls()[0];
    const body = patch.body as Record<string, unknown>;
    const secrets = (body?.properties as Record<string, unknown>)?.configuration as Record<
      string,
      unknown
    >;
    // The PATCH body nests under properties.configuration.secrets
    const secretsArray = (
      (body?.properties as Record<string, unknown>)?.configuration as Record<string, unknown>
    )?.secrets as Array<{ name: string; value: string }> | undefined;

    expect(secretsArray).toBeDefined();
    expect(Array.isArray(secretsArray)).toBe(true);

    // Must include session-42-scoped worker-secret and kiro-api-key entries
    const names = secretsArray!.map((s) => s.name);
    expect(names.some((n) => n.includes("42") && n.toLowerCase().includes("worker-secret"))).toBe(
      true
    );
    expect(names.some((n) => n.includes("42") && n.toLowerCase().includes("kiro-api-key"))).toBe(
      true
    );
  });

  it("PATCH body sets the actual secret values (plaintext only in the PATCH, not in the execution)", async () => {
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    const patch = getPatchCalls()[0];
    const body = patch.body as Record<string, unknown>;
    const secretsArray = (
      (body?.properties as Record<string, unknown>)?.configuration as Record<string, unknown>
    )?.secrets as Array<{ name: string; value: string }> | undefined;

    expect(secretsArray).toBeDefined();
    const workerSecretEntry = secretsArray!.find(
      (s) => s.name.includes("42") && s.name.toLowerCase().includes("worker-secret")
    );
    expect(workerSecretEntry?.value).toBe("static-worker-secret");

    const kiroKeyEntry = secretsArray!.find(
      (s) => s.name.includes("42") && s.name.toLowerCase().includes("kiro-api-key")
    );
    expect(kiroKeyEntry?.value).toBe("per-user-kiro-key");
  });

  // ── 2. Execution start body must use secretRef, not plaintext value ────

  it("start body env for WORKER_SECRET uses secretRef, not plaintext value", async () => {
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    const startCall = getStartCall();
    expect(startCall).toBeDefined();

    const body = startCall!.body as Record<string, unknown>;
    const workerEnv = (body?.containers as Array<{ name: string; env: unknown[] }>)?.find(
      (c) => c.name === "worker"
    )?.env as Array<{ name: string; value?: string; secretRef?: string }> | undefined;

    expect(workerEnv).toBeDefined();

    const workerSecretEntry = workerEnv!.find((e) => e.name === "WORKER_SECRET");
    expect(workerSecretEntry).toBeDefined();
    // Must use secretRef, not plaintext value
    expect(workerSecretEntry!.secretRef).toBeDefined();
    expect(workerSecretEntry!.value).toBeUndefined();
    // The secretRef name must be session-scoped
    expect(workerSecretEntry!.secretRef).toContain("42");
  });

  it("start body env for KIRO_API_KEY uses secretRef, not plaintext value", async () => {
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    const startCall = getStartCall();
    const body = startCall!.body as Record<string, unknown>;
    const workerEnv = (body?.containers as Array<{ name: string; env: unknown[] }>)?.find(
      (c) => c.name === "worker"
    )?.env as Array<{ name: string; value?: string; secretRef?: string }> | undefined;

    const kiroKeyEntry = workerEnv!.find((e) => e.name === "KIRO_API_KEY");
    expect(kiroKeyEntry).toBeDefined();
    expect(kiroKeyEntry!.secretRef).toBeDefined();
    expect(kiroKeyEntry!.value).toBeUndefined();
    expect(kiroKeyEntry!.secretRef).toContain("42");
  });

  it("start body env for GITHUB_PAT uses secretRef when a PAT is provided", async () => {
    await startWorkerJob(
      baseConfig,
      42,
      "developer-agent",
      1,
      900,
      null, // no sidecar
      { repositoryUrl: "https://github.com/org/repo", githubPat: "ghp_test_token" }
    );

    const startCall = getStartCall();
    const body = startCall!.body as Record<string, unknown>;
    const workerEnv = (body?.containers as Array<{ name: string; env: unknown[] }>)?.find(
      (c) => c.name === "worker"
    )?.env as Array<{ name: string; value?: string; secretRef?: string }> | undefined;

    const patEntry = workerEnv!.find((e) => e.name === "GITHUB_PAT");
    expect(patEntry).toBeDefined();
    expect(patEntry!.secretRef).toBeDefined();
    expect(patEntry!.value).toBeUndefined();
    expect(patEntry!.secretRef).toContain("42");
  });

  it("start body env for AZURE_DEVOPS_PAT uses secretRef when a PAT is provided", async () => {
    await startWorkerJob(
      baseConfig,
      42,
      "developer-agent",
      1,
      900,
      null,
      { repositoryUrl: "https://dev.azure.com/org/proj/_git/repo", azureDevOpsPat: "ado-pat-abc" }
    );

    const startCall = getStartCall();
    const body = startCall!.body as Record<string, unknown>;
    const workerEnv = (body?.containers as Array<{ name: string; env: unknown[] }>)?.find(
      (c) => c.name === "worker"
    )?.env as Array<{ name: string; value?: string; secretRef?: string }> | undefined;

    const adoEntry = workerEnv!.find((e) => e.name === "AZURE_DEVOPS_PAT");
    expect(adoEntry).toBeDefined();
    expect(adoEntry!.secretRef).toBeDefined();
    expect(adoEntry!.value).toBeUndefined();
    expect(adoEntry!.secretRef).toContain("42");
  });

  // ── 3. Non-sensitive vars still use plaintext value ────────────────────

  it("non-sensitive env vars (SESSION_ID, ORCHESTRATOR_URL, AGENT_NAME) still use plaintext value", async () => {
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    const startCall = getStartCall();
    const body = startCall!.body as Record<string, unknown>;
    const workerEnv = (body?.containers as Array<{ name: string; env: unknown[] }>)?.find(
      (c) => c.name === "worker"
    )?.env as Array<{ name: string; value?: string; secretRef?: string }> | undefined;

    const sessionIdEntry = workerEnv!.find((e) => e.name === "SESSION_ID");
    expect(sessionIdEntry?.value).toBe("42");
    expect(sessionIdEntry?.secretRef).toBeUndefined();

    const orchestratorEntry = workerEnv!.find((e) => e.name === "ORCHESTRATOR_URL");
    expect(orchestratorEntry?.value).toBe("wss://orchestrator.test/internal/worker");
    expect(orchestratorEntry?.secretRef).toBeUndefined();

    const agentEntry = workerEnv!.find((e) => e.name === "AGENT_NAME");
    expect(agentEntry?.value).toBe("developer-agent");
    expect(agentEntry?.secretRef).toBeUndefined();
  });

  // ── 4. Session-scoped secret names avoid collisions ───────────────────

  it("session 42 and session 99 use different secret names (no collision)", async () => {
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);
    const firstPatchBody = getPatchCalls()[0].body as Record<string, unknown>;

    // Reset for second session (including simulated job state so they start clean)
    setupFetchMock();

    await startWorkerJob(baseConfig, 99, "developer-agent", 1, 900);
    const secondPatchBody = getPatchCalls()[0].body as Record<string, unknown>;

    const firstSecrets = (
      (firstPatchBody?.properties as Record<string, unknown>)?.configuration as Record<
        string,
        unknown
      >
    )?.secrets as Array<{ name: string }> | undefined;

    const secondSecrets = (
      (secondPatchBody?.properties as Record<string, unknown>)?.configuration as Record<
        string,
        unknown
      >
    )?.secrets as Array<{ name: string }> | undefined;

    const firstName = firstSecrets?.find(
      (s) => s.name.toLowerCase().includes("kiro-api-key")
    )?.name;
    const secondName = secondSecrets?.find(
      (s) => s.name.toLowerCase().includes("kiro-api-key")
    )?.name;

    expect(firstName).toBeDefined();
    expect(secondName).toBeDefined();
    expect(firstName).not.toBe(secondName);

    // Both reference their own session IDs
    expect(firstName).toContain("42");
    expect(secondName).toContain("99");
  });

  // ── 5. Secret cleanup after stop ──────────────────────────────────────

  it("stopWorkerJob issues a PATCH to remove session-scoped secrets after stopping", async () => {
    // Start first to register secrets
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);
    const afterStartPatchCount = getPatchCalls().length;

    // Clear calls, then stop
    fetchCalls = [];
    await stopWorkerJob(baseConfig, "test-exec-42", 42);

    const cleanupPatches = getPatchCalls();
    expect(cleanupPatches.length).toBeGreaterThanOrEqual(1);

    // Cleanup PATCH body should remove the session-42 secrets (e.g., by omitting them or
    // explicitly sending an empty/null value). At minimum, the PATCH must target the job
    // resource and include a secrets array that no longer contains session-42 secrets with
    // their real values.
    const cleanupPatch = cleanupPatches[0];
    expect(cleanupPatch.url).toMatch(/providers\/Microsoft\.App\/jobs\/test-worker-job/);
  });

  // ── 6. Org-level static worker secret in config is also handled ───────

  it("org-level AZURE_DEVOPS_PAT from config (not per-user) uses secretRef", async () => {
    const configWithAdoPat: AcaWorkerConfig = {
      ...baseConfig,
      azureDevOpsPat: "org-level-ado-pat",
    };
    await startWorkerJob(
      configWithAdoPat,
      42,
      "developer-agent",
      1,
      900,
      null,
      { repositoryUrl: "https://dev.azure.com/org/proj/_git/repo" }
    );

    // The PATCH should include a secret for the org-level ADO PAT
    const patch = getPatchCalls()[0];
    const secretsArray = (
      (patch.body as Record<string, unknown>)?.properties as Record<string, unknown>
    )?.configuration as Record<string, unknown>;
    const secrets = (secretsArray)?.secrets as Array<{ name: string; value: string }> | undefined;

    const adoEntry = secrets?.find(
      (s) => s.name.includes("42") && s.name.toLowerCase().includes("ado")
    );
    expect(adoEntry).toBeDefined();
    expect(adoEntry?.value).toBe("org-level-ado-pat");

    // And the start body should use secretRef
    const startCall = getStartCall();
    const workerEnv = ((startCall!.body as Record<string, unknown>)?.containers as Array<{
      name: string;
      env: Array<{ name: string; value?: string; secretRef?: string }>;
    }>)?.find((c) => c.name === "worker")?.env;

    const adoPatEntry = workerEnv?.find((e) => e.name === "AZURE_DEVOPS_PAT");
    expect(adoPatEntry?.secretRef).toBeDefined();
    expect(adoPatEntry?.value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Concurrency: no read-modify-write clobbering of the shared secrets list
// ---------------------------------------------------------------------------
//
// Regression guard for the KF-1939 PR review: patchJobSecrets / removeSessionSecrets
// do GET-full-list → merge in memory → PATCH-full-list against the SAME job resource.
// The autoscaler runs a pool of concurrent worker sessions, so multiple startWorkerJob
// calls hit that shared list simultaneously. Without serialization (in-process mutex)
// and/or ARM optimistic concurrency (If-Match ETag + retry-on-412), a losing writer
// merges onto a stale snapshot and silently drops the other session's secrets — whose
// secretRef then dangles and the execution start fails / the worker boots without creds.

describe("aca-worker-spawner — concurrent secret PATCHes must not clobber each other", () => {
  /**
   * ARM-like stateful fetch mock with optimistic-concurrency semantics:
   * - GET returns the current secrets list plus an ETag; the GET response is
   *   deliberately delayed a tick so two concurrent callers both observe the
   *   SAME initial snapshot (this is what forces the interleaving).
   * - PATCH enforces If-Match: if the caller's ETag is stale, respond 412 and do
   *   NOT mutate state. On match, replace the list and bump the ETag.
   */
  function setupConcurrentFetchMock() {
    fetchCalls = [];
    let secretsState: Array<{ name: string; value: string }> = [];
    let etag = 'W/"0"';

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        let parsedBody: unknown = undefined;
        if (init?.body && typeof init.body === "string") {
          try {
            parsedBody = JSON.parse(init.body);
          } catch {
            parsedBody = init.body;
          }
        }
        fetchCalls.push({ method: init?.method ?? "GET", url: String(url), body: parsedBody });

        const urlStr = String(url);
        if (urlStr.includes("/start"))
          return new Response(
            JSON.stringify({ name: "exec", properties: { status: "Running" } }),
            { status: 202, headers: { "Content-Type": "application/json" } }
          );
        if (urlStr.includes("/stop")) return new Response(null, { status: 202 });

        const isJobLevel = !urlStr.includes("/executions/");

        // PATCH secrets — enforce If-Match optimistic concurrency
        if (init?.method === "PATCH" && isJobLevel) {
          const ifMatch = (init.headers as Record<string, string> | undefined)?.["If-Match"];
          if (ifMatch !== undefined && ifMatch !== etag) {
            return new Response(
              JSON.stringify({ error: { code: "PreconditionFailed" } }),
              { status: 412, headers: { "Content-Type": "application/json" } }
            );
          }
          const body = parsedBody as Record<string, unknown> | undefined;
          const newSecrets = (
            (body?.properties as Record<string, unknown>)?.configuration as Record<string, unknown>
          )?.secrets as Array<{ name: string; value: string }> | undefined;
          if (newSecrets !== undefined) {
            secretsState = newSecrets;
            etag = `W/"${Number(etag.match(/\d+/)?.[0] ?? 0) + 1}"`;
          }
          return new Response(
            JSON.stringify({
              name: "job",
              properties: { configuration: { secrets: secretsState } },
            }),
            { status: 200, headers: { "Content-Type": "application/json", ETag: etag } }
          );
        }

        // GET job — snapshot the list NOW (at request time), then delay before
        // returning it. A later-launched caller whose GET fires while an earlier
        // caller's PATCH has not yet landed therefore receives the SAME stale
        // snapshot — exactly the read-modify-write window the race exploits.
        if ((!init?.method || init.method === "GET") && isJobLevel) {
          const snapshot = secretsState;
          const snapshotEtag = etag;
          await new Promise((r) => setTimeout(r, 50));
          return new Response(
            JSON.stringify({
              name: "job",
              properties: { configuration: { secrets: snapshot } },
            }),
            { status: 200, headers: { "Content-Type": "application/json", ETag: snapshotEtag } }
          );
        }

        return new Response(
          JSON.stringify({ name: "job", properties: { status: "Running" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    return { getState: () => secretsState };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserKiroApiKey).mockResolvedValue("per-user-kiro-key");
  });

  /**
   * Launch several startWorkerJob (or arbitrary) operations that OVERLAP in
   * their GET→PATCH secret work, without their `await import("@azure/identity")`
   * calls colliding.
   *
   * Why the stagger: vitest's module-mock registry can hand back the *real*
   * module when the SAME mocked module is dynamically imported by two in-flight
   * async operations at the exact same time — a test-harness artifact unrelated
   * to the secrets-list race under test. A small real-time stagger lets each
   * operation's import + token acquisition resolve before the next starts, while
   * the 50ms GET delay guarantees their secret GET/PATCH windows still overlap
   * (so the race we care about is still exercised).
   */
  async function launchOverlapping(ops: Array<() => Promise<unknown>>): Promise<void> {
    const inflight: Array<Promise<unknown>> = [];
    for (const op of ops) {
      inflight.push(op());
      // Give this op's dynamic import + token acquisition a chance to settle
      // before the next op starts its own import.
      await new Promise((r) => setTimeout(r, 10));
    }
    await Promise.all(inflight);
  }

  it("two concurrent startWorkerJob calls both keep their own secrets on the job", async () => {
    const mock = setupConcurrentFetchMock();

    // Start two sessions whose secret GET/PATCH windows overlap — the classic
    // interleaving that a stale-snapshot merge would clobber.
    await launchOverlapping([
      () => startWorkerJob(baseConfig, 42, "developer-agent", 1, 900),
      () => startWorkerJob(baseConfig, 99, "developer-agent", 1, 900),
    ]);

    const names = mock.getState().map((s) => s.name);

    // Both sessions' worker-secret and kiro-api-key entries must survive — neither
    // session may have been clobbered by the other's stale-snapshot PATCH.
    expect(names).toContain(sessionScoped("worker-secret", 42));
    expect(names).toContain(sessionScoped("kiro-api-key", 42));
    expect(names).toContain(sessionScoped("worker-secret", 99));
    expect(names).toContain(sessionScoped("kiro-api-key", 99));
  });

  it("start body secretRefs still resolve to secrets present on the job after concurrent starts", async () => {
    const mock = setupConcurrentFetchMock();

    await launchOverlapping([
      () => startWorkerJob(baseConfig, 42, "developer-agent", 1, 900),
      () => startWorkerJob(baseConfig, 99, "developer-agent", 1, 900),
    ]);

    const finalSecretNames = new Set(mock.getState().map((s) => s.name));

    // Every secretRef referenced in a start body must exist in the final list.
    const startBodies = fetchCalls
      .filter((c) => c.method === "POST" && c.url.includes("/start"))
      .map((c) => c.body as Record<string, unknown>);
    expect(startBodies.length).toBe(2);

    for (const body of startBodies) {
      const workerEnv = (body?.containers as Array<{ name: string; env: unknown[] }>)?.find(
        (c) => c.name === "worker"
      )?.env as Array<{ name: string; secretRef?: string }> | undefined;
      const refs = (workerEnv ?? [])
        .map((e) => e.secretRef)
        .filter((r): r is string => typeof r === "string");
      for (const ref of refs) {
        expect(finalSecretNames.has(ref)).toBe(true);
      }
    }
  });

  it("stop after concurrent starts removes only the stopped session's secrets, keeping the other's", async () => {
    const mock = setupConcurrentFetchMock();

    await launchOverlapping([
      () => startWorkerJob(baseConfig, 42, "developer-agent", 1, 900),
      () => startWorkerJob(baseConfig, 99, "developer-agent", 1, 900),
    ]);

    // Stop 42 while another session's secret work overlaps — the removal must
    // not clobber session 99's or 77's live secrets.
    await launchOverlapping([
      () => stopWorkerJob(baseConfig, "exec-42", 42),
      () => startWorkerJob(baseConfig, 77, "developer-agent", 1, 900),
    ]);

    const names = mock.getState().map((s) => s.name);
    // 42 removed
    expect(names).not.toContain(sessionScoped("worker-secret", 42));
    expect(names).not.toContain(sessionScoped("kiro-api-key", 42));
    // 99 and 77 preserved
    expect(names).toContain(sessionScoped("worker-secret", 99));
    expect(names).toContain(sessionScoped("worker-secret", 77));
  });
});

/** Mirror of the module's internal sessionSecretName for test assertions. */
function sessionScoped(base: string, sessionId: number): string {
  return `${base}-sess-${sessionId}`;
}
