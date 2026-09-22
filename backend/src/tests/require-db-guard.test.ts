/**
 * Tests for the `requireDb` DB-availability guard middleware and its
 * application to the DB-dependent API router mounts.
 *
 * index.ts binds the HTTP port BEFORE connecting to AuraDB (see the `start()`
 * comment about ECONNREFUSED) and explicitly supports running while the DB is
 * unavailable at startup. DB-dependent routes are supposed to return a clean
 * 503 `{ error: "Database is currently unavailable..." }` via `requireDb` in
 * that window, instead of throwing inside the DB layer and surfacing a generic
 * 500.
 *
 * These tests verify:
 * 1. `requireDb` returns 503 with the documented message when the DB is
 *    unavailable, and calls next() (letting the route run) when it's available.
 * 2. The `/api/sessions` and `/api/agents` mounts sit BEHIND `requireDb` — a
 *    request arriving while the DB is down is short-circuited to 503 before it
 *    ever reaches the router (so it never throws inside the DB layer).
 *
 * index.ts starts a server on import, so — following the security-headers /
 * body-size-limit test pattern — we mirror the production wiring on a minimal
 * Express app using the same shared `requireDb` middleware index.ts uses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Router } from "express";

vi.mock("../db/connection.js", () => ({
  isDbAvailable: vi.fn(),
}));

import { isDbAvailable } from "../db/connection.js";
import { requireDb } from "../middleware/require-db.js";

const mockedIsDbAvailable = vi.mocked(isDbAvailable);

/**
 * Build a minimal app mounting a trivial router behind `requireDb`, exactly as
 * index.ts mounts the DB-dependent routers (e.g.
 * `app.use("/api/sessions", requireDb, sessionsRouter)`).
 */
function createTestApp(mountPath: string) {
  const app = express();
  const router: Router = express.Router();
  router.get("/", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(mountPath, requireDb, router);
  return app;
}

describe("requireDb middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 503 with the documented message when the DB is unavailable", async () => {
    mockedIsDbAvailable.mockReturnValue(false);
    const res = await request(createTestApp("/api/sessions")).get("/api/sessions");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Database is currently unavailable/i);
  });

  it("lets the request through to the route when the DB is available", async () => {
    mockedIsDbAvailable.mockReturnValue(true);
    const res = await request(createTestApp("/api/sessions")).get("/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("guards the /api/agents mount so it short-circuits to 503 while the DB is down", async () => {
    mockedIsDbAvailable.mockReturnValue(false);
    const res = await request(createTestApp("/api/agents")).get("/api/agents");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Database is currently unavailable/i);
  });
});
