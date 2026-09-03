import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { KiroRunner } from "../agent/kiro-runner.js";
import { log, toErrorFields } from "../logger.js";

/**
 * GET /api/models — report the models the installed kiro-cli supports.
 *
 * Detection spawns `kiro-cli acp`, performs the ACP handshake + session/new
 * (reusing KiroRunner), and reads the agent's advertised model state
 * (`SessionModelState.availableModels`). Each ACP `ModelInfo`
 * ({ modelId, name, description? }) is mapped to `{ id, name, description }`.
 *
 * The successfully detected list is cached in-memory for the lifetime of the
 * backend process (first request detects; subsequent requests serve the
 * cache). On detection failure (kiro-cli not installed, spawn ENOENT, ACP
 * error, or timeout) the endpoint logs server-side and returns the auto-only
 * fallback `{ default: "auto", models: [] }` WITHOUT caching, so a later
 * request can recover once kiro-cli becomes available. It never throws a 500
 * for the missing-binary case.
 */

const router = Router();

router.use(requireAuth);

export interface DetectedModel {
  id: string;
  name: string;
  description: string | null;
}

export interface ModelsResponse {
  default: string;
  models: DetectedModel[];
}

/** How long to wait for kiro-cli detection before giving up (ms). */
const DETECTION_TIMEOUT_MS = 20_000;

/**
 * Successful-detection cache, held for the process lifetime. `null` means
 * "not yet successfully detected" — a failed detection leaves this null so a
 * later request retries.
 */
let cachedModels: DetectedModel[] | null = null;

/**
 * Detect available models by spawning kiro-cli over ACP and reading its
 * advertised model state. Throws on any failure (missing binary, ACP error,
 * or timeout) — the caller maps that to the auto-only fallback.
 */
async function detectModels(): Promise<DetectedModel[]> {
  let runner: KiroRunner | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const runnerPromise = KiroRunner.create({ cwd: process.cwd() });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Model detection timed out after ${DETECTION_TIMEOUT_MS}ms`)),
        DETECTION_TIMEOUT_MS
      );
    });
    runner = await Promise.race([runnerPromise, timeout]);
    return runner.availableModels.map((m) => ({
      id: m.modelId,
      name: m.name,
      description: m.description ?? null,
    }));
  } finally {
    if (timer) clearTimeout(timer);
    if (runner) {
      try {
        await runner.close();
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// GET /api/models — detected models, or the auto-only fallback on failure.
router.get("/", async (_req: Request, res: Response) => {
  if (cachedModels) {
    res.json({ default: "auto", models: cachedModels } satisfies ModelsResponse);
    return;
  }

  try {
    const models = await detectModels();
    cachedModels = models;
    res.json({ default: "auto", models } satisfies ModelsResponse);
  } catch (err) {
    // Missing binary / ACP error / timeout: log and return the auto-only
    // fallback WITHOUT caching, so a later request can recover.
    log.error("model-detection-failed", {
      component: "models",
      method: "GET",
      path: "/api/models",
      ...toErrorFields(err),
      msg: "Failed to detect available models — returning auto-only fallback",
    });
    res.json({ default: "auto", models: [] } satisfies ModelsResponse);
  }
});

export default router;
