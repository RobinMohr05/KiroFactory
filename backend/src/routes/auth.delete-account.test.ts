/**
 * Tests for DELETE /api/auth/me — self-service account deletion.
 *
 * Task #1972: this route could never succeed because deleteUser refused to
 * delete any user who still owned anything via :OWNS, and every user always
 * owns their permanent "Chat" Session. With deleteUser fixed to cascade-clean
 * disposable owned nodes, a correct password confirmation must now yield 200.
 *
 * The route must also stop the user's running sessions before deleting the
 * account, so no orphaned worker containers are left behind once the session
 * rows are removed.
 *
 * Follows the mocked-router + supertest pattern used across this codebase
 * (see auth.viewmode.test.ts).
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
  stopAllSessionsForUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  getUserId: vi.fn().mockReturnValue(1),
  isPublicPath: vi.fn().mockReturnValue(false),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { verifyPasswordById, deleteUser } from "../db/users.js";
import { stopAllSessionsForUser } from "../session-manager.js";
import authRouter from "./auth.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  return app;
}

describe("DELETE /api/auth/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stopAllSessionsForUser).mockResolvedValue(undefined);
  });

  it("deletes the account after a correct password confirmation", async () => {
    vi.mocked(verifyPasswordById).mockResolvedValue(true);
    vi.mocked(deleteUser).mockResolvedValue(true);

    const app = createApp();
    const res = await request(app).delete("/api/auth/me").send({ password: "correct-horse" });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);
    expect(deleteUser).toHaveBeenCalledWith(1);
  });

  it("stops the user's running sessions before deleting the account", async () => {
    vi.mocked(verifyPasswordById).mockResolvedValue(true);
    vi.mocked(deleteUser).mockResolvedValue(true);

    const app = createApp();
    const res = await request(app).delete("/api/auth/me").send({ password: "correct-horse" });

    expect(res.status).toBe(200);
    expect(stopAllSessionsForUser).toHaveBeenCalledWith(1);
    // sessions must be stopped before the DB rows are removed
    const stopOrder = vi.mocked(stopAllSessionsForUser).mock.invocationCallOrder[0];
    const deleteOrder = vi.mocked(deleteUser).mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(deleteOrder);
  });

  it("requires a password", async () => {
    const app = createApp();
    const res = await request(app).delete("/api/auth/me").send({});

    expect(res.status).toBe(400);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(stopAllSessionsForUser).not.toHaveBeenCalled();
  });

  it("rejects an incorrect password", async () => {
    vi.mocked(verifyPasswordById).mockResolvedValue(false);

    const app = createApp();
    const res = await request(app).delete("/api/auth/me").send({ password: "wrong" });

    expect(res.status).toBe(401);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(stopAllSessionsForUser).not.toHaveBeenCalled();
  });

  it("returns 409 when deletion is refused (user owns protected resources)", async () => {
    vi.mocked(verifyPasswordById).mockResolvedValue(true);
    vi.mocked(deleteUser).mockResolvedValue(false);

    const app = createApp();
    const res = await request(app).delete("/api/auth/me").send({ password: "correct-horse" });

    expect(res.status).toBe(409);
  });
});
