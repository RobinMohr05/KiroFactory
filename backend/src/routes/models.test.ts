/**
 * Tests for the models API route (GET /api/models and GET /api/models/diagnostics).
 *
 * Verifies:
 * - Successful detection maps ACP ModelInfo -> { id, name, description } with no detectionError
 * - The successfully detected list is cached for the process lifetime
 *   (a second request does not re-run detection)
 * - Detection failure (missing binary / ACP error / timeout / no-models-field) returns the
 *   auto-only fallback ({ default: "auto", models: [] }) with a 200, and does
 *   NOT populate the cache (a later request can recover)
 * - detectionError.code correctly identifies the four failure cases
 * - GET /api/models/diagnostics returns presence booleans (not values) for secrets
 * - KIRO_API_KEY / AWS_* values are never passed to any log call
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

function makeRunner(
  availableModels: Array<{ modelId: string; name: string; description?: string | null }>,
  detectionFailureDetail: null | { hasModelsField: boolean; modelsCount: number } = null
) {
  return {
    availableModels,
    detectionFailureDetail,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("GET /api/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps ACP ModelInfo -> { id, name, description } on successful detection, with no detectionError", async () => {
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
    // No detectionError on successful detection
    expect(res.body.detectionError).toBeUndefined();
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
    expect(first.body.default).toBe("auto");
    expect(first.body.models).toEqual([]);
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
      // Detection retries once on timeout, so a timed-out request spawns twice.
      // In production each spawn creates its own kiro-cli subprocess, so give
      // one distinct late-arriving runner per attempt — each must be reaped
      // (closed) exactly once, never leaked and never double-closed.
      const makeLateRunner = () => {
        const runner = makeRunner([{ modelId: "late", name: "Late Model" }]);
        let resolveRunner: (r: typeof runner) => void = () => {};
        const ready = new Promise<typeof runner>((resolve) => {
          resolveRunner = resolve;
        });
        return { runner, ready, resolve: () => resolveRunner(runner) };
      };
      const first = makeLateRunner();
      const second = makeLateRunner();
      createMock.mockReturnValueOnce(first.ready).mockReturnValueOnce(second.ready);

      const app = await freshApp();
      const res = await request(app).get("/api/models");

      // Both attempts timed out: auto-only fallback, not cached, error logged.
      expect(res.status).toBe(200);
      expect(res.body.default).toBe("auto");
      expect(res.body.models).toEqual([]);
      expect(res.body.detectionError).toMatchObject({ code: "timeout" });
      expect(log.error).toHaveBeenCalled();
      // Initial attempt + one retry = two spawns.
      expect(createMock).toHaveBeenCalledTimes(2);

      // The orphaned subprocesses finally come up: each must be reaped, not leaked.
      first.resolve();
      second.resolve();
      await Promise.all([first.ready, second.ready]);
      // Flush the cleanup promise chain attached to each runner promise.
      await new Promise((r) => setImmediate(r));

      expect(first.runner.close).toHaveBeenCalledTimes(1);
      expect(second.runner.close).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.MODEL_DETECTION_TIMEOUT_MS;
      else process.env.MODEL_DETECTION_TIMEOUT_MS = prev;
    }
  });

  // -------------------------------------------------------------------------
  // detectionError.code cases (four distinguished failure codes)
  // -------------------------------------------------------------------------

  it("returns detectionError.code='binary-not-found' when kiro-cli ENOENT spawn fails", async () => {
    const enoentErr = Object.assign(new Error("kiro-cli not found on PATH"), { code: "ENOENT" });
    createMock.mockRejectedValue(enoentErr);

    const app = await freshApp();
    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(res.body.detectionError).toMatchObject({
      code: "binary-not-found",
      message: expect.any(String),
    });
  });

  it("returns detectionError.code='timeout' when detection times out", async () => {
    const prev = process.env.MODEL_DETECTION_TIMEOUT_MS;
    process.env.MODEL_DETECTION_TIMEOUT_MS = "10";
    try {
      // Never resolves — simulates a kiro-cli that hangs
      createMock.mockReturnValue(new Promise(() => {}));

      const app = await freshApp();
      const res = await request(app).get("/api/models");

      expect(res.status).toBe(200);
      expect(res.body.models).toEqual([]);
      expect(res.body.detectionError).toMatchObject({
        code: "timeout",
        message: expect.any(String),
      });
    } finally {
      if (prev === undefined) delete process.env.MODEL_DETECTION_TIMEOUT_MS;
      else process.env.MODEL_DETECTION_TIMEOUT_MS = prev;
    }
  });

  it("retries detection once on timeout before falling back to auto-only", async () => {
    const prev = process.env.MODEL_DETECTION_TIMEOUT_MS;
    process.env.MODEL_DETECTION_TIMEOUT_MS = "10";
    try {
      // Both the first attempt and the retry hang past the timeout — the
      // endpoint must attempt detection twice (initial + one retry) before
      // giving up with the timeout fallback.
      createMock.mockReturnValue(new Promise(() => {}));

      const app = await freshApp();
      const res = await request(app).get("/api/models");

      expect(res.status).toBe(200);
      expect(res.body.models).toEqual([]);
      expect(res.body.detectionError).toMatchObject({ code: "timeout" });
      // Initial attempt + exactly one retry = 2 spawns.
      expect(createMock).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined) delete process.env.MODEL_DETECTION_TIMEOUT_MS;
      else process.env.MODEL_DETECTION_TIMEOUT_MS = prev;
    }
  });

  it("recovers when the retry after a timeout succeeds", async () => {
    const prev = process.env.MODEL_DETECTION_TIMEOUT_MS;
    process.env.MODEL_DETECTION_TIMEOUT_MS = "10";
    try {
      // First attempt hangs (times out); the retry resolves with real models.
      createMock
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValueOnce(makeRunner([{ modelId: "m1", name: "Model One" }]));

      const app = await freshApp();
      const res = await request(app).get("/api/models");

      expect(res.status).toBe(200);
      expect(res.body.detectionError).toBeUndefined();
      expect(res.body.models).toEqual([{ id: "m1", name: "Model One", description: null }]);
      expect(createMock).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined) delete process.env.MODEL_DETECTION_TIMEOUT_MS;
      else process.env.MODEL_DETECTION_TIMEOUT_MS = prev;
    }
  });

  it("does NOT retry on a non-timeout failure (e.g. binary-not-found)", async () => {
    const enoentErr = Object.assign(new Error("kiro-cli not found on PATH"), { code: "ENOENT" });
    createMock.mockRejectedValue(enoentErr);

    const app = await freshApp();
    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body.detectionError).toMatchObject({ code: "binary-not-found" });
    // A binary-not-found failure is not transient — detection must not retry.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("returns detectionError.code='acp-error' when KiroRunner.create throws a non-ENOENT error", async () => {
    createMock.mockRejectedValue(new Error("ACP handshake failed: protocol error"));

    const app = await freshApp();
    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(res.body.detectionError).toMatchObject({
      code: "acp-error",
      message: expect.any(String),
    });
  });

  it("returns detectionError.code='no-models-field' when session/new returns no/empty availableModels", async () => {
    // Runner created successfully but advertises no models. In the real
    // KiroRunner, this always sets detectionFailureDetail to a non-null value,
    // so mirror that here to exercise the actual runner-provided detail path
    // (not the fallback).
    const runner = makeRunner([], { hasModelsField: true, modelsCount: 0 });
    createMock.mockResolvedValue(runner);

    const app = await freshApp();
    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(res.body.detectionError).toMatchObject({
      code: "no-models-field",
      message: expect.any(String),
    });

    // The runner-provided detail must flow through to diagnostics.
    const diag = await request(app).get("/api/models/diagnostics");
    expect(diag.status).toBe(200);
    expect(diag.body.lastDetectionCode).toBe("no-models-field");
    expect(diag.body.sessionNewHasModelsField).toBe(true);
    expect(diag.body.modelsCount).toBe(0);
  });
});

describe("GET /api/models/diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with presence booleans for secrets (never the values)", async () => {
    const prevKiroKey = process.env.KIRO_API_KEY;
    const prevAwsKey = process.env.AWS_ACCESS_KEY_ID;
    process.env.KIRO_API_KEY = "super-secret-key";
    process.env.AWS_ACCESS_KEY_ID = "also-secret";
    try {
      // Detection succeeds — gives us a baseline
      createMock.mockResolvedValue(makeRunner([{ modelId: "m1", name: "Model One" }]));

      const app = await freshApp();
      const res = await request(app).get("/api/models/diagnostics");

      expect(res.status).toBe(200);
      // Presence booleans — true because env vars are set
      expect(res.body.hasKiroApiKey).toBe(true);
      expect(res.body.hasAwsCreds).toBe(true);
      // NEVER the actual values
      expect(JSON.stringify(res.body)).not.toContain("super-secret-key");
      expect(JSON.stringify(res.body)).not.toContain("also-secret");
      // PATH info
      expect(typeof res.body.binaryFoundOnPath).toBe("boolean");
      expect(Array.isArray(res.body.pathEntries)).toBe(true);
      // resolvedKiroPath is either a string or null
      expect(
        res.body.resolvedKiroPath === null || typeof res.body.resolvedKiroPath === "string"
      ).toBe(true);
    } finally {
      if (prevKiroKey === undefined) delete process.env.KIRO_API_KEY;
      else process.env.KIRO_API_KEY = prevKiroKey;
      if (prevAwsKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = prevAwsKey;
    }
  });

  it("returns hasKiroApiKey=false and hasAwsCreds=false when env vars are unset", async () => {
    const prevKiroKey = process.env.KIRO_API_KEY;
    const prevAwsKey = process.env.AWS_ACCESS_KEY_ID;
    const prevAwsSecret = process.env.AWS_SECRET_ACCESS_KEY;
    const prevAwsSession = process.env.AWS_SESSION_TOKEN;
    delete process.env.KIRO_API_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    try {
      createMock.mockResolvedValue(makeRunner([{ modelId: "m1", name: "Model One" }]));

      const app = await freshApp();
      const res = await request(app).get("/api/models/diagnostics");

      expect(res.status).toBe(200);
      expect(res.body.hasKiroApiKey).toBe(false);
      expect(res.body.hasAwsCreds).toBe(false);
    } finally {
      if (prevKiroKey !== undefined) process.env.KIRO_API_KEY = prevKiroKey;
      if (prevAwsKey !== undefined) process.env.AWS_ACCESS_KEY_ID = prevAwsKey;
      if (prevAwsSecret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = prevAwsSecret;
      if (prevAwsSession !== undefined) process.env.AWS_SESSION_TOKEN = prevAwsSession;
    }
  });

  it("includes detectionCode and modelsCount from the last detection attempt", async () => {
    // Detection fails with binary-not-found
    const enoentErr = Object.assign(new Error("kiro-cli not found on PATH"), { code: "ENOENT" });
    createMock.mockRejectedValue(enoentErr);

    const app = await freshApp();
    // First trigger a detection to populate last attempt
    await request(app).get("/api/models");
    const res = await request(app).get("/api/models/diagnostics");

    expect(res.status).toBe(200);
    expect(res.body.lastDetectionCode).toBe("binary-not-found");
    expect(typeof res.body.lastDetectionMessage).toBe("string");
    expect(typeof res.body.modelsCount).toBe("number");
  });
});

describe("warmModelsCache() — startup eager warm-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers detection once and populates the cache in the background", async () => {
    const runner = makeRunner([{ modelId: "m1", name: "Model One" }]);
    createMock.mockResolvedValue(runner);

    vi.resetModules();
    const mod = await import("./models.js");

    // Warm-up kicks off detection and resolves without throwing.
    await mod.warmModelsCache();
    expect(createMock).toHaveBeenCalledTimes(1);

    // The subsequent GET /api/models serves the already-populated cache
    // instead of re-detecting.
    const app = express();
    app.use("/api/models", mod.default);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([{ id: "m1", name: "Model One", description: null }]);
    // Still only one detection — the request hit the warmed cache.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when detection fails (safe to fire-and-forget at startup)", async () => {
    createMock.mockRejectedValue(new Error("kiro-cli not found on PATH"));

    vi.resetModules();
    const mod = await import("./models.js");

    // Must resolve (not reject) even though detection failed, so the caller
    // can .catch()-guard it exactly like the ACA preflight check.
    await expect(mod.warmModelsCache()).resolves.toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("Logging safety — KIRO_API_KEY / AWS_* values never logged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never passes KIRO_API_KEY or AWS_* values to any log call on detection failure", async () => {
    const prevKiroKey = process.env.KIRO_API_KEY;
    const prevAwsKey = process.env.AWS_ACCESS_KEY_ID;
    process.env.KIRO_API_KEY = "secret-api-key-12345";
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    try {
      const enoentErr = Object.assign(new Error("kiro-cli not found on PATH"), { code: "ENOENT" });
      createMock.mockRejectedValue(enoentErr);

      const app = await freshApp();
      await request(app).get("/api/models");

      // Inspect every log call — none should contain the secret values
      const allLogCalls = [
        ...(log.error as ReturnType<typeof vi.fn>).mock.calls,
        ...(log.warn as ReturnType<typeof vi.fn>).mock.calls,
        ...(log.info as ReturnType<typeof vi.fn>).mock.calls,
      ];
      const allLoggedText = JSON.stringify(allLogCalls);
      expect(allLoggedText).not.toContain("secret-api-key-12345");
      expect(allLoggedText).not.toContain("AKIAIOSFODNN7EXAMPLE");
    } finally {
      if (prevKiroKey === undefined) delete process.env.KIRO_API_KEY;
      else process.env.KIRO_API_KEY = prevKiroKey;
      if (prevAwsKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = prevAwsKey;
    }
  });
});
