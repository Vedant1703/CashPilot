import { NextRequest, NextResponse } from "next/server";
import { createInvoice } from "@/lib/services/invoice.service";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";
import type { InvoiceInput } from "@/lib/validations/invoice";

/**
 * POST /api/invoices/draft
 *
 * Creates a new draft invoice with deterministic server-side total calculation.
 * Never executes external writes (PayPal/AI calls).
 * Bound to exact schema validation; client-supplied totals are rejected if mismatched.
 * Enforces session-backed workspace authorization.
 */
export async function POST(req: NextRequest) {
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

  const requestedWorkspaceId =
    typeof rawBody.workspaceId === "string" && rawBody.workspaceId.trim().length > 0
      ? rawBody.workspaceId.trim()
      : undefined;

  // Enforce session authorization for requested or primary workspace
  const auth = await authorizeWorkspaceAccess(req, requestedWorkspaceId);
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error, code: auth.code },
      { status: auth.status }
    );
  }

  try {
    const result = await createInvoice(
      auth.context.workspaceId,
      auth.context.actorId,
      rawBody as unknown as InvoiceInput
    );

    if (!result.ok) {
      const status =
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "TOTAL_MISMATCH" ||
            result.code === "SUBTOTAL_MISMATCH" ||
            result.code === "VALIDATION_ERROR"
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
        },
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("Draft invoice creation failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while processing the draft invoice.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
