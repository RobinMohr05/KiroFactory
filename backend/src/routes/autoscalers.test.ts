/**
 * Tests for /api/autoscalers routes.
 * Uses the same mock-based pattern as routes/auth.viewmode.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../autoscaler-manager.js", () => ({
  createAutoScalerRecord: vi.fn(),
  getAllAutoScalers: vi.fn(),
  startAutoScaler: vi.fn(),
  stopAutoScaler: vi.fn(),
  deleteAutoScalerRecord: vi.fn(),
  updateAutoScalerRecord: vi.fn(),
  getAutoScalerSessionCounts: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("../db/autoscalers.js", () => ({
  getAutoScalerById: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  getUserId: vi.fn().mockReturnValue(1),
}));

vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { createAutoScalerRecord, getAllAutoScalers, startAutoScaler, stopAutoScaler, deleteAutoScalerRecord, updateAutoScalerRecord } from "../autoscaler-manager.js";
import { getAutoScalerById } from "../db/autoscalers.js";
import autoScalersRouter from "./autoscalers.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/autoscalers", autoScalersRouter);
  return app;
}

const AUTOSCALER_FIXTURE = {
  id: 1,
  name: "Test AutoScaler",
  userId: 1,
  agentName: "developer-agent",
  tabIds: [1],
  maxConcurrency: 5,
  idleTimeoutSeconds: 30,
  keepWarmWhileTasksExist: false,
  status: "stopped" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("AutoScaler routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/autoscalers", () => {
    it("returns all autoScalers for the authenticated user", async () => {
      vi.mocked(getAllAutoScalers).mockResolvedValue([AUTOSCALER_FIXTURE]);

      const res = await request(createApp()).get("/api/autoscalers");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("Test AutoScaler");
      expect(res.body[0].runningSessionCount).toBe(0);
    });
  });

  describe("POST /api/autoscalers", () => {
    it("creates a autoScaler and returns 201", async () => {
      vi.mocked(createAutoScalerRecord).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .post("/api/autoscalers")
        .send({ name: "Test AutoScaler", agentName: "developer-agent", tabIds: [1] });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Test AutoScaler");
      expect(createAutoScalerRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test AutoScaler",
          agentName: "developer-agent",
          tabIds: [1],
          userId: 1,
        })
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(createApp())
        .post("/api/autoscalers")
        .send({ agentName: "developer-agent", tabIds: [1] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name");
    });

    it("returns 400 when agentName is missing", async () => {
      const res = await request(createApp())
        .post("/api/autoscalers")
        .send({ name: "Test", tabIds: [1] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("agentName");
    });

    it("returns 400 when tabIds is empty", async () => {
      const res = await request(createApp())
        .post("/api/autoscalers")
        .send({ name: "Test", agentName: "dev", tabIds: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("tabIds");
    });
  });

  describe("POST /api/autoscalers/:id/start", () => {
    it("starts a autoScaler owned by the user", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);
      const runningAutoScaler = { ...AUTOSCALER_FIXTURE, status: "running" as const };
      vi.mocked(startAutoScaler).mockResolvedValue(runningAutoScaler);

      const res = await request(createApp())
        .post("/api/autoscalers/1/start");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("running");
    });

    it("returns 404 for another user's autoScaler", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue({ ...AUTOSCALER_FIXTURE, userId: 2 });

      const res = await request(createApp())
        .post("/api/autoscalers/1/start");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/autoscalers/:id/stop", () => {
    it("stops a autoScaler owned by the user", async () => {
      const runningAutoScaler = { ...AUTOSCALER_FIXTURE, status: "running" as const };
      vi.mocked(getAutoScalerById).mockResolvedValue(runningAutoScaler);
      const stoppedAutoScaler = { ...AUTOSCALER_FIXTURE, status: "stopped" as const };
      vi.mocked(stopAutoScaler).mockResolvedValue(stoppedAutoScaler);

      const res = await request(createApp())
        .post("/api/autoscalers/1/stop");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("stopped");
    });
  });

  describe("DELETE /api/autoscalers/:id", () => {
    it("deletes a autoScaler owned by the user", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);
      vi.mocked(deleteAutoScalerRecord).mockResolvedValue(true);

      const res = await request(createApp())
        .delete("/api/autoscalers/1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 for non-existent autoScaler", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(null);

      const res = await request(createApp())
        .delete("/api/autoscalers/999");

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/autoscalers/:id", () => {
    it("successfully edits a stopped auto-scaler and returns the updated object", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);
      const updated = { ...AUTOSCALER_FIXTURE, name: "Renamed" };
      vi.mocked(updateAutoScalerRecord).mockResolvedValue(updated);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ name: "Renamed" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Renamed");
      expect(updateAutoScalerRecord).toHaveBeenCalledWith(1, { name: "Renamed" });
    });

    it("editing tabIds re-syncs tab assignments", async () => {
      // NOTE: this test mocks updateAutoScalerRecord at the route level and
      // cannot catch DB-layer query-cardinality bugs (e.g. duplicate tab IDs
      // returned when N input tabIds × M existing tabs expand via OPTIONAL MATCH).
      // The fix for that class of bug — using WITH DISTINCT f before the final
      // OPTIONAL MATCH — lives in db/autoscalers.ts and requires a Neo4j
      // integration test to verify properly. This test only covers the route logic.
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);
      const updated = { ...AUTOSCALER_FIXTURE, tabIds: [2, 3] };
      vi.mocked(updateAutoScalerRecord).mockResolvedValue(updated);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ tabIds: [2, 3] });

      expect(res.status).toBe(200);
      expect(res.body.tabIds).toEqual([2, 3]);
      expect(updateAutoScalerRecord).toHaveBeenCalledWith(1, { tabIds: [2, 3] });
    });

    it("returns 409 when trying to edit a running auto-scaler", async () => {
      const runningAutoScaler = { ...AUTOSCALER_FIXTURE, status: "running" as const };
      vi.mocked(getAutoScalerById).mockResolvedValue(runningAutoScaler);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ name: "New Name" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Cannot edit a running auto-scaler");
    });

    it("returns 404 for a non-owned or missing auto-scaler", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(null);

      const res = await request(createApp())
        .patch("/api/autoscalers/999")
        .send({ name: "New Name" });

      expect(res.status).toBe(404);
    });

    it("returns 404 when auto-scaler belongs to another user", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue({ ...AUTOSCALER_FIXTURE, userId: 99 });

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ name: "New Name" });

      expect(res.status).toBe(404);
    });

    it("returns 400 when name is an empty string", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ name: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name");
    });

    it("returns 400 when agentName is an empty string", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ agentName: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("agentName");
    });

    it("returns 400 when tabIds is an empty array", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ tabIds: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("tabIds");
    });

    it("returns 400 when maxConcurrency is not a number", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ maxConcurrency: "fast" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("maxConcurrency");
    });

    it("returns 400 when idleTimeoutSeconds is not a number", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ idleTimeoutSeconds: "forever" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("idleTimeoutSeconds");
    });

    it("returns 400 for invalid (NaN) id", async () => {
      const res = await request(createApp())
        .patch("/api/autoscalers/abc")
        .send({ name: "New Name" });

      expect(res.status).toBe(400);
    });

    it("returns 400 when no fields are provided in the body", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No fields to update");
    });

    it("returns 404 when updateAutoScalerRecord returns null (concurrent delete)", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);
      vi.mocked(updateAutoScalerRecord).mockResolvedValue(null);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ name: "New Name" });

      expect(res.status).toBe(404);
    });

    it("returns 422 when all provided tabIds refer to non-existent tabs (DB layer returns null)", async () => {
      // First call: ownership check (returns the autoscaler)
      // Second call: re-fetch after null update to distinguish "deleted" from "invalid tabs"
      vi.mocked(getAutoScalerById)
        .mockResolvedValueOnce(AUTOSCALER_FIXTURE)  // ownership check
        .mockResolvedValueOnce(AUTOSCALER_FIXTURE); // re-fetch after null return
      // The DB layer returns null when all tabIds are invalid (no tabs were merged).
      vi.mocked(updateAutoScalerRecord).mockResolvedValue(null);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ tabIds: [9999, 8888] });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("tabIds");
    });

    it("returns 400 when model is not a string or null", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ model: 42 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("model");
    });

    it("accepts model as null (clears model)", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);
      const updated = { ...AUTOSCALER_FIXTURE, model: undefined };
      vi.mocked(updateAutoScalerRecord).mockResolvedValue(updated);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ model: null });

      expect(res.status).toBe(200);
    });

    it("trims leading/trailing whitespace from name before storing", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);
      const updated = { ...AUTOSCALER_FIXTURE, name: "Trimmed Name" };
      vi.mocked(updateAutoScalerRecord).mockResolvedValue(updated);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ name: "  Trimmed Name  " });

      expect(res.status).toBe(200);
      expect(updateAutoScalerRecord).toHaveBeenCalledWith(1, { name: "Trimmed Name" });
    });

    it("trims leading/trailing whitespace from agentName before storing", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);
      const updated = { ...AUTOSCALER_FIXTURE, agentName: "my-agent" };
      vi.mocked(updateAutoScalerRecord).mockResolvedValue(updated);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ agentName: "  my-agent  " });

      expect(res.status).toBe(200);
      expect(updateAutoScalerRecord).toHaveBeenCalledWith(1, { agentName: "my-agent" });
    });

    it("returns 400 when name is whitespace-only", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ name: "   " });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name");
    });

    it("returns 400 when agentName is whitespace-only", async () => {
      vi.mocked(getAutoScalerById).mockResolvedValue(AUTOSCALER_FIXTURE);

      const res = await request(createApp())
        .patch("/api/autoscalers/1")
        .send({ agentName: "   " });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("agentName");
    });
  });
});