import { NextRequest, NextResponse } from "next/server";
import { askNavi } from "@/lib/services/ask-navi.service";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";
import { z } from "zod";

const chatRequestSchema = z.object({
  message: z
    .string({ required_error: "Message is required" })
    .min(1, "Message cannot be empty")
    .max(2000, "Message must not exceed 2000 characters"),
  workspaceId: z.string().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })
    )
    .optional(),
});

/**
 * POST /api/navi-ai/chat
 *
 * Conversational Ask Navi assistant endpoint.
 * Enforces workspace authorization and returns grounded answers.
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

  const parsed = chatRequestSchema.safeParse(body);
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

  // Authorize workspace access
  const auth = await authorizeWorkspaceAccess(req, workspaceId);
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error, code: auth.code },
      { status: auth.status }
    );
  }

  try {
    const result = await askNavi(
      auth.context.workspaceId,
      parsed.data.message,
      auth.context.actorId,
      parsed.data.history ?? []
    );

    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status }
      );
    }

    return NextResponse.json({
      success: true,
      data: result.data,
    });
  } catch (err) {
    console.error("Ask Navi chat error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: "Failed to process question with Navi.", code: "INTERNAL_ERROR" },
      { status: 500 }
    );
  }
}
