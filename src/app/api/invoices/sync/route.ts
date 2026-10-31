import { NextRequest, NextResponse } from "next/server";
import { batchSyncWorkspaceInvoicesWithPayPal } from "@/lib/services/invoice.service";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";

/**
 * POST /api/invoices/sync
 *
 * Reconciles status for all active invoices in the caller's workspace against PayPal Sandbox.
 *
 * Invariants (SRS §4, §5 & UI Design Reference Page 14):
 *   - Server-side authorization guard: Enforces workspace ownership; prevents cross-workspace access (403 Forbidden).
 *   - Verified payment evidence: PAID status only granted when provider explicitly confirms payment.
 *   - Unknown / unmapped provider status maps to NEEDS_REVIEW (never PAID).
 *   - Stale preservation: If refresh fails for an invoice, last known valid status is retained with syncIsStale = true.
 *   - Reconciles UNKNOWN-outcome operations when provider evidence establishes resolution.
 *   - Read-only provider calls: Zero writes, sends, or charges executed on PayPal during sync.
 *   - Computes before-and-after stage counts and delta metrics for board update.
 */
export async function POST(req: NextRequest) {
  try {
    // 1. Parse optional workspaceId from request body if provided
    let requestedWorkspaceId: string | null = null;
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const body = await req.json();
        if (body && typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0) {
          requestedWorkspaceId = body.workspaceId.trim();
        }
      } catch {
        // Body is optional; continue to session-resolved workspace
      }
    }

    // 2. Enforce server-side authorization guard
    const auth = await authorizeWorkspaceAccess(req, requestedWorkspaceId);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: auth.error, code: auth.code },
        { status: auth.status }
      );
    }

    // 3. Execute batch status synchronization and reconciliation
    const result = await batchSyncWorkspaceInvoicesWithPayPal(
      auth.context.workspaceId,
      auth.context.actorId
    );

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "PAYPAL_NOT_CONFIGURED"
          ? 503
          : 500;

      return NextResponse.json(
        {
          success: false,
          error: result.error,
          code: result.code,
        },
        { status }
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
    console.error("Workspace status batch sync error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while reconciling workspace invoices with PayPal.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
