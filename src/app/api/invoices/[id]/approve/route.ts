import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { approveInvoice } from "@/lib/services/invoice.service";
import { approveInvoiceRequestSchema } from "@/lib/validations/invoice";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";

/**
 * POST /api/invoices/[id]/approve
 *
 * Cryptographically binds human approval to the exact material payload reviewed.
 * Invariants:
 *   - Never trust a client-provided hash as authoritative; recompute on server.
 *   - Reject stale hashes (409 Conflict) if the invoice changed since review.
 *   - Never allow cross-workspace approval attempts (403 Forbidden).
 *   - Never execute PayPal writes or mark invoices as paid in this endpoint.
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

  // 1. Parse and validate request body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON in request body", code: "INVALID_JSON" },
      { status: 400 }
    );
  }

  const parsed = approveInvoiceRequestSchema.safeParse(body);
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

    // 4. Execute approval verification and persistence
    const reminderMeta =
      parsed.data.note !== undefined || parsed.data.subject !== undefined
        ? { note: parsed.data.note, subject: parsed.data.subject }
        : undefined;

    const result = await approveInvoice(
      auth.context.workspaceId,
      auth.context.actorId,
      invoiceId,
      parsed.data.actionType,
      parsed.data.reviewedPayloadHash,
      reminderMeta
    );

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "STALE_PAYLOAD_HASH"
          ? 409
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
      { status: 200 }
    );
  } catch (err) {
    console.error("Invoice approval error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while processing invoice approval.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
