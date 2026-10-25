/**
 * CashPilot AI — In-Memory Rate Limiter
 *
 * SRS § 7: Security & Abuse Protection
 *
 * Provides minimal, in-memory sliding-window rate limiting for sensitive auth endpoints (login, signup).
 * Zero external dependencies: uses native JavaScript Map with automatic expired entry pruning.
 *
 * Architecture note:
 * - Operates per Node.js process. Perfectly suited for local development, test runs, and single-container deployments.
 * - In multi-instance / serverless production environments, memory is not shared across instances.
 *   A distributed store (e.g. Upstash Redis or Redis token bucket) should be provisioned for global limits.
 */

import { NextRequest } from "next/server";

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitRecord>();

// Clean up expired records every 5 minutes to prevent memory leaks
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastCleanup = Date.now();

function purgeExpiredRecords(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, record] of rateLimitStore.entries()) {
    if (record.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

/**
 * Checks and increments rate limit for a given key.
 *
 * @param key Unique identifier (e.g., `login:${ip}` or `signup:${ip}`)
 * @param limit Maximum allowed requests within window
 * @param windowMs Time window in milliseconds
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  purgeExpiredRecords();

  const now = Date.now();
  const record = rateLimitStore.get(key);

  if (!record || record.resetAt <= now) {
    const resetAt = now + windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: limit - 1,
      resetAt,
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  if (record.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    return {
      allowed: false,
      remaining: 0,
      resetAt: record.resetAt,
      retryAfterSeconds,
    };
  }

  record.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  return {
    allowed: true,
    remaining: limit - record.count,
    resetAt: record.resetAt,
    retryAfterSeconds,
  };
}

/**
 * Extracts a normalized client IP from request headers or falls back safely.
 */
export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }

  return "127.0.0.1";
}

/**
 * Resets the in-memory store. Useful for test suites.
 */
export function resetRateLimiter(): void {
  rateLimitStore.clear();
}
