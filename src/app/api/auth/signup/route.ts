import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { signupSchema } from "@/lib/auth/validation";
import { checkRateLimit, getClientIp } from "@/lib/auth/rate-limit";

/**
 * POST /api/auth/signup
 *
 * Registers a new user, hashes the password with versioned scrypt,
 * and creates exactly one isolated workspace and active database session in a single transaction.
 */
export async function POST(req: NextRequest) {
  // Rate limit: 5 signup attempts per minute per IP
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(`signup:${clientIp}`, 5, 60 * 1000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: "Too many signup attempts. Please wait a moment and try again.",
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

  const parsed = signupSchema.safeParse(body);
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

  const { name, email, password, businessName } = parsed.data;

  try {
    // 1. Check if email already exists
    const existing = await db.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        {
          success: false,
          error: "An account with this email address already exists.",
          code: "EMAIL_EXISTS",
        },
        { status: 409 }
      );
    }

    // 2. Hash password with versioned scrypt
    const passwordHash = await hashPassword(password);

    // 3. Atomically create User, primary empty Workspace, and initial Session
    const result = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email,
          passwordHash,
        },
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
        },
      });

      const workspace = await tx.workspace.create({
        data: {
          name: businessName && businessName.trim().length > 0 ? businessName.trim() : `${name}'s Studio`,
          ownerId: user.id,
          isDemo: false,
        },
        select: {
          id: true,
          name: true,
          isDemo: true,
        },
      });

      const { token, session } = await createSession(user.id, tx as unknown as typeof db);

      return { user, workspace, token, session };
    });

    // 4. Build response and set HTTP-only session cookie
    const response = NextResponse.json(
      {
        success: true,
        data: {
          user: result.user,
          workspace: result.workspace,
        },
      },
      { status: 201 }
    );

    setSessionCookie(response, result.token, result.session.expiresAt);
    return response;
  } catch (error) {
    console.error("Signup error:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      {
        success: false,
        error: "An error occurred while creating your account. Please try again.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
