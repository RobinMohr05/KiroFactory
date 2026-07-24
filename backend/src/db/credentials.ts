import { getPool, sql } from "./connection.js";
import { encrypt, decrypt } from "../crypto.js";
import type { CredentialStatus, CredentialKey } from "../types.js";

/**
 * All supported credential keys.
 * Maps to columns in the users table.
 */
const CREDENTIAL_COLUMNS: Record<CredentialKey, string> = {
  azureDevOpsPat: "cred_azure_devops_pat",
  atlassianApiToken: "cred_atlassian_api_token",
  atlassianUsername: "cred_atlassian_username",
  awsAccessKeyId: "cred_aws_access_key_id",
  awsSecretAccessKey: "cred_aws_secret_access_key",
  githubPat: "cred_github_pat",
};

/**
 * Get the set/unset status of all credentials for a user.
 * Never returns actual values — only booleans.
 */
export async function getCredentialStatus(userId: number): Promise<CredentialStatus> {
  const pool = await getPool();
  const columns = Object.values(CREDENTIAL_COLUMNS).join(", ");

  const result = await pool
    .request()
    .input("id", sql.Int, userId)
    .query(`SELECT ${columns} FROM users WHERE id = @id`);

  if (result.recordset.length === 0) {
    return {
      azureDevOpsPat: false,
      atlassianApiToken: false,
      atlassianUsername: false,
      awsAccessKeyId: false,
      awsSecretAccessKey: false,
      githubPat: false,
    };
  }

  const row = result.recordset[0];
  const status: CredentialStatus = {} as CredentialStatus;

  for (const [key, col] of Object.entries(CREDENTIAL_COLUMNS)) {
    status[key as CredentialKey] = row[col] != null && row[col] !== "";
  }

  return status;
}

/**
 * Update one or more credentials for a user.
 * Values are encrypted before storage. Empty string or null means "clear this credential".
 */
export async function updateCredentials(
  userId: number,
  credentials: Partial<Record<CredentialKey, string | null>>
): Promise<void> {
  const pool = await getPool();

  // Build dynamic SET clause
  const setClauses: string[] = [];
  const request = pool.request().input("id", sql.Int, userId);

  let paramIdx = 0;
  for (const [key, value] of Object.entries(credentials)) {
    const col = CREDENTIAL_COLUMNS[key as CredentialKey];
    if (!col) continue;

    const paramName = `p${paramIdx++}`;
    if (value === null || value === "") {
      setClauses.push(`${col} = NULL`);
    } else {
      const encrypted = encrypt(value);
      request.input(paramName, sql.NVarChar(sql.MAX), encrypted);
      setClauses.push(`${col} = @${paramName}`);
    }
  }

  if (setClauses.length === 0) return;

  // Always update updated_at
  setClauses.push("updated_at = GETUTCDATE()");

  await request.query(`
    UPDATE users SET ${setClauses.join(", ")} WHERE id = @id
  `);
}

/**
 * Get a decrypted credential value for a user.
 * ONLY used server-side for spawning workers — never exposed via API.
 */
export async function getDecryptedCredential(
  userId: number,
  key: CredentialKey
): Promise<string | null> {
  const col = CREDENTIAL_COLUMNS[key];
  if (!col) return null;

  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, userId)
    .query(`SELECT ${col} FROM users WHERE id = @id`);

  if (result.recordset.length === 0) return null;

  const encrypted = result.recordset[0][col] as string | null;
  if (!encrypted) return null;

  return decrypt(encrypted);
}

/**
 * Get all decrypted credentials for a user (for passing to a worker as env vars).
 * ONLY used server-side — never exposed via API.
 */
export async function getAllDecryptedCredentials(
  userId: number
): Promise<Partial<Record<CredentialKey, string>>> {
  const pool = await getPool();
  const columns = Object.values(CREDENTIAL_COLUMNS).join(", ");

  const result = await pool
    .request()
    .input("id", sql.Int, userId)
    .query(`SELECT ${columns} FROM users WHERE id = @id`);

  if (result.recordset.length === 0) return {};

  const row = result.recordset[0];
  const creds: Partial<Record<CredentialKey, string>> = {};

  for (const [key, col] of Object.entries(CREDENTIAL_COLUMNS)) {
    const encrypted = row[col] as string | null;
    if (encrypted) {
      try {
        creds[key as CredentialKey] = decrypt(encrypted);
      } catch {
        // Skip corrupted credentials silently
      }
    }
  }

  return creds;
}
