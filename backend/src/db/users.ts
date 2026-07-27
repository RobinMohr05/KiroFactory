import { getPool, sql } from "./connection.js";
import type { User, CreateUserInput, GitProvider } from "../types.js";
import { isGitProvider } from "../types.js";
import bcrypt from "bcrypt";
import { encrypt, decrypt } from "../crypto.js";

const BCRYPT_ROUNDS = 12;

/**
 * Map a raw DB row to a User object.
 * NEVER includes password_hash or kiro_api_key_encrypted.
 */
function mapRowToUser(row: Record<string, unknown>): User {
  const provider = row.default_git_provider as string | null | undefined;
  return {
    id: row.id as number,
    email: row.email as string,
    defaultGitProvider: isGitProvider(provider) ? provider : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new user. Hashes the password with bcrypt and encrypts the API key with AES-256.
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  const pool = await getPool();

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const kiroApiKeyEncrypted = encrypt(input.kiroApiKey);

  const result = await pool
    .request()
    .input("email", sql.NVarChar(255), input.email)
    .input("passwordHash", sql.NVarChar(sql.MAX), passwordHash)
    .input("kiroApiKeyEncrypted", sql.NVarChar(sql.MAX), kiroApiKeyEncrypted)
    .query(`
      INSERT INTO users (email, password_hash, kiro_api_key_encrypted)
      OUTPUT INSERTED.*
      VALUES (@email, @passwordHash, @kiroApiKeyEncrypted)
    `);

  return mapRowToUser(result.recordset[0]);
}

/**
 * Get a user by ID (safe — no secrets returned).
 */
export async function getUserById(id: number): Promise<User | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM users WHERE id = @id");

  if (result.recordset.length === 0) return null;
  return mapRowToUser(result.recordset[0]);
}

/**
 * Get a user by email (safe — no secrets returned).
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("email", sql.NVarChar(255), email)
    .query("SELECT * FROM users WHERE email = @email");

  if (result.recordset.length === 0) return null;
  return mapRowToUser(result.recordset[0]);
}

/**
 * Verify a password against the stored hash for a given email.
 * Returns the user if valid, null otherwise.
 */
export async function verifyPassword(
  email: string,
  password: string
): Promise<User | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("email", sql.NVarChar(255), email)
    .query("SELECT * FROM users WHERE email = @email");

  if (result.recordset.length === 0) return null;

  const row = result.recordset[0];
  const passwordHash = row.password_hash as string;
  const valid = await bcrypt.compare(password, passwordHash);

  if (!valid) return null;
  return mapRowToUser(row);
}

/**
 * Verify a password against the stored hash for a given user ID.
 * Returns true if valid, false otherwise.
 */
export async function verifyPasswordById(
  userId: number,
  password: string
): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, userId)
    .query("SELECT password_hash FROM users WHERE id = @id");

  if (result.recordset.length === 0) return false;

  const passwordHash = result.recordset[0].password_hash as string;
  return bcrypt.compare(password, passwordHash);
}

/**
 * Get the decrypted Kiro API key for a user.
 * This should ONLY be used server-side for spawning ACP sessions — never exposed via API.
 */
export async function getUserKiroApiKey(userId: number): Promise<string | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, userId)
    .query("SELECT kiro_api_key_encrypted FROM users WHERE id = @id");

  if (result.recordset.length === 0) return null;

  const encrypted = result.recordset[0].kiro_api_key_encrypted as string;
  return decrypt(encrypted);
}

/**
 * Update a user's Kiro API key (re-encrypts with AES-256).
 */
export async function updateUserKiroApiKey(
  userId: number,
  newApiKey: string
): Promise<User | null> {
  const pool = await getPool();
  const kiroApiKeyEncrypted = encrypt(newApiKey);

  const result = await pool
    .request()
    .input("id", sql.Int, userId)
    .input("kiroApiKeyEncrypted", sql.NVarChar(sql.MAX), kiroApiKeyEncrypted)
    .query(`
      UPDATE users
      SET kiro_api_key_encrypted = @kiroApiKeyEncrypted, updated_at = GETUTCDATE()
      OUTPUT INSERTED.*
      WHERE id = @id
    `);

  if (result.recordset.length === 0) return null;
  return mapRowToUser(result.recordset[0]);
}

/**
 * Set (or clear) the user's profile-level default git provider.
 * Pass null to clear it, which restores URL-based detection.
 */
export async function updateUserDefaultGitProvider(
  userId: number,
  provider: GitProvider | null
): Promise<User | null> {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("id", sql.Int, userId)
    .input("provider", sql.VarChar(20), provider)
    .query(`
      UPDATE users
      SET default_git_provider = @provider, updated_at = GETUTCDATE()
      OUTPUT INSERTED.*
      WHERE id = @id
    `);

  if (result.recordset.length === 0) return null;
  return mapRowToUser(result.recordset[0]);
}

/**
 * Update a user's password (re-hashes with bcrypt).
 */
export async function updateUserPassword(
  userId: number,
  newPassword: string
): Promise<User | null> {
  const pool = await getPool();
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  const result = await pool
    .request()
    .input("id", sql.Int, userId)
    .input("passwordHash", sql.NVarChar(sql.MAX), passwordHash)
    .query(`
      UPDATE users
      SET password_hash = @passwordHash, updated_at = GETUTCDATE()
      OUTPUT INSERTED.*
      WHERE id = @id
    `);

  if (result.recordset.length === 0) return null;
  return mapRowToUser(result.recordset[0]);
}

/**
 * Delete a user by ID.
 */
export async function deleteUser(id: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("DELETE FROM users WHERE id = @id");

  return (result.rowsAffected[0] ?? 0) > 0;
}

/**
 * List all users (safe — no secrets returned).
 */
export async function getAllUsers(): Promise<User[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query("SELECT * FROM users ORDER BY created_at ASC");

  return result.recordset.map(mapRowToUser);
}

/**
 * Check if a user is the first registered user (admin).
 * The first user is determined by the lowest ID (first IDENTITY value).
 */
export async function isFirstUser(userId: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query("SELECT TOP 1 id FROM users ORDER BY id ASC");

  if (result.recordset.length === 0) return false;
  return result.recordset[0].id === userId;
}
