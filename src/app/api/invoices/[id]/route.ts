import { NextRequest, NextResponse } from "next/server";
import { getInvoice } from "@/lib/services/invoice.service";

/**
 * GET /api/invoices/[id]
 *
 * Retrieves an invoice by ID with its line items, safe client details,
 * server-computed totals, and deterministic material payload hash.
 * Never exposes secrets, internal credentials, or unrelated workspace records.
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

  const { searchParams } = new URL(req.url);
  const workspaceId =
    searchParams.get("workspaceId") ||
    req.headers.get("x-workspace-id") ||
    process.env.DEMO_WORKSPACE_ID ||
    "demo-workspace-1";

  try {
    const result = await getInvoice(id.trim(), workspaceId);

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
