import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, revokeSession, clearSessionCookie } from "@/lib/auth/session";

/**
 * POST /api/auth/logout
 *
 * Revokes the database session associated with the active session token
 * and clears the session cookie from the client.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    await revokeSession(token);
  }

  const response = NextResponse.json(
    { success: true, message: "Logged out successfully." },
    { status: 200 }
  );

  clearSessionCookie(response);
  return response;
}
