import { NextRequest, NextResponse } from "next/server";
import { getInvoice, updateInvoiceDraft } from "@/lib/services/invoice.service";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";
import { db } from "@/lib/db/client";
import type { InvoiceInput } from "@/lib/validations/invoice";

/**
 * GET /api/invoices/[id]
 *
 * Retrieves an invoice by ID with its line items, safe client details,
 * server-computed totals, and deterministic material payload hash.
 * Never exposes secrets, internal credentials, or unrelated workspace records.
 * Enforces session-backed workspace authorization.
 */
export async function GET(
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

  try {
    // 1. Fetch invoice to determine its workspace boundary
    const invoice = await db.invoice.findUnique({
      where: { id: id.trim() },
      select: { workspaceId: true },
    });

    if (!invoice) {
      return NextResponse.json(
        { success: false, error: "Invoice not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // 2. Enforce session authorization against the invoice workspace
    const auth = await authorizeWorkspaceAccess(req, invoice.workspaceId);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: auth.error, code: auth.code },
        { status: auth.status }
      );
    }

    const result = await getInvoice(id.trim(), auth.context.workspaceId);

    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error, code: result.code },
        { status: result.code === "NOT_FOUND" ? 404 : 500 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          ...result.data.invoice,
          materialPayloadHash: result.data.materialPayloadHash,
        },
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Invoice retrieval failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while retrieving the invoice.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/invoices/[id]
 *
 * Updates an existing draft invoice with deterministic server-side total calculation.
 * Invalidate stale approvals if material fields changed.
 * Enforces session-backed workspace authorization.
 */
export async function PATCH(
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON in request body", code: "INVALID_JSON" },
      { status: 400 }
    );
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { success: false, error: "Request body must be an object", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const rawBody = body as Record<string, unknown>;

  try {
    // 1. Fetch invoice to determine its workspace boundary
    const invoice = await db.invoice.findUnique({
      where: { id: id.trim() },
      select: { workspaceId: true },
    });

    if (!invoice) {
      return NextResponse.json(
        { success: false, error: "Invoice not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // 2. Enforce session authorization against the invoice workspace
    const auth = await authorizeWorkspaceAccess(req, invoice.workspaceId);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: auth.error, code: auth.code },
        { status: auth.status }
      );
    }

    const result = await updateInvoiceDraft(
      auth.context.workspaceId,
      auth.context.actorId,
      id.trim(),
      rawBody as unknown as InvoiceInput
    );

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "TOTAL_MISMATCH" ||
            result.code === "SUBTOTAL_MISMATCH" ||
            result.code === "VALIDATION_ERROR" ||
            result.code === "INVALID_INVOICE_STATUS"
          ? 400
          : result.code === "CALCULATION_ERROR"
          ? 422
          : 500;

      return NextResponse.json(
        { success: false, error: result.error, code: result.code },
        { status }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          ...result.data.invoice,
          materialPayloadHash: result.data.materialPayloadHash,
          approvalsInvalidated: result.data.approvalsInvalidated,
        },
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Draft invoice update failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while updating the draft invoice.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}

