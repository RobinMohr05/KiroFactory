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
import type { User, CreateUserInput, GitProvider, UiViewMode } from "../types.js";
import { isGitProvider, isUiViewMode } from "../types.js";
import bcrypt from "bcrypt";
import { encrypt, decrypt } from "../crypto.js";
import { getNextId } from "./id-counter.js";
import type { ManagedTransaction } from "neo4j-driver";

const BCRYPT_ROUNDS = 12;

/**
 * Precomputed bcrypt hash of a throwaway value, at the same cost factor as
 * real password hashes (BCRYPT_ROUNDS). When verifyPassword is called for an
 * email that has no matching user, we still run bcrypt.compare against this
 * dummy hash so the request takes the same amount of time as one for an
 * existing user. Without this, the "no user" path would return immediately,
 * leaking account existence via a timing side channel (user enumeration —
 * OWASP A07). The plaintext is irrelevant; it just needs to be a valid
 * $2b$ hash at the correct cost so the compare does the full amount of work.
 */
const DUMMY_PASSWORD_HASH =
  "$2b$12$3csTTqUhTu8zmHFqxdv8TevJRiHuG12OpCEyI7T/kYVjgwxoBOgAe";

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
  const viewMode = props.uiViewMode as string | undefined;
  return {
    id: props.id as number,
    email: props.email as string,
    defaultGitProvider: isGitProvider(provider) ? provider : null,
    // Default to "easy" for rows that predate this column (existing users).
    uiViewMode: isUiViewMode(viewMode) ? viewMode : "easy",
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
         uiViewMode: "easy",
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
    if (result.records.length === 0) {
      // No user with this email. Still run a bcrypt.compare against a dummy
      // hash so this path costs the same as the "user exists" path — otherwise
      // the early return leaks account existence via a timing side channel
      // (user enumeration). Discard the result and return null regardless.
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return null;
    }

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
 * Set the user's top-level UI view mode ("easy" or "advanced").
 */
export async function updateUserViewMode(
  userId: number,
  viewMode: UiViewMode
): Promise<User | null> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $id})
       SET u.uiViewMode = $viewMode, u.updatedAt = datetime()
       RETURN u`,
      { id: userId, viewMode }
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
 * Delete a user by ID (self-service account deletion).
 *
 * The original SQL Server schema refused to delete a user who still owned any
 * Tab/Agent/Session row (FK with no ON DELETE CASCADE). A first Neo4j port
 * replicated that by refusing whenever the user owned ANYTHING via :OWNS —
 * but that guard can never pass for a real user: every registered user is
 * auto-provisioned a permanent "Chat" :Session at registration (and
 * migrate.ts backfills it), so `(:User)-[:OWNS]->(:Session)` always exists
 * and account deletion was completely broken (DELETE /api/auth/me always
 * 404'd). See task #1972.
 *
 * The guard is therefore narrowed to only the node types that must NOT be
 * silently destroyed — Tab, Agent, AutoScaler (shared/config-like resources).
 * If the user still owns any of those, refuse the delete (return false, touch
 * nothing) so the caller can surface a clear error instead of quietly
 * orphaning or cascading into them.
 *
 * The remaining owned node types are per-user, disposable, and safe to remove
 * along with the account, so they're cascade-cleaned in the same transaction:
 *   - :Session (+ its HAS_MCP_SERVER / HAS_RAW_MCP_SERVER / HAS_MCP_CONFIG_OVERRIDE
 *     config children and HAS_TURN turns)
 *   - :PlannerConversation (+ its HAS_MESSAGE messages)
 * DETACH DELETE tolerates null operands from OPTIONAL MATCHes that found
 * nothing, so this single statement is correct whether or not the user has
 * any of these.
 */
export async function deleteUser(id: number): Promise<boolean> {
  return writeQuery(async (tx: ManagedTransaction) => {
    // Refuse the delete only if the user still owns a protected node type
    // (Tab/Agent/AutoScaler) that shouldn't be silently destroyed.
    const guard = await tx.run(
      `RETURN EXISTS {
         MATCH (u:User {id: $id})-[:OWNS]->(owned)
         WHERE owned:Tab OR owned:Agent OR owned:AutoScaler
       } AS blocked`,
      { id }
    );
    const blocked = guard.records[0].get("blocked") as boolean;
    if (blocked) return false;

    // Cascade-clean the user's disposable owned nodes, then delete the user.
    const result = await tx.run(
      `MATCH (u:User {id: $id})
       OPTIONAL MATCH (u)-[:OWNS]->(s:Session)
       OPTIONAL MATCH (s)-[:HAS_MCP_SERVER|HAS_RAW_MCP_SERVER|HAS_MCP_CONFIG_OVERRIDE]->(sc)
       OPTIONAL MATCH (s)-[:HAS_TURN]->(turn:Turn)
       OPTIONAL MATCH (u)-[:OWNS]->(c:PlannerConversation)
       OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(pm:PlannerMessage)
       DETACH DELETE u, s, sc, turn, c, pm
       RETURN count(DISTINCT u) AS deletedCount`,
      { id }
    );
    return (result.records[0]?.get("deletedCount") as number) > 0;
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
