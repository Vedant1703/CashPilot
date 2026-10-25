/**
 * CashPilot AI — Database Session Management Utilities
 *
 * SRS § 4: Workspace and user — owner and authorization boundary
 * SRS § 7: Security — credentials server-side only, secure session cookies
 *
 * Invariants:
 *   - Session token is a 256-bit cryptographically secure opaque string.
 *   - Only the SHA-256 hash is persisted in the database (never the raw token).
 *   - Stored in an HTTP-only, SameSite=Lax, Secure cookie (path: "/").
 *   - Explicit expiration checks: expired sessions are rejected and pruned.
 *   - Resolves user and active workspace server-side; client headers are ignored.
 */

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";

export const SESSION_COOKIE_NAME = "cashpilot_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface AuthenticatedWorkspace {
  id: string;
  name: string;
  isDemo: boolean;
}

export interface SessionContext {
  sessionId: string;
  expiresAt: Date;
  user: AuthenticatedUser;
  workspace: AuthenticatedWorkspace | null;
}

/**
 * Computes a SHA-256 digest of an opaque session token.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generates an opaque 256-bit random session token (base64url format).
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Computes cookie options for session setting.
 */
export function getSessionCookieOptions(expiresAt: Date) {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
    maxAge: SESSION_TTL_SECONDS,
  };
}

/**
 * Creates a new database session for the user and returns the raw token and Session record.
 */
export async function createSession(
  userId: string,
  txClient = db
): Promise<{ token: string; session: { id: string; expiresAt: Date } }> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  const session = await txClient.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
    select: {
      id: true,
      expiresAt: true,
    },
  });

  return { token, session };
}

/**
 * Test session registry for in-memory session testing when the database Session
 * table is not yet migrated, or for isolated test fixtures.
 */
const testSessionStore = new Map<string, SessionContext>();

export function registerTestSession(token: string, context: SessionContext): void {
  testSessionStore.set(hashSessionToken(token.trim()), context);
}

export function clearTestSessions(): void {
  testSessionStore.clear();
}

/**
 * Verifies a raw session token from the cookie against the database.
 * Returns SessionContext if valid, or null if missing, expired, or invalid.
 */
export async function verifySessionToken(
  token: string | null | undefined
): Promise<SessionContext | null> {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return null;
  }

  const tokenHash = hashSessionToken(token.trim());

  // Check test session store (used in test environments or isolated fixtures)
  const testSession = testSessionStore.get(tokenHash);
  if (testSession) {
    if (testSession.expiresAt.getTime() <= Date.now()) {
      testSessionStore.delete(tokenHash);
      return null;
    }
    return testSession;
  }

  try {
    const session = await db.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            workspaces: {
              take: 1,
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                name: true,
                isDemo: true,
              },
            },
          },
        },
      },
    });

    if (!session) {
      return null;
    }

    // Check expiration
    if (session.expiresAt.getTime() <= Date.now()) {
      // Async clean-up expired session
      await db.session.delete({ where: { id: session.id } }).catch(() => {});
      return null;
    }

    const primaryWorkspace = session.user.workspaces[0] ?? null;

    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        createdAt: session.user.createdAt,
      },
      workspace: primaryWorkspace,
    };
  } catch (error) {
    // If the Session table is not yet migrated in this environment, fail closed safely
    console.error("Session verification error:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Extracts the session token from request cookies and verifies it.
 */
export async function getSessionFromRequest(
  req: NextRequest
): Promise<SessionContext | null> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token);
}

/**
 * Revokes a session by deleting it from the database by its token.
 */
export async function revokeSession(token: string | null | undefined): Promise<boolean> {
  if (!token || typeof token !== "string") {
    return false;
  }

  const tokenHash = hashSessionToken(token.trim());
  const hadInMemory = testSessionStore.delete(tokenHash);

  try {
    await db.session.deleteMany({
      where: { tokenHash },
    });
    return true;
  } catch {
    return hadInMemory;
  }
}

/**
 * Sets the session cookie on a NextResponse.
 */
export function setSessionCookie(
  res: NextResponse,
  token: string,
  expiresAt: Date
): void {
  const options = getSessionCookieOptions(expiresAt);
  res.cookies.set(options.name, token, options);
}

/**
 * Clears the session cookie on a NextResponse.
 */
export function clearSessionCookie(res: NextResponse): void {
  const isProduction = process.env.NODE_ENV === "production";
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });
}
