import { Router, type Request, type Response } from "express";
import { execSync } from "node:child_process";
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
 *
 * On any failure the response also includes a `detectionError` object with a
 * `code` and `message` to identify the root cause. Successful detection omits
 * `detectionError` entirely.
 *
 * GET /api/models/diagnostics — auth-gated diagnostic endpoint that returns
 * environment information to help identify why detection is failing. Never
 * returns secret values — only presence booleans.
 */

const router = Router();

router.use(requireAuth);

export interface DetectedModel {
  id: string;
  name: string;
  description: string | null;
}

/**
 * Detection failure codes:
 * - "binary-not-found": kiro-cli binary not found on PATH (spawn ENOENT)
 * - "timeout":          detection timed out before kiro-cli completed the handshake
 * - "acp-error":        kiro-cli spawned but the ACP handshake or session/new failed
 * - "no-models-field":  session/new succeeded but returned no models / empty availableModels
 */
export type DetectionErrorCode = "binary-not-found" | "timeout" | "acp-error" | "no-models-field";

export interface DetectionError {
  code: DetectionErrorCode;
  message: string;
}

export interface ModelsResponse {
  default: string;
  models: DetectedModel[];
  detectionError?: DetectionError;
}

/**
 * How long to wait for kiro-cli detection before giving up (ms).
 *
 * Defaults to 45s, with headroom above the measured ~27s cold-start latency
 * of `session/new` on a fresh kiro-cli (before its local cache/auth state is
 * warm). Overridable via MODEL_DETECTION_TIMEOUT_MS.
 */
const DETECTION_TIMEOUT_MS = Number(process.env.MODEL_DETECTION_TIMEOUT_MS) || 45_000;

/**
 * Successful-detection cache, held for the process lifetime. `null` means
 * "not yet successfully detected" — a failed detection leaves this null so a
 * later request retries.
 */
let cachedModels: DetectedModel[] | null = null;

/**
 * The last detection failure detail, held for the process lifetime (reset on
 * each detection attempt). Used by GET /api/models/diagnostics to report the
 * last observed failure code without requiring a new spawn.
 */
let lastDetectionError: DetectionError | null = null;

/**
 * Whether the last session/new response contained a models field, and how
 * many models it had. Used by GET /api/models/diagnostics.
 */
let lastSessionNewModelsInfo: { hasModelsField: boolean; modelsCount: number } | null = null;

/**
 * A tagged timeout error so `classifyDetectionError()` can distinguish a
 * detection timeout from other failures without parsing the message text.
 */
class DetectionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectionTimeoutError";
  }
}

/**
 * Classify a thrown detection error into one of the four `DetectionErrorCode`
 * values. The ENOENT check is done on `err.code` (set by Node's spawn error)
 * rather than on message text. The "no-models-field" code is NOT produced here
 * (it is handled in `detectModels` after the runner returns) — this function
 * only classifies errors that come from thrown rejections.
 */
function classifyDetectionError(err: unknown): DetectionError {
  if (err instanceof DetectionTimeoutError) {
    return { code: "timeout", message: err.message };
  }
  if (err instanceof Error) {
    // Node's spawn ENOENT error: the error message wraps our custom text
    // (see KiroRunner.create's ENOENT handler), but we also check err.code
    // (set by the original spawn error) for robustness.
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" ||
      err.message.includes("not found on PATH") ||
      err.message.includes("kiro-cli not found")
    ) {
      return { code: "binary-not-found", message: err.message };
    }
    return { code: "acp-error", message: err.message };
  }
  return { code: "acp-error", message: String(err) };
}

/**
 * Detect available models by spawning kiro-cli over ACP and reading its
 * advertised model state. Throws on any failure (missing binary, ACP error,
 * or timeout) — the caller maps that to the auto-only fallback.
 */
async function detectModels(timeoutMs: number = DETECTION_TIMEOUT_MS): Promise<DetectedModel[]> {
  let timer: NodeJS.Timeout | undefined;
  const runnerPromise = KiroRunner.create({ cwd: process.cwd() });

  // If the timeout wins the race, `runnerPromise` may still resolve afterward
  // with a live `kiro-cli acp` subprocess. Attach a cleanup so that a
  // late-arriving runner is always closed (reaped) instead of leaking for the
  // lifetime of the backend process. `timedOut` is flipped the moment the
  // timeout fires; the reaper only closes the runner in that case, leaving the
  // normal (runner-wins) path to the `finally` block below — so the subprocess
  // is never double-closed.
  let timedOut = false;
  runnerPromise
    .then((r) => {
      if (timedOut) {
        // Lost the race (timeout fired first) — close the orphaned subprocess.
        return r.close();
      }
    })
    .catch(() => {
      /* create() rejected, or close() failed — nothing to reap. */
    });

  let runner: KiroRunner | null = null;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new DetectionTimeoutError(`Model detection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    runner = await Promise.race([runnerPromise, timeout]);

    // Runner created successfully — check whether session/new returned models.
    const models = runner.availableModels;
    if (models.length === 0) {
      // session/new succeeded but no models were advertised — "no-models-field" case.
      const detail = runner.detectionFailureDetail ?? { hasModelsField: false, modelsCount: 0 };
      lastSessionNewModelsInfo = detail;
      throw Object.assign(
        new Error("session/new succeeded but returned no availableModels"),
        { _detectionCode: "no-models-field" as DetectionErrorCode }
      );
    }

    return models.map((m) => ({
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

/**
 * Detect available models, retrying exactly once if the first attempt times
 * out. A first-run/cold kiro-cli can be slow to start (auth/telemetry latency
 * on the very first spawn), so a single timeout is treated as potentially
 * transient: we spawn once more before giving up. Only a `DetectionTimeoutError`
 * triggers the retry — every other failure (missing binary, ACP error,
 * no-models-field) is non-transient and propagates immediately without a
 * second spawn.
 */
async function detectModelsWithRetry(
  timeoutMs: number = DETECTION_TIMEOUT_MS
): Promise<DetectedModel[]> {
  try {
    return await detectModels(timeoutMs);
  } catch (err) {
    if (err instanceof DetectionTimeoutError) {
      log.warn("model-detection-timeout-retry", {
        component: "models",
        timeoutMs,
        msg: "Model detection timed out — retrying once before falling back",
      });
      return detectModels(timeoutMs);
    }
    throw err;
  }
}

/**
 * Resolve the absolute path of `kiro-cli` by searching PATH entries.
 * Returns `null` if not found or if the lookup fails.
 * Never throws.
 */
function resolveKiroBinaryPath(): string | null {
  try {
    // `which` on Unix, `where` on Windows
    const cmd = process.platform === "win32" ? "where kiro-cli" : "which kiro-cli";
    const result = execSync(cmd, { encoding: "utf-8", timeout: 3000 }).trim();
    return result.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

// GET /api/models — detected models, or the auto-only fallback on failure.
router.get("/", async (_req: Request, res: Response) => {
  if (cachedModels) {
    res.json({ default: "auto", models: cachedModels } satisfies ModelsResponse);
    return;
  }

  // Reset last detection state before each attempt
  lastDetectionError = null;
  lastSessionNewModelsInfo = null;

  try {
    const models = await detectModelsWithRetry();
    cachedModels = models;
    res.json({ default: "auto", models } satisfies ModelsResponse);
  } catch (err) {
    // Classify the error into one of the four detection codes
    let detection: DetectionError;
    if (err instanceof Error && "_detectionCode" in err) {
      // Tagged error from the no-models-field case
      detection = {
        code: (err as Error & { _detectionCode: DetectionErrorCode })._detectionCode,
        message: err.message,
      };
    } else {
      detection = classifyDetectionError(err);
    }
    lastDetectionError = detection;

    // Resolve binary path for log context (presence check only, never log secret values)
    const resolvedBinaryPath = resolveKiroBinaryPath();
    const binaryFoundOnPath = resolvedBinaryPath !== null;

    // Missing binary / ACP error / timeout: log and return the auto-only
    // fallback WITHOUT caching, so a later request can recover.
    // NEVER log the value of KIRO_API_KEY or any AWS_* variable.
    log.error("model-detection-failed", {
      component: "models",
      method: "GET",
      path: "/api/models",
      detectionCode: detection.code,
      resolvedBinaryPath,
      binaryFoundOnPath,
      hasKiroApiKey: Boolean(process.env.KIRO_API_KEY),
      hasAwsCreds: Boolean(
        process.env.AWS_ACCESS_KEY_ID ||
        process.env.AWS_SECRET_ACCESS_KEY ||
        process.env.AWS_SESSION_TOKEN
      ),
      ...toErrorFields(err),
      msg: `Failed to detect available models (${detection.code}) — returning auto-only fallback`,
    });
    res.json({ default: "auto", models: [], detectionError: detection } satisfies ModelsResponse);
  }
});

// GET /api/models/diagnostics — auth-gated diagnostic info to identify
// why model detection is failing. Returns presence booleans for secrets,
// never the actual values.
router.get("/diagnostics", async (_req: Request, res: Response) => {
  const resolvedKiroPath = resolveKiroBinaryPath();
  const binaryFoundOnPath = resolvedKiroPath !== null;
  const pathEntries = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);

  const hasKiroApiKey = Boolean(process.env.KIRO_API_KEY);
  const hasAwsCreds = Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.AWS_SESSION_TOKEN
  );

  // If we haven't attempted detection yet (no lastDetectionError and no cache),
  // trigger a detection attempt so the diagnostics include fresh data.
  if (!cachedModels && !lastDetectionError) {
    // Reset last detection state before this attempt
    lastSessionNewModelsInfo = null;
    try {
      const models = await detectModelsWithRetry();
      cachedModels = models;
    } catch (err) {
      if (err instanceof Error && "_detectionCode" in err) {
        lastDetectionError = {
          code: (err as Error & { _detectionCode: DetectionErrorCode })._detectionCode,
          message: err.message,
        };
      } else {
        lastDetectionError = classifyDetectionError(err);
      }
    }
  }

  const modelsCount = cachedModels?.length
    ?? lastSessionNewModelsInfo?.modelsCount
    ?? 0;

  res.json({
    resolvedKiroPath,
    binaryFoundOnPath,
    pathEntries,
    hasKiroApiKey,
    hasAwsCreds,
    lastDetectionCode: lastDetectionError?.code ?? null,
    lastDetectionMessage: lastDetectionError?.message ?? null,
    modelsCount,
    sessionNewHasModelsField: lastSessionNewModelsInfo?.hasModelsField ?? null,
  });
});

/**
 * Return the list of detected model IDs (the literal kiro-cli identifiers,
 * e.g. "claude-sonnet-4.6"), reusing the same process-lifetime cache and
 * detection path as `GET /api/models`.
 *
 * On detection failure (missing binary / ACP error / timeout) this resolves
 * to an empty array rather than throwing — callers treat "no detected models"
 * the same as "model unavailable" and fall back accordingly. Successful
 * detections are cached so repeated callers don't re-spawn kiro-cli.
 */
export async function getDetectedModelIds(): Promise<string[]> {
  if (cachedModels) return cachedModels.map((m) => m.id);
  try {
    const models = await detectModelsWithRetry();
    cachedModels = models;
    return models.map((m) => m.id);
  } catch (err) {
    log.error("model-detection-failed", {
      component: "models",
      ...toErrorFields(err),
      msg: "Failed to detect available models — treating as none detected",
    });
    return [];
  }
}

export default router;

/**
 * Eagerly warm the process-lifetime models cache at server startup.
 *
 * Kicks off the same detection path as `GET /api/models` / `getDetectedModelIds()`
 * once, so the first real user request is very likely to hit an
 * already-populated `cachedModels` instead of paying the cold-start
 * (~27s `session/new`) latency inline and risking a detection timeout.
 *
 * Designed to be fire-and-forget from `start()`: it never throws — a failed
 * detection is swallowed here (already logged inside `getDetectedModelIds()`)
 * and simply leaves the cache unpopulated so the first request retries, exactly
 * like the existing ACA preflight check. Safe to call without awaiting into the
 * startup critical path.
 */
export async function warmModelsCache(): Promise<void> {
  try {
    await getDetectedModelIds();
  } catch {
    /* getDetectedModelIds never throws; this is a safety net only. */
  }
}
