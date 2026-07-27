import type { CredentialKey } from "./types.js";

/**
 * Result of validating a credential.
 *
 * - `valid: true`  — the credential was positively verified.
 * - `valid: false` — the credential could not be confirmed. Interpret with `blocking`:
 *     - `blocking: true`  — we are confident the value is wrong (e.g. malformed). Reject the save.
 *     - `blocking: false` — we could NOT verify it (the target service needs a scope or
 *                            context we don't have, or was unreachable). Save it anyway and
 *                            surface `error` as an advisory warning.
 *
 * Rationale: for network-backed credentials we usually only know the secret itself, not the
 * organization / site it belongs to, and PATs are intentionally minimally scoped (see ADR-002).
 * A failed remote check therefore does NOT prove the credential is bad, so it must not block the
 * user from saving. Only cheap, deterministic local checks (formats) are treated as blocking.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  blocking?: boolean;
}

/**
 * Validates a credential. Remote checks are best-effort and non-blocking; local format
 * checks are authoritative and blocking.
 */
export async function validateCredential(
  key: CredentialKey,
  value: string,
  extra?: Partial<Record<CredentialKey, string>>
): Promise<ValidationResult> {
  switch (key) {
    case "azureDevOpsPat":
      return validateAzureDevOpsPat(value);
    case "atlassianApiToken":
      return validateAtlassianApiToken(value, extra?.atlassianUsername ?? null);
    case "atlassianUsername":
      // Username alone can't be validated without the token.
      return { valid: true };
    case "awsAccessKeyId":
      return validateAwsAccessKeyIdFormat(value);
    case "awsSecretAccessKey":
      return validateAwsSecretAccessKeyFormat(value);
    case "githubPat":
      return validateGitHubPat(value);
    default:
      return { valid: true };
  }
}

/**
 * Validates a GitHub PAT.
 *
 * The worker uses this token to clone and, crucially, to PUSH the agent's branch.
 * A token that can read but not write produces a very late, very confusing failure
 * (the push fails only after the agent has finished its work), so we check the
 * granted scopes here and warn when write access is clearly missing.
 *
 * Format problems are blocking. Remote results are advisory: fine-grained tokens
 * don't report their scopes in headers, and GitHub may be unreachable.
 */
async function validateGitHubPat(token: string): Promise<ValidationResult> {
  if (/\s/.test(token)) {
    return {
      valid: false,
      blocking: true,
      error: "Invalid format — the token contains whitespace",
    };
  }

  // Known GitHub token forms: ghp_ (classic), github_pat_ (fine-grained),
  // gho_/ghu_/ghs_/ghr_ (OAuth / App / refresh), or a legacy 40-char hex token.
  const looksLikeToken =
    /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/.test(token) ||
    /^github_pat_[A-Za-z0-9_]{20,}$/.test(token) ||
    /^[a-f0-9]{40}$/.test(token);

  if (!looksLikeToken) {
    return {
      valid: false,
      blocking: true,
      error:
        "Invalid format — expected a GitHub token starting with ghp_ or github_pat_ (or a legacy 40-character token)",
    };
  }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 401) {
      return {
        valid: false,
        blocking: false,
        error: "GitHub rejected this token (401 — invalid or expired). Saved without verification.",
      };
    }

    if (!res.ok) {
      return {
        valid: false,
        blocking: false,
        error: `GitHub returned status ${res.status}. Saved without verification.`,
      };
    }

    // Classic tokens report their scopes; fine-grained tokens send an empty header.
    const scopes = res.headers.get("x-oauth-scopes");
    if (scopes !== null && scopes !== "" && !/(^|,\s*)(repo|public_repo)(,|$)/.test(scopes)) {
      return {
        valid: false,
        blocking: false,
        error:
          `Token is valid but has no repo scope (granted: ${scopes}). Cloning may work for public ` +
          `repositories, but pushing the agent's branch will fail. Saved anyway.`,
      };
    }

    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      valid: false,
      blocking: false,
      error: `Could not reach GitHub to verify the token (${message}). Saved without verification.`,
    };
  }
}

/**
 * Best-effort validation of an Azure DevOps PAT.
 *
 * We call the org-agnostic profile endpoint, but that endpoint requires the `vso.profile`
 * scope. Operational PATs are intentionally scoped to Code / Pull Request Threads / Build
 * (see ADR-002) and legitimately lack `vso.profile`, so a valid PAT commonly gets a 401/403
 * here. We therefore treat any *authenticated* response (2xx/401/403) as good enough and only
 * warn (never block) when the request was clearly not authenticated or the service was
 * unreachable.
 *
 * Note: `redirect: "manual"` is important. Azure DevOps bounces UNAUTHENTICATED requests to an
 * interactive sign-in page that returns HTTP 200. Following that redirect (the fetch default)
 * made even bogus tokens look valid, so we must inspect the redirect ourselves.
 */
async function validateAzureDevOpsPat(pat: string): Promise<ValidationResult> {
  try {
    const res = await fetch(
      "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1",
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      }
    );

    // 2xx: the PAT even has profile-read scope — definitely valid.
    if (res.ok) {
      return { valid: true };
    }

    // 401/403: Azure DevOps processed the token as credentials but denied the profile
    // endpoint. This is the expected response for a correctly-scoped operational PAT that
    // lacks `vso.profile`, so treat it as valid rather than rejecting a working token.
    if (res.status === 401 || res.status === 403) {
      return { valid: true };
    }

    // 3xx: redirected to a sign-in page — the request was not authenticated, which usually
    // means a bad/expired PAT. We can't be certain (and can't verify scope-limited PATs), so
    // save it with a warning instead of blocking.
    if (res.status >= 300 && res.status < 400) {
      return {
        valid: false,
        blocking: false,
        error:
          "Azure DevOps did not accept this token (not authenticated). Saved without verification — double-check the PAT if operations fail.",
      };
    }

    return {
      valid: false,
      blocking: false,
      error: `Azure DevOps returned status ${res.status}. Saved without verification.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Transient network / timeout issues must never block saving a credential.
    return {
      valid: false,
      blocking: false,
      error: `Could not reach Azure DevOps to verify the token (${message}). Saved without verification.`,
    };
  }
}

/**
 * Best-effort validation of an Atlassian API token. Requires the username (email).
 *
 * The remote check can confirm a good token but a non-2xx response does not prove the token is
 * bad (the identity endpoint may need context we don't have), so failures are advisory only.
 */
async function validateAtlassianApiToken(
  token: string,
  username: string | null
): Promise<ValidationResult> {
  if (!username) {
    return {
      valid: false,
      blocking: false,
      error:
        "Set the Atlassian Username (email) as well so the token can be verified. Saved without verification.",
    };
  }

  try {
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

    return {
      valid: false,
      blocking: false,
      error: `Atlassian did not confirm the token (status ${res.status}). Saved without verification — check the username and token if operations fail.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      valid: false,
      blocking: false,
      error: `Could not reach Atlassian to verify the token (${message}). Saved without verification.`,
    };
  }
}

/**
 * Validates the format of an AWS Access Key ID.
 * AWS Access Key IDs are 20 characters, starting with AKIA (long-term) or ASIA (temporary).
 * This is a cheap, deterministic check, so a failure is treated as blocking.
 */
function validateAwsAccessKeyIdFormat(value: string): ValidationResult {
  if (!/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(value)) {
    return {
      valid: false,
      blocking: true,
      error:
        "Invalid format — AWS Access Key IDs are 20 characters starting with AKIA or ASIA",
    };
  }
  return { valid: true };
}

/**
 * Validates the format of an AWS Secret Access Key.
 * AWS Secret Access Keys are 40 base64-ish characters.
 * This is a cheap, deterministic check, so a failure is treated as blocking.
 */
function validateAwsSecretAccessKeyFormat(value: string): ValidationResult {
  if (!/^[A-Za-z0-9/+=]{40}$/.test(value)) {
    return {
      valid: false,
      blocking: true,
      error: "Invalid format — AWS Secret Access Keys are 40 characters",
    };
  }
  return { valid: true };
}
