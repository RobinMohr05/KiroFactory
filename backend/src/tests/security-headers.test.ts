/**
 * Tests for helmet security-headers middleware (OWASP A05 — Security
 * Misconfiguration; coding_guidelines.MD §2).
 *
 * The backend serves the SPA (frontend/dist) on the same origin, so these
 * response headers protect the served HTML/JS against clickjacking, MIME
 * sniffing, and mixed-content downgrade.
 *
 * Verifies:
 * 1. helmet emits its core security headers (X-Content-Type-Options,
 *    X-Frame-Options, Content-Security-Policy, Strict-Transport-Security).
 * 2. The X-Powered-By header (Express default) is removed.
 *
 * The production middleware wiring lives in index.ts, which starts a server on
 * import; to keep this test hermetic we mirror that wiring via the shared
 * applySecurityHeaders() helper — the same function index.ts uses — on a
 * minimal Express app, following the pattern in body-size-limit.test.ts.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { applySecurityHeaders } from "../middleware/security-headers.js";

/**
 * Minimal app that applies the production security-headers middleware, then a
 * trivial route, mirroring index.ts's ordering (security headers registered
 * early in the chain).
 */
function createTestApp() {
  const app = express();
  applySecurityHeaders(app);
  app.get("/", (_req, res) => {
    res.status(200).send("<!doctype html><html><body>ok</body></html>");
  });
  return app;
}

describe("Security headers middleware", () => {
  it("sets X-Content-Type-Options: nosniff", async () => {
    const res = await request(createTestApp()).get("/");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets an X-Frame-Options header to prevent clickjacking", async () => {
    const res = await request(createTestApp()).get("/");
    expect(res.headers["x-frame-options"]).toBeDefined();
  });

  it("sets a Content-Security-Policy header", async () => {
    const res = await request(createTestApp()).get("/");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("sets a Strict-Transport-Security (HSTS) header", async () => {
    const res = await request(createTestApp()).get("/");
    expect(res.headers["strict-transport-security"]).toBeDefined();
  });

  it("removes the X-Powered-By header", async () => {
    const res = await request(createTestApp()).get("/");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
