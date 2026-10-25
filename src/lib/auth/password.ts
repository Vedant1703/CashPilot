/**
 * CashPilot AI — Password Hashing & Verification Utilities
 *
 * SRS § 7: Security & Financial Integrity
 *
 * Invariants:
 *   - Uses Node.js crypto.scrypt with a unique, cryptographically random salt (16 bytes).
 *   - Stored in a self-describing, versioned format:
 *       $scrypt$v=1$N=<cost>,r=<blockSize>,p=<parallelization>$<saltHex>$<derivedKeyHex>
 *   - Format is strictly validated before verification.
 *   - Explicitly rejects !LOCKED:* placeholders, legacy markers, and malformed strings.
 *   - Uses crypto.timingSafeEqual for constant-time comparison to prevent timing attacks.
 *   - Generic error handling: never exposes passwords, hashes, or internal errors.
 */

import crypto from "crypto";

function scryptPromise(
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });
}

// Default scrypt parameters: N=16384 (2^14), r=8, p=1, keylen=64
export const SCRYPT_CONFIG = {
  version: 1,
  cost: 16384, // N: CPU/memory cost parameter (must be power of 2)
  blockSize: 8, // r: block size parameter
  parallelization: 1, // p: parallelization parameter
  saltBytes: 16, // 128 bits of entropy
  keyLength: 64, // 512-bit derived key
  maxmem: 32 * 1024 * 1024, // 32MB max memory
} as const;

const HASH_REGEX =
  /^\$scrypt\$v=1\$N=(\d+),r=(\d+),p=(\d+)\$([0-9a-fA-F]{32,128})\$([0-9a-fA-F]{64,256})$/;

/**
 * Safe, pre-computed valid dummy scrypt hash for timing equalization.
 * Matches N=16384, r=8, p=1, 16-byte salt, 64-byte key.
 * Used during failed logins (non-existent user, locked user) to prevent timing-based user enumeration.
 */
export const DUMMY_SCRYPT_HASH =
  "$scrypt$v=1$N=16384,r=8,p=1$a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4$e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

/**
 * Checks whether a stored string is a machine-valid, usable scrypt password hash.
 * Immediately rejects null, undefined, empty, !LOCKED:*, legacy, or malformed strings.
 * Validates that N is a power of two and parameters reside within safe upper/lower bounds.
 */
export function isUsablePasswordHash(hash: unknown): boolean {
  if (typeof hash !== "string" || hash.length === 0) {
    return false;
  }

  // Explicit check: reject locked, placeholder, or disabled accounts
  if (hash.startsWith("!") || hash.startsWith("!LOCKED:")) {
    return false;
  }

  const match = hash.match(HASH_REGEX);
  if (!match) {
    return false;
  }

  const [, nStr, rStr, pStr] = match;
  const N = parseInt(nStr, 10);
  const r = parseInt(rStr, 10);
  const p = parseInt(pStr, 10);

  // Validate strict parameter bounds
  if (
    isNaN(N) ||
    isNaN(r) ||
    isNaN(p) ||
    N <= 1 ||
    N > 65536 ||
    (N & (N - 1)) !== 0 || // N must be a power of two
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16 ||
    128 * N * r > SCRYPT_CONFIG.maxmem
  ) {
    return false;
  }

  return true;
}

/**
 * Hashes a plaintext password using crypto.scrypt with a fresh random salt.
 * Returns the self-describing string format:
 * $scrypt$v=1$N=16384,r=8,p=1$<saltHex>$<derivedKeyHex>
 */
export async function hashPassword(
  password: string,
  options: Partial<typeof SCRYPT_CONFIG> = {}
): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string");
  }

  if (password.length > 128) {
    throw new Error("Password must not exceed 128 characters");
  }

  const N = options.cost ?? SCRYPT_CONFIG.cost;
  const r = options.blockSize ?? SCRYPT_CONFIG.blockSize;
  const p = options.parallelization ?? SCRYPT_CONFIG.parallelization;
  const keyLength = options.keyLength ?? SCRYPT_CONFIG.keyLength;
  const saltBytes = options.saltBytes ?? SCRYPT_CONFIG.saltBytes;
  const maxmem = options.maxmem ?? SCRYPT_CONFIG.maxmem;

  const salt = crypto.randomBytes(saltBytes);

  const derivedKey = await scryptPromise(password, salt, keyLength, {
    N,
    r,
    p,
    maxmem,
  });

  const saltHex = salt.toString("hex");
  const keyHex = derivedKey.toString("hex");

  return `$scrypt$v=1$N=${N},r=${r},p=${p}$${saltHex}$${keyHex}`;
}

/**
 * Verifies a plaintext password against a stored self-describing hash.
 * Uses crypto.timingSafeEqual for constant-time comparison.
 * Never throws on malformed or locked hashes — returns false cleanly.
 */
export async function verifyPassword(
  password: unknown,
  storedHash: unknown
): Promise<boolean> {
  // 1. Validate inputs
  if (typeof password !== "string" || password.length === 0 || password.length > 128) {
    return false;
  }

  if (!isUsablePasswordHash(storedHash)) {
    return false;
  }

  const hashStr = storedHash as string;
  const match = hashStr.match(HASH_REGEX);
  if (!match) {
    return false;
  }

  const [, nStr, rStr, pStr, saltHex, expectedKeyHex] = match;
  const N = parseInt(nStr, 10);
  const r = parseInt(rStr, 10);
  const p = parseInt(pStr, 10);

  try {
    const salt = Buffer.from(saltHex, "hex");
    const expectedKey = Buffer.from(expectedKeyHex, "hex");

    if (salt.length < 16 || salt.length > 64) {
      return false;
    }

    if (expectedKey.length < 32 || expectedKey.length > 128) {
      return false;
    }

    const derivedKey = await scryptPromise(password, salt, expectedKey.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_CONFIG.maxmem,
    });

    if (derivedKey.length !== expectedKey.length) {
      return false;
    }

    return crypto.timingSafeEqual(derivedKey, expectedKey);
  } catch {
    // If scrypt memory limit is exceeded or malformed buffers occur, fail closed
    return false;
  }
}
