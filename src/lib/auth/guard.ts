/**
 * CashPilot AI — Authorization Guard
 *
 * Enforces server-side workspace and actor boundaries.
 * Invariants:
 *   - Never trust a client-provided workspaceId as proof of authorization.
 *   - Cross-workspace access is strictly rejected with 403 Forbidden.
 *   - Missing actor identity is rejected with 401 Unauthorized.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db/client";

export interface AuthContext {
  actorId: string;
  workspaceId: string;
}

export type AuthResult =
  | { authorized: true; context: AuthContext }
  | { authorized: false; status: 401 | 403 | 404; error: string; code: string };

/**
 * Authorizes a request for a target workspace.
 * Verifies that the actor has permissions for the workspace in the database.
 */
export async function authorizeWorkspaceAccess(
  req: NextRequest,
  targetWorkspaceId: string
): Promise<AuthResult> {
  const actorHeader = req.headers.get("x-actor-id") || req.headers.get("x-user-id");

  // In production, actor must be explicitly provided via session/auth header.
  // In development/test, default to demo-user-1 if no header is present, but honor explicit headers.
  const actorId =
    actorHeader && actorHeader.trim().length > 0
      ? actorHeader.trim()
      : process.env.NODE_ENV !== "production"
      ? "demo-user-1"
      : null;

  if (!actorId) {
    return {
      authorized: false,
      status: 401,
      error: "Authentication required. Missing actor identity.",
      code: "UNAUTHORIZED",
    };
  }

  const workspace = await db.workspace.findUnique({
    where: { id: targetWorkspaceId },
  });

  if (!workspace) {
    return {
      authorized: false,
      status: 404,
      error: "Workspace not found",
      code: "WORKSPACE_NOT_FOUND",
    };
  }

  // Enforce workspace ownership / membership
  if (workspace.ownerId !== actorId) {
    return {
      authorized: false,
      status: 403,
      error: "Access denied. Actor does not have permissions for this workspace.",
      code: "CROSS_WORKSPACE_FORBIDDEN",
    };
  }

  return {
    authorized: true,
    context: {
      actorId,
      workspaceId: targetWorkspaceId,
    },
  };
}
