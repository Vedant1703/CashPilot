import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";

/**
 * GET /api/auth/me
 *
 * Returns the currently authenticated user's safe public profile and active workspace.
 * Rejects unauthenticated requests with 401. Never exposes passwordHash or session tokens.
 */
export async function GET(req: NextRequest) {
  const auth = await getSessionFromRequest(req);

  if (!auth) {
    return NextResponse.json(
      { success: false, error: "Authentication required.", code: "UNAUTHORIZED" },
      { status: 401 }
    );
  }

  return NextResponse.json(
    {
      success: true,
      data: {
        user: auth.user,
        workspace: auth.workspace,
      },
    },
    { status: 200 }
  );
}
