/**
 * Tests for the models API route (GET /api/models).
 *
 * Verifies:
 * - Successful detection maps ACP ModelInfo -> { id, name, description }
 * - The successfully detected list is cached for the process lifetime
 *   (a second request does not re-run detection)
 * - Detection failure (missing binary / ACP error / timeout) returns the
 *   auto-only fallback ({ default: "auto", models: [] }) with a 200, and does
 *   NOT populate the cache (a later request can recover)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock the KiroRunner so we can control the detected model state without
// actually spawning kiro-cli.
const createMock = vi.fn();
vi.mock("../agent/kiro-runner.js", () => ({
  KiroRunner: {
    create: (...args: unknown[]) => createMock(...args),
  },
}));

// Mock auth middleware to inject a userId (route is auth-protected).
vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  getUserId: vi.fn().mockReturnValue(1),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { log } from "../logger.js";

// Import fresh per test so the in-memory cache doesn't leak across cases.
async function freshApp() {
  vi.resetModules();
  const mod = await import("./models.js");
  const app = express();
  app.use("/api/models", mod.default);
  return app;
}

function makeRunner(availableModels: Array<{ modelId: string; name: string; description?: string | null }>) {
  return {
    availableModels,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("GET /api/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps ACP ModelInfo -> { id, name, description } on successful detection", async () => {
    createMock.mockResolvedValue(
      makeRunner([
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4", description: "Balanced" },
        { modelId: "claude-opus-5", name: "Claude Opus 5" },
      ])
    );

    const app = await freshApp();
    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body.default).toBe("auto");
    expect(res.body.models).toEqual([
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", description: "Balanced" },
      { id: "claude-opus-5", name: "Claude Opus 5", description: null },
    ]);
  });

  it("caches a successful detection for the process lifetime", async () => {
    const runner = makeRunner([{ modelId: "m1", name: "Model One" }]);
    createMock.mockResolvedValue(runner);

    const app = await freshApp();
    const first = await request(app).get("/api/models");
    const second = await request(app).get("/api/models");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.models).toEqual([{ id: "m1", name: "Model One", description: null }]);
    // Detection ran only once — the second request served the cache.
    expect(createMock).toHaveBeenCalledTimes(1);
    // The runner is closed exactly once when it wins the race — the timeout
    // reaper must not double-close it.
    await new Promise((r) => setImmediate(r));
    expect(runner.close).toHaveBeenCalledTimes(1);
  });

  it("returns the auto-only fallback and does NOT cache on detection failure", async () => {
    createMock.mockRejectedValue(new Error("kiro-cli not found on PATH"));

    const app = await freshApp();
    const first = await request(app).get("/api/models");

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ default: "auto", models: [] });
    expect(log.error).toHaveBeenCalled();

    // A later request must retry detection (nothing cached). Make it succeed
    // this time to prove the failure wasn't cached.
    createMock.mockResolvedValueOnce(makeRunner([{ modelId: "m1", name: "Model One" }]));
    const second = await request(app).get("/api/models");

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(second.body.models).toEqual([{ id: "m1", name: "Model One", description: null }]);
  });

  it("closes a runner that resolves after the detection timeout has already won", async () => {
    // Force a very short detection timeout so the race resolves deterministically
    // in real time without waiting the full 20s. Read at module-eval time, so it
    // must be set before freshApp() re-imports the module.
    const prev = process.env.MODEL_DETECTION_TIMEOUT_MS;
    process.env.MODEL_DETECTION_TIMEOUT_MS = "10";
    try {
      // A runner whose create() settles only after the timeout has fired,
      // simulating a kiro-cli subprocess that comes up too late.
      const runner = makeRunner([{ modelId: "late", name: "Late Model" }]);
      let resolveRunner: (r: typeof runner) => void = () => {};
      const runnerReady = new Promise<typeof runner>((resolve) => {
        resolveRunner = resolve;
      });
      createMock.mockReturnValue(runnerReady);

      const app = await freshApp();
      const res = await request(app).get("/api/models");

      // The timeout won: auto-only fallback, not cached, error logged.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ default: "auto", models: [] });
      expect(log.error).toHaveBeenCalled();

      // The orphaned subprocess finally comes up: it must be reaped, not leaked.
      resolveRunner(runner);
      await runnerReady;
      // Flush the cleanup promise chain attached to the runner promise.
      await new Promise((r) => setImmediate(r));

      expect(runner.close).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.MODEL_DETECTION_TIMEOUT_MS;
      else process.env.MODEL_DETECTION_TIMEOUT_MS = prev;
    }
  });
});
