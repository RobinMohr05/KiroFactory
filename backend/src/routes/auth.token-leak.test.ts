/**
 * Tests that POST /api/auth/login and POST /api/auth/register do NOT echo the
 * session JWT in the JSON response body. The token must only travel via the
 * httpOnly `kf_session` cookie so an XSS bug can't exfiltrate it (see task
 * #2018). The response body should contain just `{ user }`.
 *
 * Mirrors the supertest + mocked-router pattern used across the auth route
 * tests (see auth.viewmode.test.ts).
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
  createSession: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../config.js", () => ({
  getJwtSecret: vi.fn().mockReturnValue("test-secret"),
}));

import { getUserByEmail, createUser, verifyPassword } from "../db/users.js";
import authRouter from "./auth.js";

const fakeUser = {
  id: 1,
  email: "test@test.com",
  defaultGitProvider: null,
  uiViewMode: "advanced",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  return app;
}

describe("auth response body does not leak the session token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/auth/login returns only { user }, no token in body, but sets the cookie", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(fakeUser as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@test.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("test@test.com");
    expect(res.body.token).toBeUndefined();
    // Cookie is still the delivery mechanism for the session token.
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toMatch(/kf_session=/);
  });

  it("POST /api/auth/register returns only { user }, no token in body, but sets the cookie", async () => {
    vi.mocked(getUserByEmail).mockResolvedValue(null as any);
    vi.mocked(createUser).mockResolvedValue(fakeUser as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "test@test.com", password: "password123", kiroApiKey: "key" });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("test@test.com");
    expect(res.body.token).toBeUndefined();
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toMatch(/kf_session=/);
  });
});
