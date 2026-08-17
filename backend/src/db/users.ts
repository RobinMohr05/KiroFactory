/**
 * Neo4j-backed implementation of the users data-access layer.
 *
 * Every exported function here keeps the exact name, parameter types, and
 * return type it had under the previous mssql-based implementation — see
 * .kiro/specs/neo4j-migration/design.md for the full :User node model and
 * migration rationale. Only the internals (SQL -> Cypher, mssql pool ->
 * neo4j-driver managed transactions) change.
 */

import { readQuery, writeQuery } from "./connection.js";
import type { User, CreateUserInput, GitProvider } from "../types.js";
import { isGitProvider } from "../types.js";
import bcrypt from "bcrypt";
import { encrypt, decrypt } from "../crypto.js";
import { getNextId } from "./id-counter.js";
import type { ManagedTransaction } from "neo4j-driver";

const BCRYPT_ROUNDS = 12;

/**
 * Minimal typed view of a Neo4j Node value pulled out of a query result
 * record (e.g. `record.get("u")`) — just the bit every mapper here needs.
 */
interface NodeResult {
  properties: Record<string, unknown>;
}

/**
 * Map a Neo4j :User node's properties to a User object.
 * NEVER includes passwordHash, kiroApiKeyEncrypted, or any of the cred*
 * credential properties (matches the previous mapRowToUser's contract —
 * credentials.ts owns reading/writing the cred* fields, not this file).
 */
function mapNodeToUser(props: Record<string, unknown>): User {
  const provider = props.defaultGitProvider as string | null | undefined;
  return {
    id: props.id as number,
    email: props.email as string,
    defaultGitProvider: isGitProvider(provider) ? provider : null,
    // createdAt/updatedAt come back as neo4j-driver DateTime values, not a JS
    // Date — .toString() on those produces an ISO 8601 string directly.
    createdAt: (props.createdAt as { toString(): string }).toString(),
    updatedAt: (props.updatedAt as { toString(): string }).toString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new user. Hashes the password with bcrypt and encrypts the API key with AES-256.
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const kiroApiKeyEncrypted = encrypt(input.kiroApiKey);
  const id = await getNextId("User");

  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `CREATE (u:User {
         id: $id,
         email: $email,
         passwordHash: $passwordHash,
         kiroApiKeyEncrypted: $encrypted,
         createdAt: datetime(),
         updatedAt: datetime()
       })
       RETURN u`,
      { id, email: input.email, passwordHash, encrypted: kiroApiKeyEncrypted }
    );
    const node = result.records[0].get("u") as NodeResult;
    return mapNodeToUser(node.properties);
  });
}

/**
 * Get a user by ID (safe — no secrets returned).
 */
export async function getUserById(id: number): Promise<User | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(`MATCH (u:User {id: $id}) RETURN u`, { id });
    if (result.records.length === 0) return null;
    const node = result.records[0].get("u") as NodeResult;
    return mapNodeToUser(node.properties);
  });
}

/**
 * Get a user by email (safe — no secrets returned).
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(`MATCH (u:User {email: $email}) RETURN u`, { email });
    if (result.records.length === 0) return null;
    const node = result.records[0].get("u") as NodeResult;
    return mapNodeToUser(node.properties);
  });
}

/**
 * Verify a password against the stored hash for a given email.
 * Returns the user if valid, null otherwise.
 */
export async function verifyPassword(
  email: string,
  password: string
): Promise<User | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(`MATCH (u:User {email: $email}) RETURN u`, { email });
    if (result.records.length === 0) return null;

    const node = result.records[0].get("u") as NodeResult;
    const passwordHash = node.properties.passwordHash as string;
    const valid = await bcrypt.compare(password, passwordHash);

    if (!valid) return null;
    return mapNodeToUser(node.properties);
  });
}

/**
 * Verify a password against the stored hash for a given user ID.
 * Returns true if valid, false otherwise.
 */
export async function verifyPasswordById(
  userId: number,
  password: string
): Promise<boolean> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $id}) RETURN u.passwordHash AS passwordHash`,
      { id: userId }
    );
    if (result.records.length === 0) return false;

    const passwordHash = result.records[0].get("passwordHash") as string;
    return bcrypt.compare(password, passwordHash);
  });
}

/**
 * Get the decrypted Kiro API key for a user.
 * This should ONLY be used server-side for spawning ACP sessions — never exposed via API.
 */
export async function getUserKiroApiKey(userId: number): Promise<string | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $id}) RETURN u.kiroApiKeyEncrypted AS kiroApiKeyEncrypted`,
      { id: userId }
    );
    if (result.records.length === 0) return null;

    const encrypted = result.records[0].get("kiroApiKeyEncrypted") as string;
    return decrypt(encrypted);
  });
}

/**
 * Update a user's Kiro API key (re-encrypts with AES-256).
 */
export async function updateUserKiroApiKey(
  userId: number,
  newApiKey: string
): Promise<User | null> {
  const kiroApiKeyEncrypted = encrypt(newApiKey);

  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $id})
       SET u.kiroApiKeyEncrypted = $encrypted, u.updatedAt = datetime()
       RETURN u`,
      { id: userId, encrypted: kiroApiKeyEncrypted }
    );
    if (result.records.length === 0) return null;
    const node = result.records[0].get("u") as NodeResult;
    return mapNodeToUser(node.properties);
  });
}

/**
 * Set (or clear) the user's profile-level default git provider.
 * Pass null to clear it, which restores URL-based detection.
 */
export async function updateUserDefaultGitProvider(
  userId: number,
  provider: GitProvider | null
): Promise<User | null> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $id})
       SET u.defaultGitProvider = $provider, u.updatedAt = datetime()
       RETURN u`,
      { id: userId, provider }
    );
    if (result.records.length === 0) return null;
    const node = result.records[0].get("u") as NodeResult;
    return mapNodeToUser(node.properties);
  });
}

/**
 * Update a user's password (re-hashes with bcrypt).
 */
export async function updateUserPassword(
  userId: number,
  newPassword: string
): Promise<User | null> {
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $id})
       SET u.passwordHash = $passwordHash, u.updatedAt = datetime()
       RETURN u`,
      { id: userId, passwordHash }
    );
    if (result.records.length === 0) return null;
    const node = result.records[0].get("u") as NodeResult;
    return mapNodeToUser(node.properties);
  });
}

/**
 * Delete a user by ID.
 */
export async function deleteUser(id: number): Promise<boolean> {
  return writeQuery(async (tx: ManagedTransaction) => {
    // Preserve the original SQL Server safety behavior: tabs.user_id,
    // agents.user_id, and sessions.user_id all reference users(id) with no
    // "ON DELETE CASCADE" (see schema.sql) — deleting a user who still owned
    // any Tab/Agent/Session used to fail outright on the FK constraint,
    // rather than silently orphaning those rows or cascading into them.
    // Neo4j has no FK constraint to enforce this for us, so that safety
    // property is replicated explicitly here: if the user still owns
    // anything via :OWNS, refuse the delete (return false, touch nothing)
    // instead of deleting the user node or cascading into what it owns.
    const ownsCheck = await tx.run(
      `RETURN EXISTS { MATCH (u:User {id: $id})-[:OWNS]->() } AS ownsSomething`,
      { id }
    );
    const ownsSomething = ownsCheck.records[0].get("ownsSomething") as boolean;
    if (ownsSomething) return false;

    const result = await tx.run(`MATCH (u:User {id: $id}) DELETE u RETURN u`, { id });
    return result.records.length > 0;
  });
}

/**
 * List all users (safe — no secrets returned).
 */
export async function getAllUsers(): Promise<User[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(`MATCH (u:User) RETURN u ORDER BY u.createdAt ASC`);
    return result.records.map((record) => {
      const node = record.get("u") as NodeResult;
      return mapNodeToUser(node.properties);
    });
  });
}

/**
 * Check if a user is the first registered user (admin).
 * The first user is determined by the lowest ID. Under mssql this was the
 * first IDENTITY value; under Neo4j, id-counter.ts still allocates ids in
 * strictly increasing order per label, so "lowest id" remains the correct
 * "first" check.
 */
export async function isFirstUser(userId: number): Promise<boolean> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(`MATCH (u:User) RETURN u.id AS id ORDER BY u.id ASC LIMIT 1`);
    if (result.records.length === 0) return false;
    return result.records[0].get("id") === userId;
  });
}
