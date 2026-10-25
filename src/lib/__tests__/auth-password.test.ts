import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  isUsablePasswordHash,
} from "@/lib/auth/password";

describe("Password Hashing & Verification Utilities", () => {
  it("hashes password into self-describing scrypt format", async () => {
    const password = "SuperSecretPassword123!";
    const hash = await hashPassword(password);

    expect(hash).toMatch(
      /^\$scrypt\$v=1\$N=16384,r=8,p=1\$[0-9a-fA-F]{32}\$[0-9a-fA-F]{128}$/
    );
    expect(isUsablePasswordHash(hash)).toBe(true);
  });

  it("generates distinct salts and distinct hashes for identical passwords", async () => {
    const password = "IdenticalPassword987!";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    expect(hash1).not.toBe(hash2);
    expect(await verifyPassword(password, hash1)).toBe(true);
    expect(await verifyPassword(password, hash2)).toBe(true);
  });

  it("successfully verifies correct password and rejects incorrect password", async () => {
    const password = "CorrectHorseBatteryStaple!";
    const hash = await hashPassword(password);

    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword("WrongPassword123!", hash)).toBe(false);
    expect(await verifyPassword(password.toLowerCase(), hash)).toBe(false);
  });

  it("strictly rejects locked accounts and placeholder credentials", async () => {
    const lockedHashes = [
      "!LOCKED:DEMO_USER_MANAGED_AUTH",
      "!LOCKED:LEGACY_BACKFILL",
      "!DEMO_USER_MANAGED_AUTHENTICATION",
      "!LOCKED:ANY_OTHER_MARKER",
      "!UNUSABLE_PASSWORD_BACKFILL",
    ];

    for (const lockedHash of lockedHashes) {
      expect(isUsablePasswordHash(lockedHash)).toBe(false);
      expect(await verifyPassword("password123", lockedHash)).toBe(false);
      expect(await verifyPassword("", lockedHash)).toBe(false);
      expect(await verifyPassword("admin", lockedHash)).toBe(false);
    }
  });

  it("strictly rejects malformed or unsupported hash formats without throwing", async () => {
    const malformedHashes = [
      "",
      "plain_text_password",
      "password123",
      "$2b$10$unsupported_bcrypt_hash_placeholder",
      "$argon2id$v=19$m=65536,t=3,p=4$placeholder",
      "$scrypt$v=2$unsupported_version",
      "$scrypt$v=1$N=abc,r=8,p=1$1234$5678",
      "$scrypt$v=1$N=16384,r=8,p=1$non_hex_salt$non_hex_key",
      null,
      undefined,
      12345,
      {},
    ];

    for (const invalidHash of malformedHashes) {
      expect(isUsablePasswordHash(invalidHash)).toBe(false);
      expect(await verifyPassword("testPassword123!", invalidHash)).toBe(false);
    }
  });

  it("rejects invalid plaintext passwords during hashing and verification", async () => {
    await expect(hashPassword("")).rejects.toThrow(/non-empty/i);
    await expect(hashPassword("a".repeat(129))).rejects.toThrow(/128 characters/i);

    const validHash = await hashPassword("validPassword123!");
    expect(await verifyPassword("", validHash)).toBe(false);
    expect(await verifyPassword(null, validHash)).toBe(false);
    expect(await verifyPassword(undefined, validHash)).toBe(false);
    expect(await verifyPassword("a".repeat(129), validHash)).toBe(false);
  });
});
