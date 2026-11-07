/**
 * CashPilot AI — Demo Workspace Reset Route
 *
 * POST /api/demo/reset
 *
 * Restores the canonical demo workspace (demo-workspace-1) to its initial seeded state.
 *
 * Strict Security & Safety Invariants:
 * 1. Only authenticated sessions may call this endpoint.
 * 2. Strict tenant check: target workspace must be demo-workspace-1 with isDemo: true.
 * 3. Strict actor check: actor must be demo-user-1.
 * 4. Fails closed with 403 Forbidden or 500 error if invariants are violated.
 * 5. Strictly confines resets to demo-workspace-1; non-demo data is never touched.
 * 6. No external PayPal API writes or false cancellation claims.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import {
  resetDemoWorkspace,
  DEMO_WORKSPACE_ID,
  DEMO_USER_ID,
} from "@/lib/services/demo.service";
import { db } from "@/lib/db/client";

export async function POST(req: NextRequest) {
  try {
    // 1. Session check
    const session = await getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required to reset demo workspace.",
          code: "UNAUTHORIZED",
        },
        { status: 401 }
      );
    }

    // 2. Strict actor verification
    if (session.user.id !== DEMO_USER_ID) {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied. Only the canonical demo user may reset the demo workspace.",
          code: "FORBIDDEN_DEMO_RESET",
        },
        { status: 403 }
      );
    }

    // 3. Optional body inspection: reject caller attempting to target a different workspace
    let bodyWorkspaceId: string | null = null;
    try {
      const body = await req.json();
      if (body && typeof body === "object" && typeof body.workspaceId === "string") {
        bodyWorkspaceId = body.workspaceId.trim();
      }
    } catch {
      // Body is optional
    }

    if (bodyWorkspaceId && bodyWorkspaceId !== DEMO_WORKSPACE_ID) {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot reset non-demo workspace. Targeted reset refused.",
          code: "CANNOT_RESET_NON_DEMO_WORKSPACE",
        },
        { status: 403 }
      );
    }

    // 4. Verify target workspace exists and belongs to demo-user-1
    const workspace = await db.workspace.findUnique({
      where: { id: DEMO_WORKSPACE_ID },
    });

    if (!workspace) {
      return NextResponse.json(
        {
          success: false,
          error: "Demo workspace not found in database.",
          code: "WORKSPACE_NOT_FOUND",
        },
        { status: 404 }
      );
    }

    if (workspace.ownerId !== DEMO_USER_ID || !workspace.isDemo) {
      return NextResponse.json(
        {
          success: false,
          error: "Demo workspace configuration error. Identity invariant violated.",
          code: "DEMO_INVARIANT_VIOLATION",
        },
        { status: 500 }
      );
    }

    // 5. Execute safe reset service
    const result = await resetDemoWorkspace({
      actorId: session.user.id,
      targetWorkspaceId: DEMO_WORKSPACE_ID,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          code: result.code,
        },
        { status: result.status }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: result.data,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Demo reset endpoint error:", err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while resetting the demo workspace.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
