import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { verifyPassword, isUsablePasswordHash, DUMMY_SCRYPT_HASH } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { loginSchema } from "@/lib/auth/validation";
import { checkRateLimit, getClientIp } from "@/lib/auth/rate-limit";

/**
 * POST /api/auth/login
 *
 * Verifies user credentials, checks against locked account markers,
 * generates an active database session, and sets a secure session cookie.
 */
export async function POST(req: NextRequest) {
  // Rate limit: 10 login attempts per minute per IP
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(`login:${clientIp}`, 10, 60 * 1000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: "Too many login attempts. Please wait a moment and try again.",
        code: "TOO_MANY_REQUESTS",
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON in request body", code: "INVALID_JSON" },
      { status: 400 }
    );
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: parsed.error.issues.map((i) => i.message).join("; "),
        code: "VALIDATION_ERROR",
      },
      { status: 400 }
    );
  }

  const { email, password } = parsed.data;

  try {
    // 1. Fetch user by normalized email
    const user = await db.user.findUnique({
      where: { email },
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
    });

    // 2. Generic rejection with dummy scrypt verification if user does not exist
    if (!user) {
      await verifyPassword(password, DUMMY_SCRYPT_HASH);
      return NextResponse.json(
        { success: false, error: "Invalid email or password.", code: "INVALID_CREDENTIALS" },
        { status: 401 }
      );
    }

    // 3. Machine-checkable check: immediately reject locked, demo, or placeholder credentials
    // Runs dummy scrypt verification to prevent timing discrepancy
    if (!isUsablePasswordHash(user.passwordHash)) {
      await verifyPassword(password, DUMMY_SCRYPT_HASH);
      return NextResponse.json(
        { success: false, error: "Invalid email or password.", code: "INVALID_CREDENTIALS" },
        { status: 401 }
      );
    }

    // 4. Verify password with constant-time comparison
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return NextResponse.json(
        { success: false, error: "Invalid email or password.", code: "INVALID_CREDENTIALS" },
        { status: 401 }
      );
    }

    // 5. Create new database session
    const { token, session } = await createSession(user.id);

    const primaryWorkspace = user.workspaces[0] ?? null;

    // 6. Build response and set HTTP-only cookie
    const response = NextResponse.json(
      {
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.createdAt,
          },
          workspace: primaryWorkspace,
        },
      },
      { status: 200 }
    );

    setSessionCookie(response, token, session.expiresAt);
    return response;
  } catch (error) {
    console.error("Login error:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while processing your request.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
