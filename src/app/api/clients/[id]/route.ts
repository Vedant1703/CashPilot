import { NextRequest, NextResponse } from "next/server";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";
import {
  getClientById,
  updateClient,
  deleteClient,
} from "@/lib/services/client.service";
import { updateClientSchema } from "@/lib/validations/client";

/**
 * GET /api/clients/[id]
 *
 * Retrieves a client by ID strictly within the authenticated workspace.
 * Fails closed with 404 for missing or cross-workspace clients.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeWorkspaceAccess(req);
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error, code: auth.code },
      { status: auth.status }
    );
  }

  const { id } = await context.params;
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: "Client ID is required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const result = await getClientById(id.trim(), auth.context.workspaceId);
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, code: result.code },
      { status: result.code === "NOT_FOUND" ? 404 : 500 }
    );
  }

  return NextResponse.json(
    { success: true, data: result.data },
    { status: 200 }
  );
}

/**
 * PATCH /api/clients/[id]
 *
 * Updates a client strictly within the authenticated workspace.
 * Rejects empty updates and invalid inputs with 400.
 * Fails closed with 404 for missing or cross-workspace clients.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeWorkspaceAccess(req);
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error, code: auth.code },
      { status: auth.status }
    );
  }

  const { id } = await context.params;
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: "Client ID is required", code: "BAD_REQUEST" },
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

  const parsed = updateClientSchema.safeParse(body);
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

  const result = await updateClient(
    id.trim(),
    auth.context.workspaceId,
    parsed.data
  );

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, code: result.code },
      { status: result.code === "NOT_FOUND" ? 404 : 500 }
    );
  }

  return NextResponse.json(
    { success: true, data: result.data },
    { status: 200 }
  );
}

/**
 * DELETE /api/clients/[id]
 *
 * Deletes an unreferenced client strictly within the authenticated workspace.
 * Returns 409 if the client is referenced by one or more invoices.
 * Fails closed with 404 for missing or cross-workspace clients.
 */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeWorkspaceAccess(req);
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error, code: auth.code },
      { status: auth.status }
    );
  }

  const { id } = await context.params;
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: "Client ID is required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const result = await deleteClient(id.trim(), auth.context.workspaceId);
  if (!result.ok) {
    const status =
      result.code === "NOT_FOUND"
        ? 404
        : result.code === "CANNOT_DELETE_CLIENT_WITH_INVOICES"
        ? 409
        : 500;

    return NextResponse.json(
      { success: false, error: result.error, code: result.code },
      { status }
    );
  }

  return NextResponse.json(
    { success: true, data: result.data },
    { status: 200 }
  );
}
