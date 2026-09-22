/**
 * Tests for account-lockout integration in POST /api/auth/login (OWASP A07 —
 * coding_guidelines.MD §2, "Account lockout after repeated failures").
 *
 * Complements the per-IP rate limiter (tests/rate-limit.test.ts) and the
 * standalone lockout tracker (tests/account-lockout.test.ts) by verifying the
 * login route actually consults the tracker: it records failures on bad
 * credentials, refuses further attempts with 429 once an account is locked,
 * and clears the counter on a successful login.
 *
 * Uses the supertest + mocked-db-layer pattern from auth.viewmode.test.ts.
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

vi.mock("../config.js", () => ({
  getJwtSecret: vi.fn().mockReturnValue("test-secret"),
}));

import { verifyPassword } from "../db/users.js";
import { __resetLockoutState } from "../account-lockout.js";
import authRouter from "./auth.js";

const EMAIL = "lockme@example.com";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  return app;
}

/** The lockout threshold used by the login route (DEFAULT_LOCKOUT_OPTIONS). */
const THRESHOLD = 5;

describe("POST /api/auth/login account lockout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLockoutState();
  });

  it("locks the account with 429 after the threshold of failed attempts", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(null); // always wrong password
    const app = createApp();

    // The first THRESHOLD - 1 attempts return 401 (invalid credentials, still
    // under the threshold).
    for (let i = 0; i < THRESHOLD - 1; i++) {
      const res = await request(app).post("/api/auth/login").send({ email: EMAIL, password: "wrong" });
      expect(res.status).toBe(401);
    }

    // The attempt that crosses the threshold is itself refused with 429 —
    // recordFailedLogin() reports the account is now locked, so the response
    // matches the top-of-handler lockout branch instead of a misleading 401.
    const tripping = await request(app).post("/api/auth/login").send({ email: EMAIL, password: "wrong" });
    expect(tripping.status).toBe(429);
    expect(tripping.headers["retry-after"]).toBe("900");

    // The next attempt is still refused with 429 regardless of credentials.
    const locked = await request(app).post("/api/auth/login").send({ email: EMAIL, password: "wrong" });
    expect(locked.status).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
  });

  it("does not lock a different account", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(null);
    const app = createApp();

    for (let i = 0; i < THRESHOLD; i++) {
      await request(app).post("/api/auth/login").send({ email: EMAIL, password: "wrong" });
    }

    const other = await request(app)
      .post("/api/auth/login")
      .send({ email: "someone-else@example.com", password: "wrong" });
    // Not locked → still reaches the credential check (401), not 429.
    expect(other.status).toBe(401);
  });

  it("clears the failure counter on a successful login", async () => {
    const app = createApp();

    // Four failures (one below threshold).
    vi.mocked(verifyPassword).mockResolvedValue(null);
    for (let i = 0; i < THRESHOLD - 1; i++) {
      await request(app).post("/api/auth/login").send({ email: EMAIL, password: "wrong" });
    }

    // A successful login clears the counter.
    vi.mocked(verifyPassword).mockResolvedValue({
      id: 1,
      email: EMAIL,
      defaultGitProvider: null,
      uiViewMode: "easy",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as any);
    const ok = await request(app).post("/api/auth/login").send({ email: EMAIL, password: "right" });
    expect(ok.status).toBe(200);

    // Now four more failures should still be under threshold (counter was reset),
    // so the account is not yet locked.
    vi.mocked(verifyPassword).mockResolvedValue(null);
    for (let i = 0; i < THRESHOLD - 1; i++) {
      const res = await request(app).post("/api/auth/login").send({ email: EMAIL, password: "wrong" });
      expect(res.status).toBe(401);
    }
  });
});
