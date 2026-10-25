/**
 * CashPilot AI — Server-Side Session & Workspace Authorization Helper
 *
 * SRS § 4: Workspace and user — owner and authorization boundary
 * SRS § 7: Security — verified credentials server-side only
 *
 * Provides reusable server-side session resolution for Next.js Server Components.
 * Redirects unauthenticated visitors to /login.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE_NAME,
  verifySessionToken,
  SessionContext,
  AuthenticatedWorkspace,
} from "@/lib/auth/session";

export type AuthenticatedSessionContext = SessionContext & {
  workspace: AuthenticatedWorkspace;
};

/**
 * Resolves the active authenticated session from the HTTP-only cookie.
 * Returns null if the cookie is missing, expired, or invalid.
 */
export async function getCurrentSession(): Promise<SessionContext | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (!token || typeof token !== "string" || token.trim().length === 0) {
      return null;
    }
    return await verifySessionToken(token.trim());
  } catch {
    return null;
  }
}

/**
 * Requires an active, authenticated session in a Server Component.
 * If unauthenticated or no primary workspace exists, redirects to /login.
 */
export async function requireAuth(): Promise<AuthenticatedSessionContext> {
  const session = await getCurrentSession();
  if (!session || !session.workspace) {
    redirect("/login");
  }
  return session as AuthenticatedSessionContext;
}
