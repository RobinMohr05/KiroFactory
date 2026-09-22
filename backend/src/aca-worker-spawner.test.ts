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

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Azure Identity — we just need a token.
// The module uses dynamic import("@azure/identity") internally so we must
// mock it at the module level with vi.mock, which vitest hoists.
//
// Use a plain class (not vi.fn().mockImplementation) so the token stub survives
// vi.clearAllMocks() in every describe's beforeEach and behaves deterministically
// even when two startWorkerJob flows acquire a token concurrently (Promise.all).
vi.mock("@azure/identity", () => {
  class DefaultAzureCredential {
    async getToken() {
      return { token: "fake-azure-token" };
    }
  }
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
// Concurrency: the job's shared configuration.secrets list must not be
// clobbered when multiple sessions start (or stop) at the same time.
//
// Regression guard for the KF-1939 review follow-up: patchJobSecrets and
// removeSessionSecrets do GET-merge-PATCH against the *same* job resource. The
// autoscaler runs a pool of concurrent worker sessions, so two startWorkerJob
// calls race against the one job. Without serialization, both read the same
// snapshot, then the second PATCH overwrites the first session's just-added
// secrets — so its secretRef points at a secret that no longer exists.
//
// These tests use a fetch mock whose GET resolves on a deferred microtask,
// which deterministically interleaves the two flows (both would GET the shared
// list before either PATCHes, if the flows were allowed to run concurrently).
// ---------------------------------------------------------------------------

describe("aca-worker-spawner — concurrent secret PATCHes do not clobber each other", () => {
  /** The single shared secrets list, as the real ACA job would hold it. */
  let sharedSecrets: Array<{ name: string; value: string }> = [];
  let concurrentFetchCalls: FetchCall[] = [];
  /**
   * Barrier: how many GETs must be in flight before any GET resolves. Set to 2
   * to force the two racing flows to BOTH read the pre-PATCH snapshot before
   * either can PATCH — a deterministic reproduction of the read-modify-write
   * race, independent of wall-clock timing.
   */
  let getBarrierSize = 1;

  /**
   * Fetch mock that models one shared job resource. The GET response is gated on
   * a party barrier so concurrent flows deterministically observe the same
   * pre-PATCH snapshot when getBarrierSize > 1 (see above).
   */
  function setupRaceFetchMock() {
    sharedSecrets = [];
    concurrentFetchCalls = [];
    let pendingGets: Array<() => void> = [];

    const arriveAtBarrier = (): Promise<void> =>
      new Promise<void>((resolve) => {
        pendingGets.push(resolve);
        const release = () => {
          if (pendingGets.length === 0) return;
          const toRelease = pendingGets;
          pendingGets = [];
          for (const r of toRelease) r();
        };
        if (pendingGets.length >= getBarrierSize) {
          release();
        } else {
          // Fallback: don't deadlock if the expected number of concurrent GETs
          // never materialises — release shortly after the first arrival.
          setTimeout(release, 50);
        }
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const urlStr = String(url);
        let parsedBody: unknown = undefined;
        if (init?.body && typeof init.body === "string") {
          try {
            parsedBody = JSON.parse(init.body);
          } catch {
            parsedBody = init.body;
          }
        }
        concurrentFetchCalls.push({ method: init?.method ?? "GET", url: urlStr, body: parsedBody });

        if (urlStr.includes("/start")) {
          return new Response(
            JSON.stringify({ name: "exec-1", properties: { status: "Running" } }),
            { status: 202, headers: { "Content-Type": "application/json" } }
          );
        }

        // PATCH job secrets — replaces the shared list entirely (as ACA does).
        if (init?.method === "PATCH" && !urlStr.includes("/executions/")) {
          const newSecrets = (
            ((parsedBody as Record<string, unknown>)?.properties as Record<string, unknown>)
              ?.configuration as Record<string, unknown>
          )?.secrets as Array<{ name: string; value: string }> | undefined;
          if (newSecrets !== undefined) sharedSecrets = newSecrets;
          return new Response(
            JSON.stringify({ properties: { configuration: { secrets: sharedSecrets } } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // GET job — gate on the barrier so racing flows read the same snapshot.
        if ((!init?.method || init.method === "GET") && !urlStr.includes("/executions/")) {
          await arriveAtBarrier();
          const snapshot = [...sharedSecrets];
          return new Response(
            JSON.stringify({ properties: { configuration: { secrets: snapshot } } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(JSON.stringify({ properties: { status: "Running" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserKiroApiKey).mockResolvedValue("per-user-kiro-key");
    getBarrierSize = 1;
    setupRaceFetchMock();
  });

  it("two concurrent startWorkerJob calls both leave their secrets on the job", async () => {
    // Both flows must read the shared secrets list before either writes it back:
    // the 2-party GET barrier guarantees that interleaving deterministically.
    getBarrierSize = 2;

    await Promise.all([
      startWorkerJob(baseConfig, 42, "developer-agent", 1, 900),
      startWorkerJob(baseConfig, 99, "developer-agent", 1, 900),
    ]);

    const names = sharedSecrets.map((s) => s.name);

    // Both sessions' secrets must survive — neither may have been clobbered.
    expect(names).toContain(sessionName("worker-secret", 42));
    expect(names).toContain(sessionName("kiro-api-key", 42));
    expect(names).toContain(sessionName("worker-secret", 99));
    expect(names).toContain(sessionName("kiro-api-key", 99));
  });

  it("a concurrent stop does not clobber another live session's secrets", async () => {
    // Session 42 is already running with its secrets registered (single GET, so
    // barrier size stays 1 for this warm-up call).
    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    // Now a start (session 99) and a stop (session 42) race: both GET the shared
    // list, then each PATCHes. The 2-party barrier forces the interleave.
    getBarrierSize = 2;
    await Promise.all([
      startWorkerJob(baseConfig, 99, "developer-agent", 1, 900),
      stopWorkerJob(baseConfig, "exec-42", 42),
    ]);

    const names = sharedSecrets.map((s) => s.name);

    // Session 42's secrets should be gone (it stopped)...
    expect(names).not.toContain(sessionName("worker-secret", 42));
    // ...but session 99's must NOT have been clobbered by the stop's PATCH.
    expect(names).toContain(sessionName("worker-secret", 99));
    expect(names).toContain(sessionName("kiro-api-key", 99));
  });
});

/** Local mirror of the module's session-scoped secret naming for assertions. */
function sessionName(base: string, sessionId: number): string {
  return `${base}-sess-${sessionId}`;
}
