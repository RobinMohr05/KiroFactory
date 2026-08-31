/**
 * Tests for PUT /api/auth/me/view-mode — switching the user's top-level UI
 * layout between "easy" and "advanced".
 *
 * Mirrors the existing PUT /api/auth/me/default-git-provider route's test
 * shape (see usage.test.ts for the supertest + mocked-router pattern used
 * across this codebase).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.mock("../db/users.js", () => ({
  updateUserViewMode: vi.fn(),
  getUserById: vi.fn(),
  getUserByEmail: vi.fn(),
  createUser: vi.fn(),
  verifyPassword: vi.fn(),
  verifyPasswordById: vi.fn(),
  updateUserPassword: vi.fn(),
  updateUserKiroApiKey: vi.fn(),
  updateUserDefaultGitProvider: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("../db/settings.js", () => ({
  isRegistrationEnabled: vi.fn().mockResolvedValue(true),
}));

vi.mock("../session-manager.js", () => ({
  createSession: vi.fn(),
}));

// Bypass JWT verification — inject a fixed userId directly, same technique
// usage.test.ts uses for requireAuth.
vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  getUserId: vi.fn().mockReturnValue(1),
  isPublicPath: vi.fn().mockReturnValue(false),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { updateUserViewMode } from "../db/users.js";
import authRouter from "./auth.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  return app;
}

describe("PUT /api/auth/me/view-mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("switches to advanced and returns the updated user", async () => {
    vi.mocked(updateUserViewMode).mockResolvedValue({
      id: 1,
      email: "test@test.com",
      defaultGitProvider: null,
      uiViewMode: "advanced",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const app = createApp();
    const res = await request(app)
      .put("/api/auth/me/view-mode")
      .send({ uiViewMode: "advanced" });

    expect(res.status).toBe(200);
    expect(res.body.user.uiViewMode).toBe("advanced");
    expect(updateUserViewMode).toHaveBeenCalledWith(1, "advanced");
  });

  it("switches to easy and returns the updated user", async () => {
    vi.mocked(updateUserViewMode).mockResolvedValue({
      id: 1,
      email: "test@test.com",
      defaultGitProvider: null,
      uiViewMode: "easy",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const app = createApp();
    const res = await request(app)
      .put("/api/auth/me/view-mode")
      .send({ uiViewMode: "easy" });

    expect(res.status).toBe(200);
    expect(res.body.user.uiViewMode).toBe("easy");
  });

  it("rejects an invalid uiViewMode value", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/auth/me/view-mode")
      .send({ uiViewMode: "expert" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uiViewMode must be one of/i);
    expect(updateUserViewMode).not.toHaveBeenCalled();
  });

  it("switches to looper and returns the updated user", async () => {
    vi.mocked(updateUserViewMode).mockResolvedValue({
      id: 1,
      email: "test@test.com",
      defaultGitProvider: null,
      uiViewMode: "looper",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const app = createApp();
    const res = await request(app)
      .put("/api/auth/me/view-mode")
      .send({ uiViewMode: "looper" });

    expect(res.status).toBe(200);
    expect(res.body.user.uiViewMode).toBe("looper");
    expect(updateUserViewMode).toHaveBeenCalledWith(1, "looper");
  });

  it("rejects a missing uiViewMode", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/api/auth/me/view-mode")
      .send({});

    expect(res.status).toBe(400);
    expect(updateUserViewMode).not.toHaveBeenCalled();
  });

  it("returns 404 when the user no longer exists", async () => {
    vi.mocked(updateUserViewMode).mockResolvedValue(null);

    const app = createApp();
    const res = await request(app)
      .put("/api/auth/me/view-mode")
      .send({ uiViewMode: "advanced" });

    expect(res.status).toBe(404);
  });
});
