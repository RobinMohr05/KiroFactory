/**
 * Tests for input validation on PUT /api/admin/settings.
 *
 * Task #2015: the handler previously only applied a change when
 * `typeof registrationEnabled === "boolean"`, but still returned 200 with the
 * current settings for a missing/null/non-boolean value — a silent no-op that
 * looks like a successful write to the caller. These tests pin the intended
 * 400-on-invalid / 400-on-empty-body behavior.
 *
 * Uses the supertest + vi.mock pattern established by tasks.validation.test.ts
 * and other route tests in this codebase.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Mocks — must come before module imports
// ---------------------------------------------------------------------------

vi.mock("../db/settings.js", () => ({
  getAppSettings: vi.fn().mockResolvedValue({ registrationEnabled: true }),
  setRegistrationEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/users.js", () => ({
  isFirstUser: vi.fn().mockResolvedValue(true),
}));

vi.mock("../middleware/auth.js", () => ({
  getUserId: vi.fn().mockReturnValue(1),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { getAppSettings, setRegistrationEnabled } from "../db/settings.js";
import adminRouter from "./admin.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

describe("PUT /api/admin/settings validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAppSettings).mockResolvedValue({ registrationEnabled: true } as any);
    vi.mocked(setRegistrationEnabled).mockResolvedValue(undefined as any);
  });

  it("updates and returns 200 when registrationEnabled is a boolean", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/admin/settings")
      .send({ registrationEnabled: false });

    expect(res.status).toBe(200);
    expect(setRegistrationEnabled).toHaveBeenCalledWith(false);
  });

  it("returns 400 when registrationEnabled is a non-boolean value", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/admin/settings")
      .send({ registrationEnabled: "true" });

    expect(res.status).toBe(400);
    expect(setRegistrationEnabled).not.toHaveBeenCalled();
  });

  it("returns 400 when registrationEnabled is null", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/admin/settings")
      .send({ registrationEnabled: null });

    expect(res.status).toBe(400);
    expect(setRegistrationEnabled).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty body (no recognized fields)", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/admin/settings")
      .send({});

    expect(res.status).toBe(400);
    expect(setRegistrationEnabled).not.toHaveBeenCalled();
  });
});
