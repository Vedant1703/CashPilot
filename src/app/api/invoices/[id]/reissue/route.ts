import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { reissueCancelledInvoice } from "@/lib/services/invoice.service";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";

/**
 * POST /api/invoices/[id]/reissue
 *
 * Reissues a cancelled invoice as a new draft invoice (GEN-07).
 *
 * Invariants:
 * - Original invoice remains immutably CANCELLED for audit fidelity.
 * - Reissue is only allowed when status === CANCELLED.
 * - New invoice is created in DRAFT state with fresh payload hash.
 * - Requires fresh human approval and new PayPal draft creation before sending.
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
    // 1. Locate invoice to determine workspace boundary
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

    // 2. Enforce workspace authorization guard
    const auth = await authorizeWorkspaceAccess(req, invoice.workspaceId);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: auth.error, code: auth.code },
        { status: auth.status }
      );
    }

    // 3. Reissue cancelled invoice
    const result = await reissueCancelledInvoice(
      auth.context.workspaceId,
      auth.context.actorId,
      invoiceId
    );

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "INVALID_INVOICE_STATUS"
          ? 400
          : 500;

      return NextResponse.json(
        { success: false, error: result.error, code: result.code },
        { status }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: result.data,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("Invoice reissue failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while reissuing the invoice.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
