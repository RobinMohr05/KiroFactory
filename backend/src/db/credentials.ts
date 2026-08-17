import type { ManagedTransaction, Node } from "neo4j-driver";
import { readQuery, writeQuery } from "./connection.js";
import { encrypt, decrypt } from "../crypto.js";
import type { CredentialStatus, CredentialKey } from "../types.js";

/**
 * All supported credential keys.
 * Maps to camelCase properties on the :User node (see design.md — the six
 * `cred_*` SQL columns become `cred*` properties directly on the User node,
 * no separate credentials label/relationship).
 */
const CREDENTIAL_COLUMNS: Record<CredentialKey, string> = {
  azureDevOpsPat: "credAzureDevOpsPat",
  atlassianApiToken: "credAtlassianApiToken",
  atlassianUsername: "credAtlassianUsername",
  awsAccessKeyId: "credAwsAccessKeyId",
  awsSecretAccessKey: "credAwsSecretAccessKey",
  githubPat: "credGithubPat",
};

/**
 * Get the set/unset status of all credentials for a user.
 * Never returns actual values — only booleans.
 */
export async function getCredentialStatus(userId: number): Promise<CredentialStatus> {
  const records = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run("MATCH (u:User {id: $userId}) RETURN u", { userId });
    return result.records;
  });

  if (records.length === 0) {
    return {
      azureDevOpsPat: false,
      atlassianApiToken: false,
      atlassianUsername: false,
      awsAccessKeyId: false,
      awsSecretAccessKey: false,
      githubPat: false,
    };
  }

  const node = records[0].get("u") as Node;
  const status: CredentialStatus = {} as CredentialStatus;

  for (const [key, prop] of Object.entries(CREDENTIAL_COLUMNS)) {
    const value = node.properties[prop] as string | null | undefined;
    status[key as CredentialKey] = value != null && value !== "";
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
  // Build dynamic SET/REMOVE clauses
  const setClauses: string[] = [];
  const removeClauses: string[] = [];
  const params: Record<string, unknown> = { userId };

  let paramIdx = 0;
  for (const [key, value] of Object.entries(credentials)) {
    const prop = CREDENTIAL_COLUMNS[key as CredentialKey];
    if (!prop) continue;

    if (value === null || value === "") {
      // Cypher has no property-level NULL assignment (`SET u.x = null` is
      // invalid) — REMOVE is how a property is actually cleared, unlike
      // SQL's `col = NULL`.
      removeClauses.push(`u.${prop}`);
    } else {
      const paramName = `p${paramIdx++}`;
      params[paramName] = encrypt(value);
      setClauses.push(`u.${prop} = $${paramName}`);
    }
  }

  if (setClauses.length === 0 && removeClauses.length === 0) return;

  // Always update updatedAt alongside any real change.
  setClauses.push("u.updatedAt = datetime()");

  const clauses = [`SET ${setClauses.join(", ")}`];
  if (removeClauses.length > 0) {
    clauses.push(`REMOVE ${removeClauses.join(", ")}`);
  }

  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(`MATCH (u:User {id: $userId}) ${clauses.join(" ")}`, params);
  });
}

/**
 * Get a decrypted credential value for a user.
 * ONLY used server-side for spawning workers — never exposed via API.
 */
export async function getDecryptedCredential(
  userId: number,
  key: CredentialKey
): Promise<string | null> {
  const prop = CREDENTIAL_COLUMNS[key];
  if (!prop) return null;

  // `prop` only ever comes from the fixed CREDENTIAL_COLUMNS map above,
  // never from request input, so interpolating it into the query string here
  // is safe — the actual untrusted input (userId) stays parameterized.
  const records = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(`MATCH (u:User {id: $userId}) RETURN u.${prop} AS value`, {
      userId,
    });
    return result.records;
  });

  if (records.length === 0) return null;

  const encrypted = records[0].get("value") as string | null;
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
  const records = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run("MATCH (u:User {id: $userId}) RETURN u", { userId });
    return result.records;
  });

  if (records.length === 0) return {};

  const node = records[0].get("u") as Node;
  const creds: Partial<Record<CredentialKey, string>> = {};

  for (const [key, prop] of Object.entries(CREDENTIAL_COLUMNS)) {
    const encrypted = node.properties[prop] as string | null | undefined;
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
