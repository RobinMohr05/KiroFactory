/**
 * Tests for route-specific body size limits.
 *
 * Verifies:
 * 1. The task-planner route accepts JSON payloads up to 50MB (for multi-image uploads).
 * 2. Other routes (e.g. /api/tasks) still reject payloads over the default 100KB.
 * 3. The task-planner route returns 413 for payloads over 50MB.
 * 4. The uncaughtErrorLogger respects the error's status code (e.g. 413, not 500).
 * 5. Multi-image payloads (2-3 images near 10MB each) are accepted under the 50MB limit.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { uncaughtErrorLogger } from "../middleware/error-logger.js";

/**
 * The production body-parser limit for /api/task-planner routes.
 * Must stay in sync with the value in index.ts.
 * 3 images × 10 MB raw × 4/3 base64 expansion ≈ 40 MB + JSON overhead → 50 MB.
 */
const TASK_PLANNER_BODY_LIMIT = "50mb";

/**
 * Creates a minimal Express app that mirrors the production middleware order
 * in index.ts: path-specific body parser for /api/task-planner FIRST, then
 * the generic parser for everything else, then route handlers, then error handler.
 */
function createTestApp() {
  const app = express();

  // Path-specific higher limit for task-planner routes BEFORE the generic parser
  app.use("/api/task-planner", express.json({ limit: TASK_PLANNER_BODY_LIMIT }));
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
    const body = { message: "hello", images: [{ data: largeData, mimeType: "image/png" }] };

    const res = await request(app)
      .post("/api/task-planner/test-session/message")
      .send(body)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("task-planner route accepts a multi-image payload under 50MB", async () => {
    const app = createTestApp();
    // 3 images × ~5MB each = ~15MB base64 total → well under 50MB limit
    const imageData = "A".repeat(5 * 1024 * 1024);
    const body = {
      message: "hello",
      images: [
        { data: imageData, mimeType: "image/png" },
        { data: imageData, mimeType: "image/jpeg" },
        { data: imageData, mimeType: "image/gif" },
      ],
    };

    const res = await request(app)
      .post("/api/task-planner/test-session/message")
      .send(body)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("task-planner route accepts a 2-image payload where each is near the 10MB raw limit", async () => {
    const app = createTestApp();
    // 2 images × ~10MB raw → ~13.3MB base64 each → ~26.6MB total → under 50MB
    // 10MB raw ≈ 13.33MB base64 (×4/3 expansion)
    const nearMaxData = "A".repeat(Math.ceil(10 * 1024 * 1024 * 4 / 3));
    const body = {
      message: "hello",
      images: [
        { data: nearMaxData, mimeType: "image/png" },
        { data: nearMaxData, mimeType: "image/jpeg" },
      ],
    };

    const res = await request(app)
      .post("/api/task-planner/test-session/message")
      .send(body)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("task-planner route returns 413 for payloads over 50MB", async () => {
    const app = createTestApp();
    // Generate a ~51MB payload — exceeds the 50MB limit
    const hugeData = "A".repeat(51 * 1024 * 1024);
    const body = { message: "hello", images: [{ data: hugeData, mimeType: "image/png" }] };

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
