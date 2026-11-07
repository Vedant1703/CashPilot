/**
 * CashPilot AI — User Profile Management API (USER-01)
 *
 * GET: Retrieve authenticated user profile and active workspace summary.
 * PATCH: Update user profile (name, email) with server-side validation and audit.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { updateProfileSchema } from "@/lib/validations/user";
import { ActivityEventType, ActorType } from "@prisma/client";

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Authentication required. Please log in." },
      { status: 401 }
    );
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      updatedAt: true,
      workspaces: {
        select: {
          id: true,
          name: true,
          isDemo: true,
          createdAt: true,
        },
      },
    },
  });

  if (!user) {
    return NextResponse.json(
      { success: false, error: "User profile not found." },
      { status: 404 }
    );
  }

  const activeWorkspaceId = session.workspace?.id;
  const activeWorkspace = user.workspaces.find((w) => w.id === activeWorkspaceId);

  let workspaceStats = {
    invoiceCount: 0,
    clientCount: 0,
  };

  if (activeWorkspaceId) {
    const [invoiceCount, clientCount] = await Promise.all([
      db.invoice.count({ where: { workspaceId: activeWorkspaceId } }),
      db.client.count({ where: { workspaceId: activeWorkspaceId } }),
    ]);
    workspaceStats = { invoiceCount, clientCount };
  }

  return NextResponse.json({
    success: true,
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      workspace: session.workspace
        ? {
            id: session.workspace.id,
            name: activeWorkspace?.name ?? session.workspace.name,
            isDemo: activeWorkspace?.isDemo ?? session.workspace.isDemo,
            ...workspaceStats,
          }
        : null,
    },
  });
}

export async function PATCH(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Authentication required. Please log in." },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON request body." },
      { status: 400 }
    );
  }

  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    const errorMsg = parsed.error.errors.map((e) => e.message).join(", ");
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 400 }
    );
  }

  const { name, email } = parsed.data;

  // Check email uniqueness if changing email
  if (email.toLowerCase() !== session.user.email.toLowerCase()) {
    const existing = await db.user.findFirst({
      where: {
        email: { equals: email, mode: "insensitive" },
        NOT: { id: session.user.id },
      },
    });

    if (existing) {
      return NextResponse.json(
        { success: false, error: "Email address is already in use by another account." },
        { status: 400 }
      );
    }
  }

  // Update User
  const updatedUser = await db.user.update({
    where: { id: session.user.id },
    data: {
      name,
      email: email.toLowerCase(),
    },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Record audit activity event if workspace exists
  if (session.workspace?.id) {
    try {
      await db.activityEvent.create({
        data: {
          workspaceId: session.workspace.id,
          actorId: session.user.id,
          actorType: ActorType.USER,
          eventType: ActivityEventType.SYSTEM_EVENT,
          description: `User profile updated: name changed to "${name}", email changed to "${email.toLowerCase()}"`,
        },
      });
    } catch {
      // Non-blocking audit record failure
    }
  }

  return NextResponse.json({
    success: true,
    data: updatedUser,
  });
}
