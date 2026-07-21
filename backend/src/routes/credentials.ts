import { Router, type Request, type Response } from "express";
import { getUserId } from "../middleware/auth.js";
import { getCredentialStatus, updateCredentials } from "../db/credentials.js";
import { validateCredential } from "../credential-validator.js";
import type { CredentialKey } from "../types.js";

const router = Router();

/** All valid credential keys (for input validation). */
const VALID_KEYS: Set<string> = new Set([
  "azureDevOpsPat",
  "atlassianApiToken",
  "atlassianUsername",
  "awsAccessKeyId",
  "awsSecretAccessKey",
]);

/**
 * GET /api/users/me/credentials
 * Returns which credentials are set (true/false), never the actual values.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const status = await getCredentialStatus(userId);
    res.json(status);
  } catch (err) {
    console.error("GET /api/users/me/credentials error:", err);
    res.status(500).json({ error: "Failed to fetch credential status" });
  }
});

/**
 * PUT /api/users/me/credentials
 * Accepts plaintext credentials, validates them, and stores encrypted.
 * Body: { [key: CredentialKey]: string | null }
 * - string value: set/update the credential
 * - null or "": clear the credential
 *
 * Query param: ?validate=true (default) — validate credentials before saving.
 * Set ?validate=false to skip validation.
 */
router.put("/", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const body = req.body as Record<string, unknown>;
    const shouldValidate = req.query.validate !== "false";

    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "Request body must be a JSON object" });
      return;
    }

    // Filter to only valid credential keys
    const credentials: Partial<Record<CredentialKey, string | null>> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!VALID_KEYS.has(key)) {
        res.status(400).json({ error: `Unknown credential key: ${key}` });
        return;
      }
      if (value !== null && value !== "" && typeof value !== "string") {
        res.status(400).json({ error: `Value for ${key} must be a string or null` });
        return;
      }
      credentials[key as CredentialKey] = value as string | null;
    }

    if (Object.keys(credentials).length === 0) {
      res.status(400).json({ error: "No credentials provided" });
      return;
    }

    // Validate credentials before saving (unless explicitly skipped)
    if (shouldValidate) {
      const validationErrors: Record<string, string> = {};

      for (const [key, value] of Object.entries(credentials)) {
        // Skip clearing operations and skip validation for null/empty
        if (value === null || value === "") continue;

        const result = await validateCredential(
          key as CredentialKey,
          value,
          // Pass other credentials being set in the same request (e.g., atlassianUsername for token validation)
          credentials as Partial<Record<CredentialKey, string>>
        );

        if (!result.valid) {
          validationErrors[key] = result.error ?? "Validation failed";
        }
      }

      if (Object.keys(validationErrors).length > 0) {
        res.status(422).json({
          error: "Credential validation failed",
          validationErrors,
        });
        return;
      }
    }

    // Store encrypted
    await updateCredentials(userId, credentials);

    // Return updated status
    const status = await getCredentialStatus(userId);
    res.json({ message: "Credentials updated successfully", status });
  } catch (err) {
    console.error("PUT /api/users/me/credentials error:", err);
    res.status(500).json({ error: "Failed to update credentials" });
  }
});

export default router;
