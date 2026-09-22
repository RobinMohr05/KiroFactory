/**
 * Tests for aca-worker-spawner.ts — ACA Job execution start behavior.
 *
 * Focused on the secret injection contract: WORKER_SECRET must be passed via
 * `secretRef` (referencing the job-level "worker-secret" secret defined in
 * worker-job.bicep) rather than as a plaintext `value` field. Plaintext value
 * fields are visible in `az containerapp job execution show` and the Azure
 * Portal to anyone with Reader RBAC on the job — a secretRef keeps the value
 * opaque in the execution manifest.
 *
 * Per-user dynamic secrets (KIRO_API_KEY, GITHUB_PAT, AZURE_DEVOPS_PAT) cannot
 * use secretRef today (per-execution secretRef is only valid for secrets already
 * defined on the job, and per-user values are not known at deploy time), so
 * those tests document the current limitation without testing for a change that
 * isn't implemented yet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AcaWorkerConfig } from "./aca-worker-spawner.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./db/users.js", () => ({
  getUserKiroApiKey: vi.fn().mockResolvedValue("test-kiro-api-key"),
}));

vi.mock("./logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  toErrorFields: (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
}));

// Mock @azure/identity as a static module (vi.mock is hoisted and applies to
// static imports, but getAzureAccessToken uses a dynamic import to avoid
// requiring the package at module load time). Vitest's module mocking intercepts
// both static and dynamic imports of the same specifier, so this works.
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class MockDefaultAzureCredential {
    getToken() {
      return Promise.resolve({ token: "fake-azure-token" });
    }
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const baseConfig: AcaWorkerConfig = {
  subscriptionId: "sub-123",
  resourceGroup: "rg-test",
  jobName: "kirofactory-worker",
  workerImage: "kirofactory.azurecr.io/kirofactory-worker:latest",
  proxyImage: "",
  orchestratorUrl: "wss://kirofactory-api.example.com/internal/worker",
  workerSecret: "super-secret-worker-token",
  gitUserName: "Test Agent",
  gitUserEmail: "agent@test.local",
  azureDevOpsPat: "",
};

/** Request body captured from the intercepted fetch calls. */
interface CapturedRequest {
  url: string;
  body: unknown;
}

/**
 * Install a mock fetch that captures request bodies and returns a successful
 * ACA job execution start response. Returns the captured bodies array.
 */
function installFetchMock(): CapturedRequest[] {
  const capturedBodies: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : (url as Request).url;
    let parsedBody: unknown = null;
    if (init?.body && typeof init.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    capturedBodies.push({ url: urlStr, body: parsedBody });

    return new Response(
      JSON.stringify({
        name: "kirofactory-worker-12345",
        properties: { status: "Running" },
      }),
      { status: 202 }
    );
  }) as unknown as typeof fetch;
  return capturedBodies;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startWorkerJob — secret injection contract", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedBodies: CapturedRequest[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedBodies = installFetchMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("passes WORKER_SECRET via secretRef, not as a plaintext value", async () => {
    const { startWorkerJob } = await import("./aca-worker-spawner.js");

    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    const startRequest = capturedBodies.find(({ url }) => url.includes("/start"));
    expect(startRequest).toBeDefined();

    const body = startRequest!.body as {
      containers: Array<{
        name: string;
        env: Array<{ name: string; value?: string; secretRef?: string }>;
      }>;
    };
    const workerEnv = body.containers.find((c) => c.name === "worker")?.env ?? [];

    // WORKER_SECRET must use secretRef (referencing the job-level secret defined
    // in worker-job.bicep), not a plaintext value visible in execution detail.
    const workerSecretEntry = workerEnv.find((e) => e.name === "WORKER_SECRET");
    expect(workerSecretEntry).toBeDefined();
    expect(workerSecretEntry).not.toHaveProperty("value");
    expect(workerSecretEntry).toHaveProperty("secretRef", "worker-secret");
  });

  it("does NOT embed the raw workerSecret string in the execution start request body", async () => {
    const { startWorkerJob } = await import("./aca-worker-spawner.js");

    await startWorkerJob(baseConfig, 42, "developer-agent", 1, 900);

    const startRequest = capturedBodies.find(({ url }) => url.includes("/start"));
    expect(startRequest).toBeDefined();

    const bodyJson = JSON.stringify(startRequest!.body);
    // The actual secret value must not appear anywhere in the request body
    expect(bodyJson).not.toContain(baseConfig.workerSecret);
  });
});
