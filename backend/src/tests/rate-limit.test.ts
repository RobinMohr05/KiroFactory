/**
 * Tests for rate-limiting middleware (OWASP A07 — Identification and
 * Authentication Failures; coding_guidelines.MD §2).
 *
 * The backend exposes public, unauthenticated endpoints — `/api/auth/login`,
 * `/api/auth/register`, and the `/api/webhooks/tasks` webhook — that can be
 * brute-forced or hammered without throttling. This module verifies the
 * express-rate-limit limiters that protect them, plus a looser global limiter
 * on `/api/*`.
 *
 * The production wiring lives in index.ts (which starts a server on import), so
 * to keep this test hermetic we build limiters via the same factory functions
 * index.ts uses and mount them on a minimal Express app, following the pattern
 * in security-headers.test.ts / body-size-limit.test.ts.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createAuthRateLimiter, createGlobalRateLimiter } from "../middleware/rate-limit.js";

/**
 * Fires `n` sequential requests at `path` on `app` and returns the array of
 * response status codes, in order.
 */
async function hammer(app: express.Express, method: "get" | "post", path: string, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await request(app)[method](path).send({});
    statuses.push(res.status);
  }
  return statuses;
}

describe("Auth rate limiter", () => {
  it("allows requests up to the configured max, then returns 429", async () => {
    const max = 5;
    const app = express();
    app.use(express.json());
    app.post("/api/auth/login", createAuthRateLimiter({ max, windowMs: 60_000 }), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const statuses = await hammer(app, "post", "/api/auth/login", max + 2);

    // First `max` requests pass through to the handler (200).
    expect(statuses.slice(0, max).every((s) => s === 200)).toBe(true);
    // Everything beyond the limit is blocked with 429.
    expect(statuses.slice(max).every((s) => s === 429)).toBe(true);
  });

  it("sets a Retry-After header on the 429 response", async () => {
    const max = 2;
    const app = express();
    app.use(express.json());
    app.post("/api/auth/login", createAuthRateLimiter({ max, windowMs: 60_000 }), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    // Exhaust the limit.
    await hammer(app, "post", "/api/auth/login", max);
    const blocked = await request(app).post("/api/auth/login").send({});

    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("keeps separate counters per client IP", async () => {
    const max = 2;
    const app = express();
    // Match index.ts's production wiring: trust a single proxy hop (ACA ingress)
    // so req.ip reflects the real client, not the proxy. A numeric hop count is
    // the non-permissive setting express-rate-limit expects (vs. `true`).
    app.set("trust proxy", 1);
    app.use(express.json());
    app.post("/api/auth/login", createAuthRateLimiter({ max, windowMs: 60_000 }), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    // Client A exhausts its limit.
    for (let i = 0; i < max; i++) {
      await request(app).post("/api/auth/login").set("X-Forwarded-For", "10.0.0.1").send({});
    }
    const blockedA = await request(app).post("/api/auth/login").set("X-Forwarded-For", "10.0.0.1").send({});
    // A different client is unaffected.
    const okB = await request(app).post("/api/auth/login").set("X-Forwarded-For", "10.0.0.2").send({});

    expect(blockedA.status).toBe(429);
    expect(okB.status).toBe(200);
  });
});

describe("Global rate limiter", () => {
  it("allows requests up to the configured max, then returns 429", async () => {
    const max = 4;
    const app = express();
    app.use(express.json());
    app.use("/api", createGlobalRateLimiter({ max, windowMs: 60_000 }));
    app.get("/api/tasks", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const statuses = await hammer(app, "get", "/api/tasks", max + 2);

    expect(statuses.slice(0, max).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(max).every((s) => s === 429)).toBe(true);
  });
});
