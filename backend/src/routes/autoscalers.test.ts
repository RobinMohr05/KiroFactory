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

import { createAutoScalerRecord, getAllAutoScalers, startAutoScaler, stopAutoScaler, deleteAutoScalerRecord } from "../autoscaler-manager.js";
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
});
