/**
 * CashPilot AI — Client Service
 *
 * Workspace-scoped client management service.
 * Enforces:
 *   - Strict workspace boundaries (reads/writes only within authenticated workspace)
 *   - Invariant: Newly created clients always have `isDemo: false`
 *   - Referential integrity: Clients with existing invoices cannot be deleted (returns 409)
 *   - Prisma P2003 error translation to safeguard against concurrent deletion races
 */

import { db } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import type { CreateClientInput, UpdateClientInput } from "@/lib/validations/client";

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };

export interface ClientWithCount {
  id: string;
  workspaceId: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  notes: string | null;
  isDemo: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: {
    invoices: number;
  };
}

/**
 * Lists or searches clients strictly scoped to the authenticated workspace.
 */
export async function listClients(
  workspaceId: string,
  options?: { search?: string }
): Promise<ServiceResult<ClientWithCount[]>> {
  try {
    const search = options?.search?.trim();

    const clients = await db.client.findMany({
      where: {
        workspaceId,
        ...(search && search.length > 0
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
                { company: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { invoices: true },
        },
      },
    });

    return { ok: true, data: clients };
  } catch (err) {
    console.error("Failed to list clients:", err);
    return {
      ok: false,
      error: "An unexpected error occurred while listing clients.",
      code: "INTERNAL_ERROR",
    };
  }
}

/**
 * Retrieves a single client by ID strictly within the authenticated workspace.
 * Fails closed with NOT_FOUND if the client does not exist or belongs to another workspace.
 */
export async function getClientById(
  clientId: string,
  workspaceId: string
): Promise<ServiceResult<ClientWithCount>> {
  try {
    const client = await db.client.findFirst({
      where: {
        id: clientId,
        workspaceId,
      },
      include: {
        _count: {
          select: { invoices: true },
        },
      },
    });

    if (!client) {
      return {
        ok: false,
        error: "Client not found in this workspace.",
        code: "NOT_FOUND",
      };
    }

    return { ok: true, data: client };
  } catch (err) {
    console.error("Failed to retrieve client:", err);
    return {
      ok: false,
      error: "An unexpected error occurred while retrieving the client.",
      code: "INTERNAL_ERROR",
    };
  }
}

/**
 * Creates a new client within the authenticated workspace.
 * Invariant: `isDemo` is always hardcoded to false for user-created clients.
 */
export async function createClient(
  workspaceId: string,
  data: CreateClientInput
): Promise<ServiceResult<ClientWithCount>> {
  try {
    const client = await db.client.create({
      data: {
        workspaceId,
        name: data.name,
        email: data.email,
        phone: data.phone ?? null,
        company: data.company ?? null,
        notes: data.notes ?? null,
        isDemo: false,
      },
      include: {
        _count: {
          select: { invoices: true },
        },
      },
    });

    return { ok: true, data: client };
  } catch (err) {
    console.error("Failed to create client:", err);
    return {
      ok: false,
      error: "An unexpected error occurred while creating the client.",
      code: "INTERNAL_ERROR",
    };
  }
}

/**
 * Updates a client strictly within the authenticated workspace.
 * Fails closed with NOT_FOUND if the client does not exist or belongs to another workspace.
 */
export async function updateClient(
  clientId: string,
  workspaceId: string,
  data: UpdateClientInput
): Promise<ServiceResult<ClientWithCount>> {
  try {
    const existing = await db.client.findFirst({
      where: {
        id: clientId,
        workspaceId,
      },
      select: { id: true },
    });

    if (!existing) {
      return {
        ok: false,
        error: "Client not found in this workspace.",
        code: "NOT_FOUND",
      };
    }

    const updated = await db.client.update({
      where: { id: clientId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        ...(data.company !== undefined ? { company: data.company } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
      include: {
        _count: {
          select: { invoices: true },
        },
      },
    });

    return { ok: true, data: updated };
  } catch (err) {
    console.error("Failed to update client:", err);
    return {
      ok: false,
      error: "An unexpected error occurred while updating the client.",
      code: "INTERNAL_ERROR",
    };
  }
}

/**
 * Deletes an unreferenced client strictly within the authenticated workspace.
 * If the client has existing invoices, deletion is rejected with 409
 * to preserve invoice history and financial auditability.
 * Translates Prisma P2003 foreign key constraint errors to safe 409 responses.
 */
export async function deleteClient(
  clientId: string,
  workspaceId: string
): Promise<ServiceResult<{ id: string; deleted: true }>> {
  try {
    const existing = await db.client.findFirst({
      where: {
        id: clientId,
        workspaceId,
      },
      select: { id: true },
    });

    if (!existing) {
      return {
        ok: false,
        error: "Client not found in this workspace.",
        code: "NOT_FOUND",
      };
    }

    // Pre-check for associated invoices
    const invoiceCount = await db.invoice.count({
      where: { clientId, workspaceId },
    });

    if (invoiceCount > 0) {
      return {
        ok: false,
        error: "Cannot delete client with existing invoices. Client records must be retained for financial auditability.",
        code: "CANNOT_DELETE_CLIENT_WITH_INVOICES",
      };
    }

    await db.client.delete({
      where: { id: clientId },
    });

    return { ok: true, data: { id: clientId, deleted: true } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return {
        ok: false,
        error: "Cannot delete client with existing invoices. Client records must be retained for financial auditability.",
        code: "CANNOT_DELETE_CLIENT_WITH_INVOICES",
      };
    }

    console.error("Failed to delete client:", err);
    return {
      ok: false,
      error: "An unexpected error occurred while deleting the client.",
      code: "INTERNAL_ERROR",
    };
  }
}
