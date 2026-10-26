/**
 * CashPilot AI — Judge Demo Access Endpoint
 *
 * SRS § 4: Isolated seeded demo workspace
 * SRS § 7: Server-enforced identity boundaries
 *
 * Provides a dedicated, explicit, server-validated demo access entry point.
 * Never trusts client-supplied workspace IDs, user IDs, or role flags.
 * Grants a session strictly bound to the canonical demo user (`demo-user-1`)
 * and its isolated demo workspace (`demo-workspace-1`).
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { createSession, setSessionCookie } from "@/lib/auth/session";

const DEMO_USER_ID = "demo-user-1";
const DEMO_WORKSPACE_ID = "demo-workspace-1";
const DEMO_EMAIL = "demo@cashpilot.test";
const DEMO_NAME = "Demo User";
const DEMO_WORKSPACE_NAME = "My Freelance Studio";
const DEMO_PASSWORD_LOCKED = "!LOCKED:DEMO_USER_MANAGED_AUTH";

export async function POST(): Promise<NextResponse> {
  try {
    // 1. Ensure canonical demo user exists in database and satisfies invariants
    let demoUser = await db.user.findUnique({
      where: { id: DEMO_USER_ID },
    });

    if (demoUser) {
      // Invariant check: demo user must retain canonical email and locked password hash.
      // Must fail closed rather than silently repairing or masking corrupted identity.
      if (demoUser.email !== DEMO_EMAIL || demoUser.passwordHash !== DEMO_PASSWORD_LOCKED) {
        console.error(
          "Demo user invariant violation: unexpected credentials or email on demo account."
        );
        return NextResponse.json(
          {
            success: false,
            error: "Demo workspace configuration error. Identity invariant violated.",
            code: "DEMO_INVARIANT_VIOLATION",
          },
          { status: 500 }
        );
      }
    } else {
      try {
        demoUser = await db.user.create({
          data: {
            id: DEMO_USER_ID,
            email: DEMO_EMAIL,
            name: DEMO_NAME,
            passwordHash: DEMO_PASSWORD_LOCKED,
          },
        });
      } catch (err: unknown) {
        // Handle concurrent request race condition
        demoUser = await db.user.findUnique({
          where: { id: DEMO_USER_ID },
        });
        if (!demoUser) throw err;
      }
    }

    // 2. Ensure canonical demo workspace exists in database
    let demoWorkspace = await db.workspace.findUnique({
      where: { id: DEMO_WORKSPACE_ID },
    });

    if (demoWorkspace) {
      // Unexpected ownership check: if demo-workspace-1 exists, its ownerId MUST be demo-user-1.
      // Must NEVER silently reassign ownership or take over an existing workspace.
      if (demoWorkspace.ownerId !== DEMO_USER_ID) {
        console.error(
          `Demo workspace ownership violation: workspace ${DEMO_WORKSPACE_ID} has unexpected owner ${demoWorkspace.ownerId} (expected ${DEMO_USER_ID})`
        );
        return NextResponse.json(
          {
            success: false,
            error: "Demo workspace ownership mismatch. Access denied.",
            code: "DEMO_OWNERSHIP_MISMATCH",
          },
          { status: 500 }
        );
      }

      if (!demoWorkspace.isDemo) {
        console.error(
          `Demo workspace invariant violation: workspace ${DEMO_WORKSPACE_ID} is not marked isDemo.`
        );
        return NextResponse.json(
          {
            success: false,
            error: "Demo workspace configuration error.",
            code: "DEMO_INVARIANT_VIOLATION",
          },
          { status: 500 }
        );
      }
    } else {
      try {
        demoWorkspace = await db.workspace.create({
          data: {
            id: DEMO_WORKSPACE_ID,
            name: DEMO_WORKSPACE_NAME,
            ownerId: DEMO_USER_ID,
            isDemo: true,
          },
        });
      } catch (err: unknown) {
        // Handle concurrent request race condition
        demoWorkspace = await db.workspace.findUnique({
          where: { id: DEMO_WORKSPACE_ID },
        });
        if (!demoWorkspace) throw err;
        if (demoWorkspace.ownerId !== DEMO_USER_ID) {
          return NextResponse.json(
            {
              success: false,
              error: "Demo workspace ownership mismatch. Access denied.",
              code: "DEMO_OWNERSHIP_MISMATCH",
            },
            { status: 500 }
          );
        }
      }
    }

    // 3. Create server-side database session strictly bound to demoUser
    const { token, session } = await createSession(demoUser.id);

    // 4. Construct response and attach HTTP-only cookie
    const response = NextResponse.json({
      success: true,
      data: {
        user: {
          id: demoUser.id,
          email: demoUser.email,
          name: demoUser.name,
        },
        workspace: {
          id: demoWorkspace.id,
          name: demoWorkspace.name,
          isDemo: true,
        },
      },
    });

    setSessionCookie(response, token, session.expiresAt);
    return response;
  } catch (error) {
    console.error("Demo access error:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to initialize demo session. Please try again.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
