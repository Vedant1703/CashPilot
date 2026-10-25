import { NextRequest, NextResponse } from "next/server";
import { extractInvoiceFromPrompt } from "@/lib/services/ai-extraction.service";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";
import { z } from "zod";

const extractRequestSchema = z.object({
  prompt: z
    .string({ required_error: "Prompt is required" })
    .min(3, "Prompt must be at least 3 characters")
    .max(3000, "Prompt must not exceed 3000 characters"),
  workspaceId: z.string().optional(),
});

/**
 * POST /api/invoices/extract
 *
 * Extracts structured invoice proposal from natural language prompt.
 * Strictly server-side validation; model responses never execute external writes.
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

  const parsed = extractRequestSchema.safeParse(body);
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

  // Enforce session authorization for requested workspace
  const auth = await authorizeWorkspaceAccess(req, parsed.data.workspaceId);
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error, code: auth.code },
      { status: auth.status }
    );
  }

  try {
    const result = await extractInvoiceFromPrompt(
      auth.context.workspaceId,
      parsed.data.prompt,
      auth.context.actorId
    );

    return NextResponse.json(
      {
        success: true,
        data: result,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Extraction error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to extract invoice from description.",
        code: "EXTRACTION_FAILED",
      },
      { status: 500 }
    );
  }
}
