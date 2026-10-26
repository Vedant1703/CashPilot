import { NextRequest, NextResponse } from "next/server";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";
import { listClients, createClient } from "@/lib/services/client.service";
import { createClientSchema, clientQuerySchema } from "@/lib/validations/client";

/**
 * GET /api/clients
 *
 * Lists and searches clients scoped strictly to the authenticated workspace.
 * Rejects unauthenticated requests with 401.
 */
export async function GET(req: NextRequest) {
  const auth = await authorizeWorkspaceAccess(req);
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error, code: auth.code },
      { status: auth.status }
    );
  }

  const searchParam = req.nextUrl.searchParams.get("search");
  const queryParsed = clientQuerySchema.safeParse({
    search: searchParam ?? undefined,
  });

  if (!queryParsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: queryParsed.error.issues.map((i) => i.message).join("; "),
        code: "VALIDATION_ERROR",
      },
      { status: 400 }
    );
  }

  const result = await listClients(auth.context.workspaceId, queryParsed.data);
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, code: result.code },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { success: true, data: result.data },
    { status: 200 }
  );
}

/**
 * POST /api/clients
 *
 * Creates a new client within the authenticated user's workspace.
 * Rejects unauthenticated requests with 401.
 * Validates request payload server-side using createClientSchema.
 * Strictly derives workspaceId from session and forces isDemo to false.
 */
export async function POST(req: NextRequest) {
  const auth = await authorizeWorkspaceAccess(req);
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error, code: auth.code },
      { status: auth.status }
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

  const parsed = createClientSchema.safeParse(body);
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

  const result = await createClient(auth.context.workspaceId, parsed.data);
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, code: result.code },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { success: true, data: result.data },
    { status: 201 }
  );
}
