import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * Derives a 256-bit key from the ENCRYPTION_KEY env var using scrypt.
 * This ensures we get a proper-length key regardless of the env var length.
 */
function deriveKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is required for encryption operations"
    );
  }
  // Use a fixed salt derived from the secret itself — deterministic but still
  // strengthens short keys via scrypt's memory-hardness.
  const salt = "kirofactory-aes256-salt";
  return scryptSync(secret, salt, KEY_LENGTH);
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a hex-encoded string: iv + authTag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  // Format: iv (hex) + authTag (hex) + ciphertext (hex)
  return iv.toString("hex") + authTag.toString("hex") + encrypted;
}

/**
 * Decrypts an AES-256-GCM encrypted string (as produced by encrypt()).
 * Returns the original plaintext.
 */
export function decrypt(encryptedHex: string): string {
  const key = deriveKey();

  // Extract iv, authTag, and ciphertext from the hex string
  const ivHex = encryptedHex.slice(0, IV_LENGTH * 2);
  const authTagHex = encryptedHex.slice(
    IV_LENGTH * 2,
    IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2
  );
  const ciphertext = encryptedHex.slice(IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2);

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
