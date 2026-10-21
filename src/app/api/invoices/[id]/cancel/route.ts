import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { cancelInvoice } from "@/lib/services/invoice.service";
import { cancelInvoiceRequestSchema } from "@/lib/validations/invoice";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";

/**
 * POST /api/invoices/[id]/cancel
 *
 * Cancels an approved, sent PayPal invoice.
 *
 * Invariants (SRS §4 & Financial Integrity Rules):
 *   - Human approval required: Must have an approved CANCEL_INVOICE action.
 *   - Approval hash binding: Recomputed server-side; rejects stale approvals (409 Conflict).
 *   - Workspace authorization: Caller must belong to the invoice's true workspace (403 Forbidden).
 *   - Pre-condition: PayPal invoice MUST already be sent and unpaid; rejects DRAFT, PAID, PARTIALLY_PAID, and CANCELLED (400 Bad Request).
 *   - Provider state ambiguity: Stale sync or NEEDS_REVIEW blocks cancellation until reconciled (409 Conflict).
 *   - Finite timeouts & unknown-outcome tracking: Timeouts recorded as UNKNOWN; blind retries blocked (504 Gateway Timeout).
 *   - Concurrency & idempotency: In-flight operations blocked (409 Conflict).
 *   - Recipient safety: Strictly uses persisted recipient from database; client cannot supply arbitrary recipient override.
 *   - Provider evidence: Only provider 204/200 success transitions status to CANCELLED.
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

  // 1. Parse and validate request body (allow empty body or optional options)
  let body: unknown = {};
  const text = await req.text();
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON in request body", code: "INVALID_JSON" },
        { status: 400 }
      );
    }
  }

  const parsed = cancelInvoiceRequestSchema.safeParse(body);
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

  try {
    // 2. Locate invoice to determine authoritative workspace boundary
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

    // 3. Enforce server-side authorization guard against true workspace boundary
    const auth = await authorizeWorkspaceAccess(req, invoice.workspaceId);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: auth.error, code: auth.code },
        { status: auth.status }
      );
    }

    // 4. Execute cancellation with approval verification and PayPal API call
    const result = await cancelInvoice(
      auth.context.workspaceId,
      auth.context.actorId,
      invoiceId,
      parsed.data?.approvalId,
      {
        note: parsed.data?.note,
        subject: parsed.data?.subject,
        sendToRecipient: parsed.data?.sendToRecipient,
        sendToInvoicer: parsed.data?.sendToInvoicer,
      }
    );

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND" || result.code === "APPROVAL_NOT_FOUND"
          ? 404
          : result.code === "APPROVAL_REQUIRED" ||
            result.code === "APPROVAL_EXPIRED" ||
            result.code === "APPROVAL_INVALIDATED" ||
            result.code === "APPROVAL_USED" ||
            result.code === "APPROVAL_NOT_APPROVED" ||
            result.code === "INVALID_APPROVAL_ACTION" ||
            result.code === "INVALID_INVOICE_STATE" ||
            result.code === "PAYPAL_INVOICE_REQUIRED" ||
            result.code === "PAYLOAD_SNAPSHOT_MISMATCH" ||
            result.code === "PAYLOAD_MISMATCH"
          ? 400
          : result.code === "APPROVAL_STALE" ||
            result.code === "PENDING_UNKNOWN_OPERATION" ||
            result.code === "OPERATION_IN_FLIGHT" ||
            result.code === "PROVIDER_STATE_AMBIGUOUS"
          ? 409
          : result.code === "OPERATION_UNKNOWN_OUTCOME"
          ? 504
          : result.code === "PAYPAL_NOT_CONFIGURED"
          ? 503
          : result.code === "DATABASE_PERSISTENCE_FAILED"
          ? 500
          : 502;

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
      { status: 200 }
    );
  } catch (err) {
    console.error("PayPal invoice cancellation error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while processing PayPal invoice cancellation.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
