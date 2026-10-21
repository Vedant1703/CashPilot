import { NextRequest, NextResponse } from "next/server";
import { extractInvoiceFromPrompt } from "@/lib/services/ai-extraction.service";
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

  const workspaceId =
    parsed.data.workspaceId ||
    req.headers.get("x-workspace-id") ||
    process.env.DEMO_WORKSPACE_ID ||
    "demo-workspace-1";

  const actorId = req.headers.get("x-actor-id") || "demo-user-1";

  try {
    const result = await extractInvoiceFromPrompt(
      workspaceId,
      parsed.data.prompt,
      actorId
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
