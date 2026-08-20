/**
 * Tests for route-specific body size limits.
 *
 * Verifies:
 * 1. The task-planner route accepts JSON payloads up to 15MB (for image uploads).
 * 2. Other routes (e.g. /api/tasks) still reject payloads over the default 100KB.
 * 3. The task-planner route returns 413 for payloads over 15MB.
 * 4. The uncaughtErrorLogger respects the error's status code (e.g. 413, not 500).
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { uncaughtErrorLogger } from "../middleware/error-logger.js";

/**
 * Creates a minimal Express app that mirrors the production middleware order
 * in index.ts: path-specific body parser for /api/task-planner FIRST, then
 * the generic parser for everything else, then route handlers, then error handler.
 */
function createTestApp() {
  const app = express();

  // Path-specific higher limit for task-planner routes BEFORE the generic parser
  app.use("/api/task-planner", express.json({ limit: "15mb" }));
  // Global default limit for all other routes
  app.use(express.json());

  // Simple route handlers for testing
  app.post("/api/task-planner/test-session/message", (req, res) => {
    res.status(200).json({ ok: true, bodySize: JSON.stringify(req.body).length });
  });

  app.post("/api/tasks", (req, res) => {
    res.status(200).json({ ok: true, bodySize: JSON.stringify(req.body).length });
  });

  // Error handler that respects error status code
  app.use(uncaughtErrorLogger);

  return app;
}

describe("Route-specific body size limits", () => {
  it("task-planner route accepts a 5MB JSON payload", async () => {
    const app = createTestApp();
    // Generate a ~5MB base64 payload inside JSON
    const largeData = "A".repeat(5 * 1024 * 1024);
    const body = { message: "hello", image: { data: largeData, mimeType: "image/png" } };

    const res = await request(app)
      .post("/api/task-planner/test-session/message")
      .send(body)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("task-planner route returns 413 for payloads over 15MB", async () => {
    const app = createTestApp();
    // Generate a ~16MB payload
    const hugeData = "A".repeat(16 * 1024 * 1024);
    const body = { message: "hello", image: { data: hugeData, mimeType: "image/png" } };

    const res = await request(app)
      .post("/api/task-planner/test-session/message")
      .send(body)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(413);
  });

  it("other routes reject payloads over 100KB with status 413", async () => {
    const app = createTestApp();
    // Generate a ~200KB payload (exceeds 100KB default)
    const mediumData = "A".repeat(200 * 1024);
    const body = { description: mediumData };

    const res = await request(app)
      .post("/api/tasks")
      .send(body)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(413);
  });

  it("other routes accept payloads under 100KB", async () => {
    const app = createTestApp();
    const body = { title: "A small task", description: "Something brief" };

    const res = await request(app)
      .post("/api/tasks")
      .send(body)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("uncaughtErrorLogger respects error status code", () => {
  it("returns 413 for PayloadTooLargeError instead of generic 500", async () => {
    const app = express();
    // Intentionally use a tiny limit to trigger PayloadTooLargeError
    app.use(express.json({ limit: "1b" }));
    app.post("/test", (req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use(uncaughtErrorLogger);

    const res = await request(app)
      .post("/test")
      .send({ data: "some payload that exceeds 1 byte" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(413);
    // Should NOT be 500
    expect(res.status).not.toBe(500);
  });

  it("returns 400 for JSON parse errors instead of generic 500", async () => {
    const app = express();
    app.use(express.json());
    app.post("/test", (req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use(uncaughtErrorLogger);

    const res = await request(app)
      .post("/test")
      .send("this is not valid json {{{")
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    // Should NOT be 500
    expect(res.status).not.toBe(500);
  });
});
