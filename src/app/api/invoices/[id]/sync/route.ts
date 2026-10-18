import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { syncInvoiceWithPayPal } from "@/lib/services/invoice.service";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";

/**
 * POST /api/invoices/[id]/sync
 *
 * Synchronizes invoice status with PayPal Sandbox (GET /v2/invoicing/invoices/{id}).
 *
 * Invariants (SRS §4, §5 & Financial Integrity Rules):
 *   - Server-side authorization guard: enforces workspace ownership (403 Forbidden).
 *   - Verified payment evidence: PAID status only granted when provider confirms PAID.
 *   - Unknown / unmapped provider status maps to NEEDS_REVIEW (never PAID).
 *   - Stale preservation: Failed refresh preserves last known valid provider status (syncIsStale = true).
 *   - Reconciles UNKNOWN-outcome operations when provider evidence establishes resolution.
 *   - Concurrency protection: Older responses cannot overwrite newer sync results.
 *   - Discrepancy tracking: If provider invoice is 404 Not Found, records error without recreating.
 *   - Read-only provider call: Zero writes/sends/payments executed on PayPal.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  if (!id || typeof id !== "string" || id.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: "Invoice ID is required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const invoiceId = id.trim();

  try {
    // 1. Locate invoice to determine authoritative workspace boundary
    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, workspaceId: true },
    });

    if (!invoice) {
      return NextResponse.json(
        { success: false, error: "Invoice not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // 2. Enforce server-side authorization guard against true workspace boundary
    const auth = await authorizeWorkspaceAccess(req, invoice.workspaceId);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: auth.error, code: auth.code },
        { status: auth.status }
      );
    }

    // 3. Execute status synchronization and reconciliation
    const result = await syncInvoiceWithPayPal(
      auth.context.workspaceId,
      auth.context.actorId,
      invoiceId
    );

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND" || result.code === "PROVIDER_INVOICE_NOT_FOUND"
          ? 404
          : result.code === "PAYPAL_NOT_CONFIGURED"
          ? 503
          : result.code === "TIMEOUT"
          ? 504
          : 502;

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
    console.error("PayPal status sync error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while synchronizing invoice status.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
