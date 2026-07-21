import type { CredentialKey } from "./types.js";

/**
 * Validates a credential by making a lightweight API call to the target service.
 * Returns { valid: true } on success or { valid: false, error: string } on failure.
 */
export async function validateCredential(
  key: CredentialKey,
  value: string,
  extra?: Partial<Record<CredentialKey, string>>
): Promise<{ valid: boolean; error?: string }> {
  switch (key) {
    case "azureDevOpsPat":
      return validateAzureDevOpsPat(value);
    case "atlassianApiToken":
      return validateAtlassianApiToken(value, extra?.atlassianUsername ?? null);
    case "atlassianUsername":
      // Username alone can't be validated without the token
      return { valid: true };
    case "awsAccessKeyId":
      // Access Key ID alone can't be validated — just check format
      return validateAwsAccessKeyIdFormat(value);
    case "awsSecretAccessKey":
      // Secret Key alone can't be fully validated — just check format
      return validateAwsSecretAccessKeyFormat(value);
    default:
      return { valid: true };
  }
}

/**
 * Validates an Azure DevOps PAT by calling the Azure DevOps REST API.
 * Uses the _apis/connectionData endpoint which requires minimal permissions.
 */
async function validateAzureDevOpsPat(pat: string): Promise<{ valid: boolean; error?: string }> {
  try {
    // Use the Azure DevOps general API — connectionData works with any valid PAT
    const res = await fetch("https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1", {
      headers: {
        Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      return { valid: true };
    }

    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Invalid or expired PAT" };
    }

    return { valid: false, error: `Azure DevOps returned status ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("timeout") || message.includes("aborted")) {
      return { valid: false, error: "Connection timed out — check network" };
    }
    return { valid: false, error: `Connection failed: ${message}` };
  }
}

/**
 * Validates an Atlassian API token by calling the Atlassian REST API.
 * Requires the username (email) to authenticate.
 */
async function validateAtlassianApiToken(
  token: string,
  username: string | null
): Promise<{ valid: boolean; error?: string }> {
  if (!username) {
    return { valid: false, error: "Atlassian Username (email) is required to validate the token" };
  }

  try {
    // Use the Atlassian user profile endpoint — works with any valid token
    const res = await fetch("https://api.atlassian.com/me", {
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      return { valid: true };
    }

    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Invalid token or username" };
    }

    return { valid: false, error: `Atlassian returned status ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("timeout") || message.includes("aborted")) {
      return { valid: false, error: "Connection timed out — check network" };
    }
    return { valid: false, error: `Connection failed: ${message}` };
  }
}

/**
 * Validates the format of an AWS Access Key ID.
 * AWS Access Key IDs start with AKIA and are 20 characters.
 */
function validateAwsAccessKeyIdFormat(value: string): { valid: boolean; error?: string } {
  // AWS access key IDs are 20 chars, start with AKIA (for long-term credentials)
  // or ASIA (for temporary credentials)
  if (!/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(value)) {
    return { valid: false, error: "Invalid format — AWS Access Key IDs are 20 characters starting with AKIA or ASIA" };
  }
  return { valid: true };
}

/**
 * Validates the format of an AWS Secret Access Key.
 * AWS Secret Access Keys are 40 characters, base64-like.
 */
function validateAwsSecretAccessKeyFormat(value: string): { valid: boolean; error?: string } {
  // AWS secret keys are 40 characters of base64-ish characters
  if (!/^[A-Za-z0-9/+=]{40}$/.test(value)) {
    return { valid: false, error: "Invalid format — AWS Secret Access Keys are 40 characters" };
  }
  return { valid: true };
}
