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
import { getSessionFromRequest, AuthenticatedUser, AuthenticatedWorkspace } from "@/lib/auth/session";

export interface AuthContext {
  actorId: string;
  workspaceId: string;
  user: AuthenticatedUser;
  workspace: AuthenticatedWorkspace | null;
}

export type AuthResult =
  | { authorized: true; context: AuthContext }
  | { authorized: false; status: 401 | 403 | 404; error: string; code: string };

/**
 * Authorizes a request for a target workspace based strictly on verified database session.
 *
 * Rules:
 *   - Client headers (x-actor-id, x-user-id, x-workspace-id) are NEVER trusted as proof of authorization.
 *   - Missing or invalid session -> 401 Unauthorized.
 *   - Target workspace does not exist -> 404 Not Found.
 *   - Target workspace does not belong to the authenticated user -> 403 Forbidden.
 */
export async function authorizeWorkspaceAccess(
  req: NextRequest,
  targetWorkspaceId?: string | null
): Promise<AuthResult> {
  const session = await getSessionFromRequest(req);

  if (!session) {
    return {
      authorized: false,
      status: 401,
      error: "Authentication required. Please log in.",
      code: "UNAUTHORIZED",
    };
  }

  // Resolve target workspace: explicitly requested workspace or authenticated primary workspace
  const resolvedWorkspaceId = targetWorkspaceId?.trim() || session.workspace?.id;

  if (!resolvedWorkspaceId) {
    return {
      authorized: false,
      status: 404,
      error: "Workspace not found.",
      code: "WORKSPACE_NOT_FOUND",
    };
  }

  const workspace = await db.workspace.findUnique({
    where: { id: resolvedWorkspaceId },
  });

  if (!workspace) {
    return {
      authorized: false,
      status: 404,
      error: "Workspace not found.",
      code: "WORKSPACE_NOT_FOUND",
    };
  }

  // Enforce workspace ownership: target workspace must belong to the session user
  if (workspace.ownerId !== session.user.id) {
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
      actorId: session.user.id,
      workspaceId: resolvedWorkspaceId,
      user: session.user,
      workspace: session.workspace,
    },
  };
}
