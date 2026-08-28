/**
 * Tests for the WSL health-check self-healing retry logic in
 * wsl-worker-spawner.ts's ensureDistroHealthy(). Focused on:
 *   - precise failure classification (distinct causes get distinct handling)
 *   - the retry is only attempted for the "docker-not-responding" cause
 *   - a successful retry recovers without throwing
 *   - a failed retry still throws, with an error message reflecting the retry happened
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// execFile is used via promisify(execFile) in the module under test — mock
// the callback-style node:child_process API so promisify's wrapping behaves
// normally on top of it.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { startWorkerJob, type WslWorkerConfig } from "./wsl-worker-spawner.js";
import { getUserKiroApiKey } from "./db/users.js";

vi.mock("./db/users.js", () => ({
  getUserKiroApiKey: vi.fn().mockResolvedValue("fake-kiro-api-key"),
}));

vi.mock("./logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  toErrorFields: (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
}));

const execFileMock = vi.mocked(execFile);

/** Simulate a callback-style execFile invocation resolving or rejecting. */
function mockExecFileImplementation(
  handler: (file: string, args: string[]) => { stdout?: string; stderr?: string; error?: Error }
) {
  execFileMock.mockImplementation(((file: string, args: unknown, _opts: unknown, cb: unknown) => {
    // execFileAsync (promisify) always calls with (file, args, options, callback)
    // in this module's usage — options is always passed.
    const callback = cb as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
    const result = handler(file, args as string[]);
    if (result.error) {
      callback(result.error);
    } else {
      callback(null, { stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
    }
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

const baseConfig: WslWorkerConfig = {
  distroName: "kirofactory-docker-test",
  workerImage: "kirofactory-worker:local",
  proxyImage: "",
  workerListenPort: 9091,
  workerSecret: "test-secret",
  gitUserName: "Test Agent",
  gitUserEmail: "agent@test.local",
  azureDevOpsPat: "",
};

describe("ensureDistroHealthy (via startWorkerJob)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserKiroApiKey).mockResolvedValue("fake-kiro-api-key");
  });

  it("does not retry when wsl.exe is not installed — fails fast with an actionable message", async () => {
    mockExecFileImplementation((file) => {
      if (file === "powershell.exe") {
        return { error: new Error("'wsl.exe' is not recognized as an internal or external command") };
      }
      return { error: new Error("should not reach wsl.exe --shutdown for this cause") };
    });

    await expect(
      startWorkerJob(baseConfig, 1, "developer-agent", 1, 900)
    ).rejects.toThrow(/WSL2 must be installed/);

    // wsl.exe --shutdown must never be invoked for this cause.
    const shutdownCalls = execFileMock.mock.calls.filter(([file, args]) => {
      return file === "wsl.exe" && Array.isArray(args) && args.includes("--shutdown");
    });
    expect(shutdownCalls.length).toBe(0);
  });

  it("does not retry when the distro doesn't exist — fails fast with a provisioning message", async () => {
    mockExecFileImplementation((file) => {
      if (file === "powershell.exe") {
        return { error: new Error("[setup-wsl] Distro 'kirofactory-docker-test' does not exist.") };
      }
      return { error: new Error("should not reach wsl.exe --shutdown for this cause") };
    });

    await expect(
      startWorkerJob(baseConfig, 2, "developer-agent", 1, 900)
    ).rejects.toThrow(/does not exist yet/);

    const shutdownCalls = execFileMock.mock.calls.filter(([file, args]) => {
      return file === "wsl.exe" && Array.isArray(args) && args.includes("--shutdown");
    });
    expect(shutdownCalls.length).toBe(0);
  });

  it("retries via 'wsl --shutdown' for 'Docker is not responding' and recovers on success", async () => {
    let healthCheckCallCount = 0;
    mockExecFileImplementation((file, args) => {
      if (file === "powershell.exe") {
        healthCheckCallCount++;
        if (healthCheckCallCount === 1) {
          return { error: new Error("[setup-wsl] Distro 'kirofactory-docker-test' exists but Docker is not responding.") };
        }
        return { stdout: "[setup-wsl] Distro exists and Docker is healthy." };
      }
      if (file === "wsl.exe" && args.includes("--shutdown")) {
        return { stdout: "" };
      }
      if (file === "wsl.exe") {
        // docker network create / docker run / docker port calls after recovery
        return { stdout: "0.0.0.0:54321\n" };
      }
      return { error: new Error(`Unexpected exec: ${file} ${args.join(" ")}`) };
    });

    const result = await startWorkerJob(baseConfig, 3, "developer-agent", 1, 900);
    expect(result.status).toBe("Running");
    expect(healthCheckCallCount).toBe(2);

    const shutdownCalls = execFileMock.mock.calls.filter(([file, args]) => {
      return file === "wsl.exe" && Array.isArray(args) && args.includes("--shutdown");
    });
    expect(shutdownCalls.length).toBe(1);
  }, 10_000);

  it("retries via 'wsl --shutdown' for 'Docker is not responding' but still throws if the retry also fails", async () => {
    mockExecFileImplementation((file, args) => {
      if (file === "powershell.exe") {
        return { error: new Error("[setup-wsl] Distro 'kirofactory-docker-test' exists but Docker is not responding.") };
      }
      if (file === "wsl.exe" && args.includes("--shutdown")) {
        return { stdout: "" };
      }
      return { error: new Error(`Unexpected exec: ${file} ${args.join(" ")}`) };
    });

    await expect(
      startWorkerJob(baseConfig, 4, "developer-agent", 1, 900)
    ).rejects.toThrow(/even after an automatic 'wsl --shutdown' \+ retry/);
  }, 10_000);
});
