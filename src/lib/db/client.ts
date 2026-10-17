/**
 * CashPilot AI — Prisma Database Client (singleton)
 *
 * SRS §7: Maintainability — single shared instance in dev to avoid connection exhaustion.
 * NEVER call this from browser/client components.
 */

import { PrismaClient } from "@prisma/client";

// Avoid multiple instances during hot reload in development
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
