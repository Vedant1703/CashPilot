import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { createPayPalDraft } from "@/lib/services/invoice.service";
import { createPayPalDraftRequestSchema } from "@/lib/validations/invoice";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";

/**
 * POST /api/invoices/[id]/paypal-draft
 *
 * Creates a PayPal Sandbox draft invoice for an approved CashPilot invoice.
 *
 * Invariants (SRS §4 & Financial Integrity Rules):
 *   - Human approval required: Must have an approved SEND_INVOICE action.
 *   - Approval hash binding: Recomputed on the server; rejects stale approvals (409 Conflict).
 *   - Workspace authorization: Caller must belong to the invoice's true workspace (403 Forbidden).
 *   - Draft creation ONLY: Never calls invoice-send, reminder, or payment endpoints.
 *   - Status separation: paypalStatus is persisted (DRAFT), cashpilotStatus remains DRAFT. Never transitions to PAID.
 *   - Finite timeouts & unknown-outcome tracking: Timeouts recorded as UNKNOWN; no blind retries.
 *   - Idempotent: Subsequent calls return existing draft without creating duplicate PayPal resources.
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

  // 1. Parse and validate request body (allow empty body or optional approvalId)
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

  const parsed = createPayPalDraftRequestSchema.safeParse(body);
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

    // 4. Execute draft creation with approval validation and provider call
    const result = await createPayPalDraft(
      auth.context.workspaceId,
      auth.context.actorId,
      invoiceId,
      parsed.data?.approvalId
    );

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "APPROVAL_REQUIRED" ||
            result.code === "APPROVAL_EXPIRED" ||
            result.code === "INVALID_INVOICE_STATUS"
          ? 400
          : result.code === "APPROVAL_STALE" ||
            result.code === "PENDING_UNKNOWN_OPERATION"
          ? 409
          : result.code === "OPERATION_UNKNOWN_OUTCOME"
          ? 504
          : result.code === "PAYPAL_NOT_CONFIGURED"
          ? 503
          : 502;

      return NextResponse.json(
        { success: false, error: result.error, code: result.code },
        { status }
      );
    }

    const statusCode = result.data.isExistingDraft ? 200 : 201;

    return NextResponse.json(
      {
        success: true,
        data: result.data,
      },
      { status: statusCode }
    );
  } catch (err) {
    console.error("PayPal draft creation error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while processing PayPal draft creation.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
