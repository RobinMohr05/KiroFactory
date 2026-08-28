/**
 * Tests for multi-image support in the Task Planner message route.
 *
 * Covers:
 * 1. Route accepts `images` (plural array) body field
 * 2. Route enforces 3-image server-side cap
 * 3. Route validates each image in the array (mime type + size)
 * 4. Route identifies which specific image failed validation
 * 5. Backward compatibility: single image still works (sent as images[0])
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// We test the validation logic by building a minimal Express app that
// mirrors the route's validation code. This avoids mocking the entire
// session-manager/kiro-runner/Neo4j dependency chain while still testing
// the actual HTTP contract (body shape, status codes, error messages).
// ---------------------------------------------------------------------------

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_IMAGES = 3;

/**
 * Build a test app that contains the validation logic from the
 * /:sessionId/message route. Returns 200 with `{ ok: true }` when
 * validation passes, 400 with `{ error: string }` when it fails.
 */
function createValidationApp() {
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  app.post("/api/task-planner/:sessionId/message", (req, res) => {
    const { message, images: rawImages, image } = req.body as {
      message: string;
      images?: { data: string; mimeType: string }[];
      image?: { data: string; mimeType: string };
    };
    // Backward compat: accept legacy singular `image` field from app.js
    const images = rawImages ?? (image ? [image] : undefined);

    if (!message || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    // Validate images array if provided
    if (images) {
      if (!Array.isArray(images)) {
        res.status(400).json({ error: "images must be an array" });
        return;
      }

      if (images.length > MAX_IMAGES) {
        res.status(400).json({ error: `Too many images: ${images.length} exceeds the maximum of ${MAX_IMAGES}` });
        return;
      }

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img.data || !img.mimeType) {
          res.status(400).json({ error: `Image ${i + 1}: must include both 'data' (base64) and 'mimeType'` });
          return;
        }
        if (!ALLOWED_MIME_TYPES.includes(img.mimeType)) {
          res.status(400).json({ error: `Image ${i + 1}: unsupported type ${img.mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}` });
          return;
        }
        const decodedSize = Buffer.byteLength(img.data, "base64");
        if (decodedSize > MAX_IMAGE_SIZE) {
          res.status(400).json({ error: `Image ${i + 1}: too large (${(decodedSize / 1024 / 1024).toFixed(1)}MB exceeds the 10MB limit)` });
          return;
        }
      }
    }

    res.status(200).json({ ok: true, imageCount: images?.length ?? 0 });
  });

  return app;
}

describe("Task Planner multi-image route validation", () => {
  let app: express.Express;

  beforeEach(() => {
    app = createValidationApp();
  });

  it("accepts a message with no images", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({ message: "hello" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.imageCount).toBe(0);
  });

  it("accepts a message with a single image in the images array", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "check this",
        images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.imageCount).toBe(1);
  });

  it("accepts a message with 3 images (at the cap)", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "check these",
        images: [
          { data: "iVBORw0KGgo=", mimeType: "image/png" },
          { data: "R0lGODlhAQABAA==", mimeType: "image/gif" },
          { data: "/9j/4AAQSkZJ", mimeType: "image/jpeg" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.imageCount).toBe(3);
  });

  it("rejects a message with 4 images (over the 3-image cap)", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "too many",
        images: [
          { data: "iVBORw0KGgo=", mimeType: "image/png" },
          { data: "R0lGODlhAQABAA==", mimeType: "image/gif" },
          { data: "/9j/4AAQSkZJ", mimeType: "image/jpeg" },
          { data: "UklGRg==", mimeType: "image/webp" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too many images|exceeds the maximum/i);
  });

  it("rejects when one image has an unsupported mime type, identifying which one", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "bad type",
        images: [
          { data: "iVBORw0KGgo=", mimeType: "image/png" },
          { data: "baddata", mimeType: "image/bmp" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Image 2");
    expect(res.body.error).toContain("image/bmp");
  });

  it("rejects when one image is oversized, identifying which one", async () => {
    const oversizeBase64Length = Math.ceil((MAX_IMAGE_SIZE + 1) * 4 / 3);
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "too big",
        images: [
          { data: "iVBORw0KGgo=", mimeType: "image/png" },
          { data: "A".repeat(oversizeBase64Length), mimeType: "image/jpeg" },
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Image 2");
    expect(res.body.error).toMatch(/too large/i);
  });

  it("rejects when an image is missing data or mimeType", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "missing field",
        images: [
          { data: "iVBORw0KGgo=", mimeType: "image/png" },
          { mimeType: "image/jpeg" },  // missing data
        ],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Image 2");
  });

  it("accepts empty images array", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "no images",
        images: [],
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.imageCount).toBe(0);
  });
});

describe("Task Planner backward compatibility — legacy singular `image` field", () => {
  let app: express.Express;

  beforeEach(() => {
    app = createValidationApp();
  });

  it("normalizes legacy singular `image` object into images array", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "from vanilla JS frontend",
        image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.imageCount).toBe(1);
  });

  it("prefers `images` (plural) over `image` (singular) when both are sent", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "both fields",
        images: [
          { data: "iVBORw0KGgo=", mimeType: "image/png" },
          { data: "R0lGODlhAQABAA==", mimeType: "image/gif" },
        ],
        image: { data: "/9j/4AAQSkZJ", mimeType: "image/jpeg" },
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Should use the `images` array, not the singular `image`
    expect(res.body.imageCount).toBe(2);
  });

  it("validates the legacy singular image the same way (rejects bad mime type)", async () => {
    const res = await request(app)
      .post("/api/task-planner/1/message")
      .send({
        message: "bad type via legacy field",
        image: { data: "baddata", mimeType: "image/bmp" },
      })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unsupported type");
  });
});
