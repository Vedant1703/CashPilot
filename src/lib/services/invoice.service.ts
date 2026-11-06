/**
 * CashPilot AI — Invoice Service
 *
 * SRS §4: Invoice drafting, approval, PayPal integration, status reconciliation
 * SRS §7: Financial correctness — server-side totals, integer minor units
 *
 * This is the authoritative business logic layer for invoices.
 * It enforces:
 *   - Server-side total calculation (never trusted from client/AI)
 *   - Approval payload binding and invalidation
 *   - Provider status separation from CashPilot workflow status
 *   - Audit event recording for all consequential operations
 */

import { db } from "@/lib/db/client";
import {
  computeInvoiceTotals,
  minorUnitsToDecimalString,
  parseMoneyToMinorUnits,
} from "@/lib/money";
import {
  invoiceInputSchema,
  type InvoiceInput,
  type ApprovalPayload,
  type SupportedCurrency,
} from "@/lib/validations/invoice";
import {
  createPayPalDraftInvoice,
  sendPayPalInvoice,
  getPayPalInvoiceStatus,
  sendPayPalReminder,
  cancelPayPalInvoice,
  type PayPalInvoicePayload,
} from "@/lib/paypal/adapter";
import {
  mapPayPalStatusToCashPilot,
  canSendToPayPal,
  canSendReminder,
  canCancelInvoice,
} from "@/lib/paypal/status-mapper";
import {
  CashPilotStatus,
  ApprovalStatus,
  ApprovalAction,
  OperationType,
  OperationAttemptState,
  ActivityEventType,
  ActorType,
  Prisma,
} from "@prisma/client";
import { createHash } from "crypto";
import {
  calculateDashboardMetrics,
  groupInvoicesForCollections,
  type InvoiceRecord,
} from "@/lib/dashboard/metrics";

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Approval Payload Hashing
// SRS §4: Bind approval to the exact material payload
// ─────────────────────────────────────────────────────────────────────────────

function canonicalStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalStringify((obj as Record<string, unknown>)[k])
      )
      .join(",") +
    "}"
  );
}

export function computeMaterialPayloadHash(invoice: {
  id: string;
  workspaceId: string;
  client: { email: string };
  totalMinorUnits: number;
  currency: string;
  dueDate: Date | string;
  actionType?: "SEND_INVOICE" | "SEND_REMINDER" | "CANCEL_INVOICE";
  lineItems?: Array<{
    description: string;
    quantity: number;
    unitPriceMinorUnits: number;
  }>;
  note?: string;
  subject?: string;
}): string {
  const canonical: Record<string, unknown> = {
    actionType: invoice.actionType ?? "SEND_INVOICE",
    currency: invoice.currency,
    dueDate:
      typeof invoice.dueDate === "string"
        ? invoice.dueDate.substring(0, 10)
        : invoice.dueDate.toISOString().substring(0, 10),
    invoiceId: invoice.id,
    lineItems: (invoice.lineItems || []).map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPriceMinorUnits: li.unitPriceMinorUnits,
    })),
    recipientEmail: invoice.client.email,
    totalMinorUnits: invoice.totalMinorUnits,
    workspaceId: invoice.workspaceId,
  };
  if (invoice.note !== undefined && invoice.note !== null && invoice.note !== "") {
    canonical.note = invoice.note;
  }
  if (invoice.subject !== undefined && invoice.subject !== null && invoice.subject !== "") {
    canonical.subject = invoice.subject;
  }
  return createHash("sha256").update(canonicalStringify(canonical)).digest("hex");
}

function buildApprovalPayload(
  invoice: Awaited<ReturnType<typeof getInvoiceById>>,
  actionType: "SEND_INVOICE" | "SEND_REMINDER" | "CANCEL_INVOICE"
): ApprovalPayload {
  if (!invoice) throw new Error("Cannot build approval payload for null invoice");
  return {
    invoiceId: invoice.id,
    workspaceId: invoice.workspaceId,
    actionType,
    recipientEmail: invoice.client.email,
    totalMinorUnits: invoice.totalMinorUnits,
    currency: invoice.currency,
    dueDate: invoice.dueDate.toISOString().substring(0, 10),
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function getInvoiceById(invoiceId: string, workspaceId: string) {
  return db.invoice.findFirst({
    where: { id: invoiceId, workspaceId },
    include: {
      client: true,
      lineItems: { orderBy: { sortOrder: "asc" } },
    },
  });
}

/**
 * Retrieve an invoice by ID and workspace, returning clean public fields and
 * the deterministic material payload hash.
 */
export async function getInvoice(invoiceId: string, workspaceId: string) {
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, workspaceId },
    include: {
      client: true,
      lineItems: { orderBy: { sortOrder: "asc" } },
      activities: { orderBy: { createdAt: "desc" }, take: 15 },
    },
  });
  if (!invoice) {
    return { ok: false as const, error: "Invoice not found", code: "NOT_FOUND" };
  }

  const materialPayloadHash = computeMaterialPayloadHash(invoice);

  return {
    ok: true as const,
    data: {
      invoice: {
        id: invoice.id,
        workspaceId: invoice.workspaceId,
        clientId: invoice.clientId,
        number: invoice.number,
        title: invoice.title,
        notes: invoice.notes,
        terms: invoice.terms,
        currency: invoice.currency,
        subtotalMinorUnits: invoice.subtotalMinorUnits,
        taxRateBasisPoints: invoice.taxRateBasisPoints,
        taxMinorUnits: invoice.taxMinorUnits,
        totalMinorUnits: invoice.totalMinorUnits,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        cashpilotStatus: invoice.cashpilotStatus,
        paypalInvoiceId: invoice.paypalInvoiceId,
        paypalStatus: invoice.paypalStatus,
        lastSyncAt: invoice.lastSyncAt,
        syncIsStale: invoice.syncIsStale,
        isDemoData: invoice.isDemoData,
        aiDraftId: invoice.aiDraftId,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
        client: {
          id: invoice.client.id,
          name: invoice.client.name,
          email: invoice.client.email,
          company: invoice.client.company,
          phone: invoice.client.phone,
          isDemo: invoice.client.isDemo,
        },
        lineItems: invoice.lineItems.map((li) => ({
          id: li.id,
          description: li.description,
          quantity: li.quantity,
          unitPriceMinorUnits: li.unitPriceMinorUnits,
          totalMinorUnits: li.totalMinorUnits,
          sortOrder: li.sortOrder,
        })),
        activities: (invoice.activities || []).map((a) => ({
          id: a.id,
          eventType: a.eventType,
          actorType: a.actorType,
          actorId: a.actorId,
          description: a.description,
          metadata: a.metadata as Record<string, unknown> | null,
          createdAt: a.createdAt,
        })),
      },
      materialPayloadHash,
    },
  };
}

/**
 * Create a new invoice from validated input.
 * Totals are computed server-side from line items — never trusted from input.
 *
 * SRS §4: Calculate totals in deterministic application code.
 */
export async function createInvoice(
  workspaceId: string,
  actorId: string,
  input: InvoiceInput
): Promise<
  ServiceResult<{
    invoiceId: string;
    invoice: NonNullable<Awaited<ReturnType<typeof getInvoice>>["data"]>["invoice"];
    materialPayloadHash: string;
  }>
> {
  // 1. Validate all fields
  const parsed = invoiceInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => i.message).join("; "),
      code: "VALIDATION_ERROR",
    };
  }

  const data = parsed.data;

  // 2. Verify client belongs to this workspace
  const client = await db.client.findFirst({
    where: { id: data.clientId, workspaceId },
  });
  if (!client) {
    return { ok: false, error: "Client not found in this workspace", code: "NOT_FOUND" };
  }

  // 3. Compute totals deterministically — server-side, never from AI or client
  const lineItemCalcs = data.lineItems.map((li) => ({
    quantity: li.quantity,
    unitPriceMinorUnits: li.unitPriceMinorUnits,
  }));

  let totals: ReturnType<typeof computeInvoiceTotals>;
  try {
    totals = computeInvoiceTotals(lineItemCalcs, data.taxRateBasisPoints);
  } catch (err) {
    return {
      ok: false,
      error: `Financial calculation error: ${err instanceof Error ? err.message : String(err)}`,
      code: "CALCULATION_ERROR",
    };
  }

  // 3b. Verify client-supplied totals if provided (must match server math)
  if (
    input.totalMinorUnits !== undefined &&
    input.totalMinorUnits !== totals.totalMinorUnits
  ) {
    return {
      ok: false,
      error: `Client-supplied total (${input.totalMinorUnits}) does not match server-calculated total (${totals.totalMinorUnits})`,
      code: "TOTAL_MISMATCH",
    };
  }

  if (
    input.subtotalMinorUnits !== undefined &&
    input.subtotalMinorUnits !== totals.subtotalMinorUnits
  ) {
    return {
      ok: false,
      error: `Client-supplied subtotal (${input.subtotalMinorUnits}) does not match server-calculated subtotal (${totals.subtotalMinorUnits})`,
      code: "SUBTOTAL_MISMATCH",
    };
  }

  // 4. Persist invoice and line items in a transaction
  const invoice = await db.$transaction(async (tx) => {
    const inv = await tx.invoice.create({
      data: {
        workspaceId,
        clientId: data.clientId,
        currency: data.currency,
        title: data.title,
        notes: data.notes,
        terms: data.terms,
        taxRateBasisPoints: data.taxRateBasisPoints,
        subtotalMinorUnits: totals.subtotalMinorUnits,
        taxMinorUnits: totals.taxMinorUnits,
        totalMinorUnits: totals.totalMinorUnits,
        invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : new Date(),
        dueDate: new Date(data.dueDate + "T00:00:00Z"),
        cashpilotStatus: CashPilotStatus.DRAFT,
        isDemoData: client.isDemo,
      },
      include: {
        client: true,
      },
    });

    // Create line items with deterministic totals
    const createdLineItems = await Promise.all(
      data.lineItems.map((li, idx) =>
        tx.invoiceLineItem.create({
          data: {
            invoiceId: inv.id,
            description: li.description,
            quantity: li.quantity,
            unitPriceMinorUnits: li.unitPriceMinorUnits,
            totalMinorUnits: totals.lineItemTotals[idx],
            sortOrder: idx,
          },
        })
      )
    );

    // Record audit event
    const createdActivity = await tx.activityEvent.create({
      data: {
        workspaceId,
        invoiceId: inv.id,
        eventType: ActivityEventType.INVOICE_CREATED,
        actorType: ActorType.USER,
        actorId,
        description: `Invoice created with total ${totals.totalMinorUnits} ${data.currency} minor units`,
        metadata: { totalMinorUnits: totals.totalMinorUnits, currency: data.currency },
      },
    });

    return {
      ...inv,
      lineItems: createdLineItems,
      activities: [createdActivity],
    };
  });

  const materialPayloadHash = computeMaterialPayloadHash(invoice);

  return {
    ok: true,
    data: {
      invoiceId: invoice.id,
      invoice: {
        id: invoice.id,
        workspaceId: invoice.workspaceId,
        clientId: invoice.clientId,
        number: invoice.number,
        title: invoice.title,
        notes: invoice.notes,
        terms: invoice.terms,
        currency: invoice.currency,
        subtotalMinorUnits: invoice.subtotalMinorUnits,
        taxRateBasisPoints: invoice.taxRateBasisPoints,
        taxMinorUnits: invoice.taxMinorUnits,
        totalMinorUnits: invoice.totalMinorUnits,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        cashpilotStatus: invoice.cashpilotStatus,
        paypalInvoiceId: invoice.paypalInvoiceId,
        paypalStatus: invoice.paypalStatus,
        lastSyncAt: invoice.lastSyncAt,
        syncIsStale: invoice.syncIsStale,
        isDemoData: invoice.isDemoData,
        aiDraftId: invoice.aiDraftId,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
        client: {
          id: invoice.client.id,
          name: invoice.client.name,
          email: invoice.client.email,
          company: invoice.client.company,
          phone: invoice.client.phone,
          isDemo: invoice.client.isDemo,
        },
        lineItems: invoice.lineItems.map((li) => ({
          id: li.id,
          description: li.description,
          quantity: li.quantity,
          unitPriceMinorUnits: li.unitPriceMinorUnits,
          totalMinorUnits: li.totalMinorUnits,
          sortOrder: li.sortOrder,
        })),
        activities: invoice.activities.map((a) => ({
          id: a.id,
          eventType: a.eventType,
          actorType: a.actorType,
          actorId: a.actorId,
          description: a.description,
          metadata: a.metadata as Record<string, unknown> | null,
          createdAt: a.createdAt,
        })),
      },
      materialPayloadHash,
    },
  };
}

/**
 * Update an existing draft invoice with deterministic totals and approval invalidation.
 *
 * SRS §4, §7 & QA GEN-02, GEN-03, GEN-04:
 * - Operates on an existing persistent draft with a stable ID
 * - Any material edit invalidates prior approvals (APPROVAL_INVALIDATED)
 * - If a PayPal draft was already created, modifying material content clears the linked PayPal draft
 * - Totals are computed server-side deterministically
 * - Records INVOICE_UPDATED in audit trail
 */
export async function updateInvoiceDraft(
  workspaceId: string,
  actorId: string,
  invoiceId: string,
  input: Partial<InvoiceInput>
): Promise<
  ServiceResult<{
    invoiceId: string;
    invoice: NonNullable<Awaited<ReturnType<typeof getInvoice>>["data"]>["invoice"];
    materialPayloadHash: string;
    approvalsInvalidated: number;
  }>
> {
  // 1. Fetch existing invoice
  const existing = await getInvoiceById(invoiceId, workspaceId);
  if (!existing) {
    return { ok: false, error: "Invoice not found in this workspace", code: "NOT_FOUND" };
  }

  // 2. Status guard: only DRAFT invoices may be edited (GEN-03)
  if (existing.cashpilotStatus !== CashPilotStatus.DRAFT) {
    return {
      ok: false,
      error: `Only DRAFT invoices can be updated (current status: ${existing.cashpilotStatus})`,
      code: "INVALID_INVOICE_STATUS",
    };
  }

  // 3. Merge input with existing values to allow partial updates
  const invoiceDateStr = existing.invoiceDate
    ? existing.invoiceDate instanceof Date
      ? existing.invoiceDate.toISOString().substring(0, 10)
      : String(existing.invoiceDate).substring(0, 10)
    : undefined;

  const dueDateStr = existing.dueDate
    ? existing.dueDate instanceof Date
      ? existing.dueDate.toISOString().substring(0, 10)
      : String(existing.dueDate).substring(0, 10)
    : new Date().toISOString().substring(0, 10);

  const mergedInput = {
    clientId: input.clientId ?? existing.clientId,
    title: input.title !== undefined ? input.title : existing.title,
    notes: input.notes !== undefined ? input.notes : existing.notes || undefined,
    terms: input.terms !== undefined ? input.terms : existing.terms || undefined,
    currency: (input.currency ?? existing.currency) as SupportedCurrency,
    taxRateBasisPoints: input.taxRateBasisPoints ?? existing.taxRateBasisPoints,
    invoiceDate: input.invoiceDate ?? invoiceDateStr,
    dueDate: input.dueDate ?? dueDateStr,
    lineItems:
      input.lineItems ??
      existing.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPriceMinorUnits: li.unitPriceMinorUnits,
      })),
    subtotalMinorUnits: input.subtotalMinorUnits,
    totalMinorUnits: input.totalMinorUnits,
  };

  // 4. Validate merged fields against schema
  const parsed = invoiceInputSchema.safeParse(mergedInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => i.message).join("; "),
      code: "VALIDATION_ERROR",
    };
  }

  const data = parsed.data;

  // 4. Verify client belongs to this workspace
  const client = await db.client.findFirst({
    where: { id: data.clientId, workspaceId },
  });
  if (!client) {
    return { ok: false, error: "Client not found in this workspace", code: "NOT_FOUND" };
  }

  // 5. Compute totals deterministically
  const lineItemCalcs = data.lineItems.map((li) => ({
    quantity: li.quantity,
    unitPriceMinorUnits: li.unitPriceMinorUnits,
  }));

  let totals: ReturnType<typeof computeInvoiceTotals>;
  try {
    totals = computeInvoiceTotals(lineItemCalcs, data.taxRateBasisPoints);
  } catch (err) {
    return {
      ok: false,
      error: `Financial calculation error: ${err instanceof Error ? err.message : String(err)}`,
      code: "CALCULATION_ERROR",
    };
  }

  // 5b. Verify client-supplied totals if provided
  if (
    input.totalMinorUnits !== undefined &&
    input.totalMinorUnits !== totals.totalMinorUnits
  ) {
    return {
      ok: false,
      error: `Client-supplied total (${input.totalMinorUnits}) does not match server-calculated total (${totals.totalMinorUnits})`,
      code: "TOTAL_MISMATCH",
    };
  }

  if (
    input.subtotalMinorUnits !== undefined &&
    input.subtotalMinorUnits !== totals.subtotalMinorUnits
  ) {
    return {
      ok: false,
      error: `Client-supplied subtotal (${input.subtotalMinorUnits}) does not match server-calculated subtotal (${totals.subtotalMinorUnits})`,
      code: "SUBTOTAL_MISMATCH",
    };
  }

  // 6. Invalidate any pending or active approvals (GEN-04)
  const activeApprovals = await db.approval.findMany({
    where: {
      invoiceId,
      workspaceId,
      status: { in: [ApprovalStatus.PENDING, ApprovalStatus.APPROVED] },
    },
  });

  // 7. Execute update transaction
  const updatedInvoice = await db.$transaction(async (tx) => {
    // Invalidate approvals
    if (activeApprovals.length > 0) {
      await tx.approval.updateMany({
        where: {
          id: { in: activeApprovals.map((a) => a.id) },
        },
        data: {
          status: ApprovalStatus.INVALIDATED,
          invalidatedAt: new Date(),
          invalidationReason: "Invoice material fields changed after approval",
        },
      });

      for (const a of activeApprovals) {
        await tx.activityEvent.create({
          data: {
            workspaceId,
            invoiceId,
            approvalId: a.id,
            eventType: ActivityEventType.APPROVAL_INVALIDATED,
            actorType: ActorType.USER,
            actorId,
            description: "Approval invalidated: invoice draft was edited after approval",
            metadata: { previousPayloadHash: a.payloadHash },
          },
        });
      }
    }

    // Replace line items
    await tx.invoiceLineItem.deleteMany({
      where: { invoiceId },
    });

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        clientId: data.clientId,
        currency: data.currency,
        title: data.title,
        notes: data.notes,
        terms: data.terms,
        taxRateBasisPoints: data.taxRateBasisPoints,
        subtotalMinorUnits: totals.subtotalMinorUnits,
        taxMinorUnits: totals.taxMinorUnits,
        totalMinorUnits: totals.totalMinorUnits,
        invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : existing.invoiceDate,
        dueDate: new Date(data.dueDate + "T00:00:00Z"),
        paypalInvoiceId: null,
        paypalStatus: null,
        paypalStatusRaw: Prisma.DbNull,
        isDemoData: client.isDemo,
        updatedAt: new Date(),
      },
      include: {
        client: true,
      },
    });

    if (existing.paypalInvoiceId) {
      await tx.activityEvent.create({
        data: {
          workspaceId,
          invoiceId,
          eventType: ActivityEventType.INVOICE_UPDATED,
          actorType: ActorType.USER,
          actorId,
          description: `Un-sent PayPal Sandbox draft ${existing.paypalInvoiceId} cleared due to invoice modifications`,
          metadata: { clearedPaypalInvoiceId: existing.paypalInvoiceId },
        },
      });
    }

    const createdLineItems = await Promise.all(
      data.lineItems.map((li, idx) =>
        tx.invoiceLineItem.create({
          data: {
            invoiceId,
            description: li.description,
            quantity: li.quantity,
            unitPriceMinorUnits: li.unitPriceMinorUnits,
            totalMinorUnits: totals.lineItemTotals[idx],
            sortOrder: idx,
          },
        })
      )
    );

    const updatedActivity = await tx.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        eventType: ActivityEventType.INVOICE_UPDATED,
        actorType: ActorType.USER,
        actorId,
        description: `Draft invoice updated with total ${totals.totalMinorUnits} ${data.currency} minor units`,
        metadata: {
          totalMinorUnits: totals.totalMinorUnits,
          currency: data.currency,
          approvalsInvalidated: activeApprovals.length,
        },
      },
    });

    return {
      ...updated,
      lineItems: createdLineItems,
      activities: [updatedActivity],
    };
  });

  const materialPayloadHash = computeMaterialPayloadHash(updatedInvoice);

  return {
    ok: true,
    data: {
      invoiceId: updatedInvoice.id,
      invoice: {
        id: updatedInvoice.id,
        workspaceId: updatedInvoice.workspaceId,
        clientId: updatedInvoice.clientId,
        number: updatedInvoice.number,
        title: updatedInvoice.title,
        notes: updatedInvoice.notes,
        terms: updatedInvoice.terms,
        currency: updatedInvoice.currency,
        subtotalMinorUnits: updatedInvoice.subtotalMinorUnits,
        taxRateBasisPoints: updatedInvoice.taxRateBasisPoints,
        taxMinorUnits: updatedInvoice.taxMinorUnits,
        totalMinorUnits: updatedInvoice.totalMinorUnits,
        invoiceDate: updatedInvoice.invoiceDate,
        dueDate: updatedInvoice.dueDate,
        cashpilotStatus: updatedInvoice.cashpilotStatus,
        paypalInvoiceId: updatedInvoice.paypalInvoiceId,
        paypalStatus: updatedInvoice.paypalStatus,
        lastSyncAt: updatedInvoice.lastSyncAt,
        syncIsStale: updatedInvoice.syncIsStale,
        isDemoData: updatedInvoice.isDemoData,
        aiDraftId: updatedInvoice.aiDraftId,
        createdAt: updatedInvoice.createdAt,
        updatedAt: updatedInvoice.updatedAt,
        client: {
          id: updatedInvoice.client.id,
          name: updatedInvoice.client.name,
          email: updatedInvoice.client.email,
          company: updatedInvoice.client.company,
          phone: updatedInvoice.client.phone,
          isDemo: updatedInvoice.client.isDemo,
        },
        lineItems: updatedInvoice.lineItems.map((li) => ({
          id: li.id,
          description: li.description,
          quantity: li.quantity,
          unitPriceMinorUnits: li.unitPriceMinorUnits,
          totalMinorUnits: li.totalMinorUnits,
          sortOrder: li.sortOrder,
        })),
        activities: updatedInvoice.activities.map((a) => ({
          id: a.id,
          eventType: a.eventType,
          actorType: a.actorType,
          actorId: a.actorId,
          description: a.description,
          metadata: a.metadata as Record<string, unknown> | null,
          createdAt: a.createdAt,
        })),
      },
      materialPayloadHash,
      approvalsInvalidated: activeApprovals.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval Flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an approval for a consequential action.
 * Binds approval to the exact current material payload.
 *
 * SRS §4: Any material field change invalidates prior approvals.
 */
export async function createApproval(
  workspaceId: string,
  actorId: string,
  invoiceId: string,
  actionType: ApprovalAction
): Promise<ServiceResult<{ approvalId: string; payloadHash: string }>> {
  const invoice = await getInvoiceById(invoiceId, workspaceId);
  if (!invoice) {
    return { ok: false, error: "Invoice not found", code: "NOT_FOUND" };
  }

  // Build the material payload snapshot and compute canonical hash
  const payload = buildApprovalPayload(invoice, actionType);
  const payloadHash = computeMaterialPayloadHash({
    ...invoice,
    actionType,
  });

  // Invalidate any previously PENDING approvals for the same invoice+action
  await db.approval.updateMany({
    where: {
      invoiceId,
      workspaceId,
      actionType,
      status: ApprovalStatus.PENDING,
    },
    data: {
      status: ApprovalStatus.INVALIDATED,
      invalidatedAt: new Date(),
      invalidationReason: "New approval created",
    },
  });

  const approval = await db.$transaction(async (tx) => {
    const a = await tx.approval.create({
      data: {
        workspaceId,
        invoiceId,
        actorId,
        actionType,
        payloadHash,
        payloadSnapshot: payload as unknown as Prisma.InputJsonValue,
        status: ApprovalStatus.PENDING,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15-minute expiry
      },
    });

    await tx.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        approvalId: a.id,
        eventType: ActivityEventType.APPROVAL_CREATED,
        actorType: ActorType.USER,
        actorId,
        description: `Approval requested for action: ${actionType}`,
        metadata: { actionType, payloadHash },
      },
    });

    return a;
  });

  return { ok: true, data: { approvalId: approval.id, payloadHash } };
}

/**
 * Confirm an approval (user clicks "Approve").
 * Transitions status from PENDING → APPROVED.
 */
export async function confirmApproval(
  workspaceId: string,
  actorId: string,
  approvalId: string
): Promise<ServiceResult<{ approvalId: string }>> {
  const approval = await db.approval.findFirst({
    where: { id: approvalId, workspaceId },
  });

  if (!approval) {
    return { ok: false, error: "Approval not found", code: "NOT_FOUND" };
  }

  if (approval.status !== ApprovalStatus.PENDING) {
    return {
      ok: false,
      error: `Approval is not in PENDING state (current: ${approval.status})`,
      code: "INVALID_STATE",
    };
  }

  // Check expiry
  if (approval.expiresAt && approval.expiresAt < new Date()) {
    await db.approval.update({
      where: { id: approvalId },
      data: { status: ApprovalStatus.EXPIRED },
    });
    return { ok: false, error: "Approval has expired", code: "EXPIRED" };
  }

  await db.$transaction(async (tx) => {
    await tx.approval.update({
      where: { id: approvalId },
      data: { status: ApprovalStatus.APPROVED, approvedAt: new Date() },
    });

    await tx.activityEvent.create({
      data: {
        workspaceId,
        approvalId,
        eventType: ActivityEventType.APPROVAL_APPROVED,
        actorType: ActorType.USER,
        actorId,
        description: `Approval confirmed for action: ${approval.actionType}`,
        metadata: { actionType: approval.actionType },
      },
    });
  });

  return { ok: true, data: { approvalId } };
}

export interface ApproveInvoiceResult {
  approvalId: string;
  invoiceId: string;
  actionType: ApprovalAction;
  status: ApprovalStatus;
  approvedPayloadHash: string;
  approvedAt: Date;
  expiresAt: Date;
}

/**
 * Approve an invoice action (POST /api/invoices/[id]/approve).
 *
 * Verifies that the invoice is in an acceptable state, recalculates the authoritative
 * material payload hash on the server, rejects stale hashes (i.e. if the invoice
 * changed after review), and transactionally records the approved state with full
 * concurrency protections and an append-only audit event.
 */
export async function approveInvoice(
  workspaceId: string,
  actorId: string,
  invoiceId: string,
  actionType: ApprovalAction,
  reviewedPayloadHash: string,
  reminderMeta?: { note?: string; subject?: string }
): Promise<ServiceResult<ApproveInvoiceResult>> {
  // 1. Fetch current invoice with client and line items
  const invoice = await getInvoiceById(invoiceId, workspaceId);
  if (!invoice) {
    return { ok: false, error: "Invoice not found in this workspace", code: "NOT_FOUND" };
  }

  // 2. Validate invoice workflow state
  if (
    actionType === ApprovalAction.SEND_INVOICE &&
    invoice.cashpilotStatus !== CashPilotStatus.DRAFT
  ) {
    return {
      ok: false,
      error: `Only DRAFT invoices can be approved for sending (current status: ${invoice.cashpilotStatus})`,
      code: "INVALID_INVOICE_STATUS",
    };
  }

  if (
    actionType === ApprovalAction.SEND_REMINDER &&
    !canSendReminder(invoice.cashpilotStatus)
  ) {
    return {
      ok: false,
      error: `Only AWAITING_PAYMENT, DUE_SOON, or OVERDUE invoices can receive reminders (current status: ${invoice.cashpilotStatus})`,
      code: "INVALID_INVOICE_STATUS",
    };
  }

  if (actionType === ApprovalAction.CANCEL_INVOICE) {
    if (!invoice.paypalInvoiceId) {
      return {
        ok: false,
        error: "Draft invoices that have not been sent to PayPal cannot be cancelled via this endpoint.",
        code: "PAYPAL_INVOICE_REQUIRED",
      };
    }
    if (invoice.cashpilotStatus === CashPilotStatus.DRAFT || invoice.paypalStatus === "DRAFT") {
      return {
        ok: false,
        error: "Draft invoices cannot be cancelled via the sent invoice cancellation endpoint.",
        code: "INVALID_INVOICE_STATUS",
      };
    }
    if (
      invoice.cashpilotStatus === CashPilotStatus.PAID ||
      invoice.paypalStatus === "PAID" ||
      invoice.paypalStatus === "MARKED_AS_PAID"
    ) {
      return {
        ok: false,
        error: "Paid invoices cannot be cancelled.",
        code: "INVALID_INVOICE_STATUS",
      };
    }
    if (invoice.paypalStatus === "PARTIALLY_PAID") {
      return {
        ok: false,
        error: "Partially paid invoices cannot be cancelled through this workflow.",
        code: "INVALID_INVOICE_STATUS",
      };
    }
    if (
      invoice.cashpilotStatus === CashPilotStatus.CANCELLED ||
      invoice.paypalStatus === "CANCELLED" ||
      invoice.paypalStatus === "VOIDED"
    ) {
      return {
        ok: false,
        error: "Invoice is already cancelled.",
        code: "INVALID_INVOICE_STATUS",
      };
    }
    if (invoice.cashpilotStatus === CashPilotStatus.NEEDS_REVIEW || invoice.syncIsStale) {
      return {
        ok: false,
        error: "Invoice provider state is ambiguous or stale. Reconcile provider status before cancelling.",
        code: "PROVIDER_STATE_AMBIGUOUS",
      };
    }
    if (!canCancelInvoice(invoice.cashpilotStatus, invoice.paypalStatus)) {
      return {
        ok: false,
        error: `Invoices in status ${invoice.cashpilotStatus} (provider status: ${invoice.paypalStatus}) cannot be approved for cancellation.`,
        code: "INVALID_INVOICE_STATUS",
      };
    }
  }

  // 3. Compute authoritative current material payload hash on server
  const currentPayloadHash = computeMaterialPayloadHash({
    ...invoice,
    actionType,
    note: reminderMeta?.note,
    subject: reminderMeta?.subject,
  });

  // 4. Stale review check: hash MUST match what the user reviewed
  if (reviewedPayloadHash !== currentPayloadHash) {
    return {
      ok: false,
      error:
        "The invoice has changed since review. The reviewed hash does not match the current material payload hash. Please review the updated invoice and approve again.",
      code: "STALE_PAYLOAD_HASH",
    };
  }

  // 5. Execute approval creation transactionally with idempotency & concurrency protection
  return db.$transaction(async (tx) => {
    // Check if an identical active approval already exists for this exact hash
    const existing = await tx.approval.findFirst({
      where: {
        invoiceId,
        workspaceId,
        actionType,
        payloadHash: currentPayloadHash,
        status: ApprovalStatus.APPROVED,
        expiresAt: { gt: new Date() },
      },
    });

    if (existing && existing.approvedAt && existing.expiresAt) {
      return {
        ok: true,
        data: {
          approvalId: existing.id,
          invoiceId,
          actionType,
          status: existing.status,
          approvedPayloadHash: existing.payloadHash,
          approvedAt: existing.approvedAt,
          expiresAt: existing.expiresAt,
        },
      };
    }

    // Invalidate any previously active/pending approvals for this invoice + action
    await tx.approval.updateMany({
      where: {
        invoiceId,
        workspaceId,
        actionType,
        status: { in: [ApprovalStatus.PENDING, ApprovalStatus.APPROVED] },
      },
      data: {
        status: ApprovalStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: "Superseded by new approval confirmation",
      },
    });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15-minute expiry window

    const payloadSnapshot = {
      invoiceId: invoice.id,
      workspaceId: invoice.workspaceId,
      actionType,
      recipientEmail: invoice.client.email,
      totalMinorUnits: invoice.totalMinorUnits,
      currency: invoice.currency,
      dueDate: invoice.dueDate.toISOString().substring(0, 10),
      lineItems: invoice.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPriceMinorUnits: li.unitPriceMinorUnits,
        totalMinorUnits: li.totalMinorUnits,
      })),
      timestamp: now.toISOString(),
      ...(reminderMeta?.note ? { note: reminderMeta.note } : {}),
      ...(reminderMeta?.subject ? { subject: reminderMeta.subject } : {}),
    };

    const approval = await tx.approval.create({
      data: {
        workspaceId,
        invoiceId,
        actorId,
        actionType,
        payloadHash: currentPayloadHash,
        payloadSnapshot: payloadSnapshot as unknown as Prisma.InputJsonValue,
        status: ApprovalStatus.APPROVED,
        approvedAt: now,
        expiresAt,
      },
    });

    await tx.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        approvalId: approval.id,
        eventType: ActivityEventType.APPROVAL_APPROVED,
        actorType: ActorType.USER,
        actorId,
        description: `Invoice approval confirmed for action: ${actionType} locked to hash ${currentPayloadHash.slice(0, 8)}...`,
        metadata: {
          actionType,
          payloadHash: currentPayloadHash,
          totalMinorUnits: invoice.totalMinorUnits,
          currency: invoice.currency,
        },
      },
    });

    return {
      ok: true,
      data: {
        approvalId: approval.id,
        invoiceId,
        actionType,
        status: approval.status,
        approvedPayloadHash: currentPayloadHash,
        approvedAt: approval.approvedAt!,
        expiresAt: approval.expiresAt!,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PayPal Operations — Require Valid Approval
// ─────────────────────────────────────────────────────────────────────────────

export interface CreatePayPalDraftResult {
  operationId: string;
  paypalInvoiceId: string;
  paypalStatus: string;
  correlationId?: string;
  isExistingDraft?: boolean;
}

/**
 * Create a PayPal Sandbox draft invoice for an approved CashPilot invoice.
 *
 * SRS §4 & Financial Integrity Rules:
 *   - Human approval required: MUST have an active SEND_INVOICE approval
 *   - Approval bound to exact current material payload hash (recomputed server-side)
 *   - Stale/modified invoice invalidates approval and rejects draft creation
 *   - Finite timeouts, unknown-outcome tracking, idempotency key
 *   - Draft creation ONLY — does not send, execute payment, or transition to PAID
 *   - paypalStatus and cashpilotStatus remain strictly separate
 */
export async function createPayPalDraft(
  workspaceId: string,
  actorId: string,
  invoiceId: string,
  explicitApprovalId?: string
): Promise<ServiceResult<CreatePayPalDraftResult>> {
  // 1. Fetch current invoice with client and line items
  const invoice = await getInvoiceById(invoiceId, workspaceId);
  if (!invoice) {
    return { ok: false, error: "Invoice not found in this workspace", code: "NOT_FOUND" };
  }

  // 2. State invariant: Only DRAFT invoices can have a draft created in PayPal
  if (invoice.cashpilotStatus !== CashPilotStatus.DRAFT) {
    return {
      ok: false,
      error: `PayPal drafts can only be created for DRAFT invoices (current status: ${invoice.cashpilotStatus})`,
      code: "INVALID_INVOICE_STATUS",
    };
  }

  // 3. Deduplication: Check if invoice already has a PayPal draft
  if (invoice.paypalInvoiceId) {
    return {
      ok: true,
      data: {
        operationId: "existing",
        paypalInvoiceId: invoice.paypalInvoiceId,
        paypalStatus: invoice.paypalStatus ?? "DRAFT",
        isExistingDraft: true,
      },
    };
  }

  // 4. Locate the active approval for SEND_INVOICE
  const approval = explicitApprovalId
    ? await db.approval.findFirst({
        where: {
          id: explicitApprovalId,
          invoiceId,
          workspaceId,
          actionType: ApprovalAction.SEND_INVOICE,
          status: ApprovalStatus.APPROVED,
        },
      })
    : await db.approval.findFirst({
        where: {
          invoiceId,
          workspaceId,
          actionType: ApprovalAction.SEND_INVOICE,
          status: ApprovalStatus.APPROVED,
        },
        orderBy: { createdAt: "desc" },
      });

  if (!approval) {
    return {
      ok: false,
      error: "An approved SEND_INVOICE action is required before creating a PayPal draft.",
      code: "APPROVAL_REQUIRED",
    };
  }

  // 5. Expiry check
  if (approval.expiresAt && approval.expiresAt < new Date()) {
    return {
      ok: false,
      error: "The approval for this invoice has expired. Please review and re-approve.",
      code: "APPROVAL_EXPIRED",
    };
  }

  // 6. Stale payload check: Recompute authoritative material hash on server
  const currentHash = computeMaterialPayloadHash({
    ...invoice,
    actionType: approval.actionType,
  });

  if (currentHash !== approval.payloadHash) {
    // Invalidate stale approval
    await db.approval.update({
      where: { id: approval.id },
      data: {
        status: ApprovalStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: "Invoice material fields changed after approval",
      },
    });

    await db.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        approvalId: approval.id,
        eventType: ActivityEventType.APPROVAL_INVALIDATED,
        actorType: ActorType.SYSTEM,
        actorId: "system",
        description: "Approval invalidated: invoice content changed after approval",
        metadata: { expectedHash: approval.payloadHash, actualHash: currentHash },
      },
    });

    return {
      ok: false,
      error: "Invoice was modified after approval. Approval invalidated. Please review and re-approve.",
      code: "APPROVAL_STALE",
    };
  }

  // 7. Check for previous unknown-outcome operation to prevent blind retry
  const pendingOp = await db.externalOperation.findFirst({
    where: {
      invoiceId,
      workspaceId,
      operationType: OperationType.CREATE_DRAFT,
      isOutcomeUnknown: true,
    },
  });

  if (pendingOp) {
    return {
      ok: false,
      error: "A previous PayPal draft creation operation has an unknown outcome (timed out). Reconcile before retrying.",
      code: "PENDING_UNKNOWN_OPERATION",
    };
  }

  // 8. Create in-flight ExternalOperation record with idempotency key
  const idempotencyKey = `draft-${invoice.id}-${approval.id}`;
  const operation = await db.externalOperation.create({
    data: {
      workspaceId,
      invoiceId: invoice.id,
      approvalId: approval.id,
      operationType: OperationType.CREATE_DRAFT,
      idempotencyKey,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: new Date(),
    },
  });

  // 9. Build validated PayPal Invoicing payload and call Sandbox API
  const draftPayload = buildPayPalInvoicePayload(invoice);
  const draftResult = await createPayPalDraftInvoice(draftPayload, idempotencyKey);

  // 10. Handle provider error or timeout
  if (!draftResult.success) {
    const isUnknown = "isOutcomeUnknown" in draftResult && draftResult.isOutcomeUnknown;
    await updateOperationAndAudit(
      operation.id,
      workspaceId,
      invoice.id,
      approval.id,
      actorId,
      isUnknown ? OperationAttemptState.UNKNOWN : OperationAttemptState.FAILED,
      isUnknown,
      draftResult.error.code,
      draftResult.error.message,
      draftResult.correlationId
    );

    return {
      ok: false,
      error: draftResult.error.message,
      code: isUnknown ? "OPERATION_UNKNOWN_OUTCOME" : draftResult.error.code,
    };
  }

  // 10.5. Reconcile provider returned totals against CashPilot authoritative totals (GEN-08)
  const paypalReturnedTotal = draftResult.data.amount?.value;
  if (paypalReturnedTotal) {
    const paypalTotalMinorUnits = parseMoneyToMinorUnits(paypalReturnedTotal);
    if (paypalTotalMinorUnits !== null && paypalTotalMinorUnits !== invoice.totalMinorUnits) {
      await updateOperationAndAudit(
        operation.id,
        workspaceId,
        invoice.id,
        approval.id,
        actorId,
        OperationAttemptState.FAILED,
        false,
        "TOTAL_MISMATCH",
        `PayPal draft total (${paypalReturnedTotal} ${invoice.currency}) does not match CashPilot authoritative total (${minorUnitsToDecimalString(invoice.totalMinorUnits)} ${invoice.currency}). Draft rejected for financial safety.`,
        draftResult.correlationId
      );

      // Transition invoice to NEEDS_REVIEW to prevent sending mismatched invoice
      await db.invoice.update({
        where: { id: invoice.id },
        data: {
          cashpilotStatus: CashPilotStatus.NEEDS_REVIEW,
          syncIsStale: true,
        },
      });

      return {
        ok: false,
        error: `Financial safety rejection: PayPal draft total (${paypalReturnedTotal} ${invoice.currency}) does not match CashPilot authoritative total (${minorUnitsToDecimalString(invoice.totalMinorUnits)} ${invoice.currency}).`,
        code: "TOTAL_MISMATCH",
      };
    }
  }

  // 11. Success: Persist PayPal invoice ID and status inside a transaction
  const paypalInvoiceId = draftResult.data.id;
  const paypalStatus = draftResult.data.status ?? "DRAFT";

  try {
    await db.$transaction(async (tx) => {
      await tx.externalOperation.update({
        where: { id: operation.id },
        data: {
          attemptState: OperationAttemptState.SUCCESS,
          completedAt: new Date(),
          providerInvoiceId: paypalInvoiceId,
          correlationId: draftResult.correlationId,
          providerResponse: {
            id: paypalInvoiceId,
            status: paypalStatus,
          },
        },
      });

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paypalInvoiceId,
          paypalStatus,
          paypalStatusRaw: {
            id: paypalInvoiceId,
            status: paypalStatus,
            correlationId: draftResult.correlationId,
          },
          lastSyncAt: new Date(),
          syncIsStale: false,
          // cashpilotStatus remains DRAFT! Never marked PAID.
        },
      });

      await tx.activityEvent.create({
        data: {
          workspaceId,
          invoiceId: invoice.id,
          approvalId: approval.id,
          operationId: operation.id,
          eventType: ActivityEventType.OPERATION_SUCCEEDED,
          actorType: ActorType.USER,
          actorId,
          description: `PayPal draft invoice created successfully: ${paypalInvoiceId}`,
          metadata: {
            paypalInvoiceId,
            paypalStatus,
            correlationId: draftResult.correlationId,
          },
        },
      });
    });
  } catch (dbErr) {
    console.error(
      `Failed to persist PayPal invoice ${paypalInvoiceId} to local DB:`,
      dbErr instanceof Error ? dbErr.message : dbErr
    );
    try {
      await db.externalOperation.update({
        where: { id: operation.id },
        data: {
          attemptState: OperationAttemptState.UNKNOWN,
          providerInvoiceId: paypalInvoiceId,
          isOutcomeUnknown: true,
          errorMessage: "PayPal draft created but local database update failed",
          correlationId: draftResult.correlationId,
        },
      });
    } catch {
      // Suppress secondary error
    }
    return {
      ok: false,
      error: `PayPal draft ${paypalInvoiceId} was created on PayPal, but local database persistence failed. Reconciliation required.`,
      code: "DATABASE_PERSISTENCE_FAILED",
    };
  }

  return {
    ok: true,
    data: {
      operationId: operation.id,
      paypalInvoiceId,
      paypalStatus,
      correlationId: draftResult.correlationId,
    },
  };
}

export interface SendInvoiceResult {
  operationId: string;
  invoiceId: string;
  paypalInvoiceId: string;
  paypalStatus: string;
  cashpilotStatus: CashPilotStatus;
  isAlreadySent: boolean;
  sentAt: Date;
  correlationId?: string;
}

/**
 * Execute an approved invoice send operation against PayPal Sandbox.
 *
 * SRS §4 & Financial Integrity Rules:
 *   - Human approval required: MUST have an active SEND_INVOICE approval
 *   - Approval bound to exact current material payload hash (recomputed server-side)
 *   - Stale/modified invoice invalidates approval and rejects send (409 Conflict)
 *   - Requires PayPal draft to ALREADY exist; NEVER creates a draft as part of sending
 *   - Validates that recipient, amount, currency match approved snapshot
 *   - Idempotent: Subsequent duplicate send requests return known result without resending
 *   - Prevents concurrent requests from sending the same invoice simultaneously
 *   - Timeouts / uncertain outcomes recorded as UNKNOWN; blind retries blocked
 *   - DB persistence failure after provider response marks outcome unknown for reconciliation
 *   - A successful send NEVER marks invoice as PAID (transitions to AWAITING_PAYMENT / DUE_SOON / OVERDUE)
 *   - Raw provider status (SENT) and CashPilot status remain strictly separate
 */
export async function sendInvoice(
  workspaceId: string,
  actorId: string,
  invoiceId: string,
  explicitApprovalId?: string
): Promise<ServiceResult<SendInvoiceResult>> {
  // 1. Fetch current invoice with client and line items
  const invoice = await getInvoiceById(invoiceId, workspaceId);
  if (!invoice) {
    return { ok: false, error: "Invoice not found in this workspace", code: "NOT_FOUND" };
  }

  // 2. Check if invoice has already been sent to PayPal (Idempotency check)
  const existingSuccess = await db.externalOperation.findFirst({
    where: {
      invoiceId,
      workspaceId,
      operationType: OperationType.SEND_INVOICE,
      attemptState: OperationAttemptState.SUCCESS,
    },
    orderBy: { completedAt: "desc" },
  });

  if (
    existingSuccess ||
    invoice.paypalStatus === "SENT" ||
    invoice.cashpilotStatus === CashPilotStatus.AWAITING_PAYMENT ||
    invoice.cashpilotStatus === CashPilotStatus.DUE_SOON ||
    invoice.cashpilotStatus === CashPilotStatus.OVERDUE
  ) {
    return {
      ok: true,
      data: {
        operationId: existingSuccess?.id ?? "already-sent",
        invoiceId: invoice.id,
        paypalInvoiceId: invoice.paypalInvoiceId ?? "unknown",
        paypalStatus: invoice.paypalStatus ?? "SENT",
        cashpilotStatus: invoice.cashpilotStatus,
        isAlreadySent: true,
        sentAt: existingSuccess?.completedAt ?? invoice.updatedAt,
        correlationId: existingSuccess?.correlationId ?? undefined,
      },
    };
  }

  // 3. Verify invoice workflow state permits sending (must be DRAFT)
  if (!canSendToPayPal(invoice.cashpilotStatus)) {
    return {
      ok: false,
      error: `Invoice cannot be sent in current status: ${invoice.cashpilotStatus}. Only DRAFT invoices can be sent.`,
      code: "INVALID_INVOICE_STATE",
    };
  }

  // 4. Verify that PayPal draft already exists (Send must NOT create drafts)
  if (!invoice.paypalInvoiceId) {
    return {
      ok: false,
      error: "No PayPal draft exists for this invoice. A draft must be created via /api/invoices/[id]/paypal-draft before sending.",
      code: "PAYPAL_DRAFT_REQUIRED",
    };
  }

  // 5. Check for prior unknown-outcome operations to prevent blind retry
  const unknownOp = await db.externalOperation.findFirst({
    where: {
      invoiceId,
      workspaceId,
      operationType: OperationType.SEND_INVOICE,
      isOutcomeUnknown: true,
    },
  });

  if (unknownOp) {
    return {
      ok: false,
      error: "A previous send operation has an unknown outcome (timed out). Please synchronize status via /api/invoices/[id]/sync before retrying.",
      code: "PENDING_UNKNOWN_OPERATION",
    };
  }

  // 6. Check for concurrent in-flight send operation
  const inFlightOp = await db.externalOperation.findFirst({
    where: {
      invoiceId,
      workspaceId,
      operationType: OperationType.SEND_INVOICE,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: { gt: new Date(Date.now() - 30_000) },
    },
  });

  if (inFlightOp) {
    return {
      ok: false,
      error: "A send operation is currently in flight for this invoice. Please wait.",
      code: "OPERATION_IN_FLIGHT",
    };
  }

  // 7. Locate and validate the approval
  let approval;
  if (explicitApprovalId) {
    approval = await db.approval.findFirst({
      where: { id: explicitApprovalId, workspaceId, invoiceId },
    });

    if (!approval) {
      return {
        ok: false,
        error: "The specified approval does not exist for this invoice and workspace.",
        code: "APPROVAL_NOT_FOUND",
      };
    }

    if (approval.actionType !== ApprovalAction.SEND_INVOICE) {
      return {
        ok: false,
        error: `Approval action is ${approval.actionType}, but SEND_INVOICE is required.`,
        code: "INVALID_APPROVAL_ACTION",
      };
    }

    if (approval.status === ApprovalStatus.INVALIDATED) {
      return {
        ok: false,
        error: "Approval was invalidated because invoice details changed. Please review and approve again.",
        code: "APPROVAL_INVALIDATED",
      };
    }

    if (approval.status === ApprovalStatus.USED) {
      return {
        ok: false,
        error: "Approval has already been consumed by a prior operation.",
        code: "APPROVAL_USED",
      };
    }

    if (
      approval.status === ApprovalStatus.EXPIRED ||
      (approval.expiresAt && approval.expiresAt < new Date())
    ) {
      return {
        ok: false,
        error: "The approval for this invoice has expired. Please review and re-approve.",
        code: "APPROVAL_EXPIRED",
      };
    }

    if (approval.status !== ApprovalStatus.APPROVED) {
      return {
        ok: false,
        error: `Approval is not in APPROVED state (current: ${approval.status}).`,
        code: "APPROVAL_NOT_APPROVED",
      };
    }
  } else {
    approval = await db.approval.findFirst({
      where: {
        invoiceId,
        workspaceId,
        actionType: ApprovalAction.SEND_INVOICE,
        status: ApprovalStatus.APPROVED,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!approval) {
      const anyApproval = await db.approval.findFirst({
        where: { invoiceId, workspaceId, actionType: ApprovalAction.SEND_INVOICE },
        orderBy: { createdAt: "desc" },
      });

      if (
        anyApproval?.status === ApprovalStatus.EXPIRED ||
        (anyApproval?.expiresAt && anyApproval.expiresAt < new Date())
      ) {
        return {
          ok: false,
          error: "The approval for this invoice has expired. Please review and re-approve.",
          code: "APPROVAL_EXPIRED",
        };
      }
      if (anyApproval?.status === ApprovalStatus.INVALIDATED) {
        return {
          ok: false,
          error: "Approval was invalidated because invoice details changed. Please review and approve again.",
          code: "APPROVAL_INVALIDATED",
        };
      }
      if (anyApproval?.status === ApprovalStatus.USED) {
        return {
          ok: false,
          error: "Approval has already been consumed by a prior operation.",
          code: "APPROVAL_USED",
        };
      }

      return {
        ok: false,
        error: "An approved SEND_INVOICE action is required before sending to PayPal.",
        code: "APPROVAL_REQUIRED",
      };
    }

    if (approval.expiresAt && approval.expiresAt < new Date()) {
      return {
        ok: false,
        error: "The approval for this invoice has expired. Please review and re-approve.",
        code: "APPROVAL_EXPIRED",
      };
    }
  }

  // 8. Recompute authoritative material hash on server & check for stale approval
  const currentHash = computeMaterialPayloadHash({
    ...invoice,
    actionType: approval.actionType,
  });

  if (currentHash !== approval.payloadHash) {
    await db.approval.update({
      where: { id: approval.id },
      data: {
        status: ApprovalStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: "Invoice material fields changed after approval",
      },
    });

    await db.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        approvalId: approval.id,
        eventType: ActivityEventType.APPROVAL_INVALIDATED,
        actorType: ActorType.SYSTEM,
        actorId: "system",
        description: "Approval invalidated: invoice content changed after approval",
        metadata: { expectedHash: approval.payloadHash, actualHash: currentHash },
      },
    });

    return {
      ok: false,
      error: "Invoice was modified after approval. Approval invalidated. Please review and re-approve.",
      code: "APPROVAL_STALE",
    };
  }

  // 9. Verify that recipient and amount being sent match the approved payload snapshot
  if (approval.payloadSnapshot && typeof approval.payloadSnapshot === "object") {
    const snapshot = approval.payloadSnapshot as Record<string, unknown>;
    if (snapshot.recipientEmail && snapshot.recipientEmail !== invoice.client.email) {
      return {
        ok: false,
        error: "Recipient email does not match approved payload snapshot.",
        code: "PAYLOAD_SNAPSHOT_MISMATCH",
      };
    }
    if (snapshot.totalMinorUnits !== undefined && snapshot.totalMinorUnits !== invoice.totalMinorUnits) {
      return {
        ok: false,
        error: "Invoice total does not match approved payload snapshot.",
        code: "PAYLOAD_SNAPSHOT_MISMATCH",
      };
    }
    if (snapshot.currency && snapshot.currency !== invoice.currency) {
      return {
        ok: false,
        error: "Invoice currency does not match approved payload snapshot.",
        code: "PAYLOAD_SNAPSHOT_MISMATCH",
      };
    }
  }

  // 10. Persist operation intent before calling PayPal (with idempotency key)
  const idempotencyKey = `send-${invoice.id}-${approval.id}`;
  const operation = await db.externalOperation.create({
    data: {
      workspaceId,
      invoiceId: invoice.id,
      approvalId: approval.id,
      operationType: OperationType.SEND_INVOICE,
      provider: "paypal",
      idempotencyKey,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: new Date(),
      providerInvoiceId: invoice.paypalInvoiceId,
    },
  });

  // 11. Execute the PayPal invoice send call via the adapter
  const sendResult = await sendPayPalInvoice(invoice.paypalInvoiceId, idempotencyKey);

  // 12. Handle provider failure or timeout
  if (!sendResult.success) {
    const isUnknown = "isOutcomeUnknown" in sendResult && sendResult.isOutcomeUnknown;
    await updateOperationAndAudit(
      operation.id,
      workspaceId,
      invoice.id,
      approval.id,
      actorId,
      isUnknown ? OperationAttemptState.UNKNOWN : OperationAttemptState.FAILED,
      isUnknown,
      sendResult.error.code,
      sendResult.error.message,
      sendResult.correlationId
    );

    return {
      ok: false,
      error: sendResult.error.message,
      code: isUnknown ? "OPERATION_UNKNOWN_OUTCOME" : sendResult.error.code,
    };
  }

  // 13. Provider send succeeded: persist state inside transaction with safety guarantees
  const now = new Date();
  const dueDateMapped = mapPayPalStatusToCashPilot("SENT", invoice.dueDate, now);

  try {
    await db.$transaction(async (tx) => {
      // Mark operation as SUCCESS
      await tx.externalOperation.update({
        where: { id: operation.id },
        data: {
          attemptState: OperationAttemptState.SUCCESS,
          completedAt: now,
          correlationId: sendResult.correlationId,
          isOutcomeUnknown: false,
          providerResponse: { sent: true, status: "SENT" },
        },
      });

      // Update invoice status — NEVER transition to PAID on send
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          cashpilotStatus: dueDateMapped.cashpilotStatus,
          paypalStatus: "SENT",
          paypalStatusRaw: { status: "SENT", sentAt: now.toISOString() },
          lastSyncAt: now,
          syncIsStale: false,
        },
      });

      // Consume approval (mark USED)
      await tx.approval.update({
        where: { id: approval.id },
        data: {
          status: ApprovalStatus.USED,
        },
      });

      // Record audit event: OPERATION_SUCCEEDED
      await tx.activityEvent.create({
        data: {
          workspaceId,
          invoiceId: invoice.id,
          approvalId: approval.id,
          operationId: operation.id,
          eventType: ActivityEventType.OPERATION_SUCCEEDED,
          actorType: ActorType.USER,
          actorId,
          description: `Invoice sent via PayPal Sandbox. Provider ID: ${invoice.paypalInvoiceId}. Provider status: SENT (not paid).`,
          metadata: {
            paypalInvoiceId: invoice.paypalInvoiceId,
            previousCashpilotStatus: invoice.cashpilotStatus,
            newCashpilotStatus: dueDateMapped.cashpilotStatus,
            correlationId: sendResult.correlationId,
          },
        },
      });

      // Record audit event: INVOICE_STATUS_CHANGED
      await tx.activityEvent.create({
        data: {
          workspaceId,
          invoiceId: invoice.id,
          eventType: ActivityEventType.INVOICE_STATUS_CHANGED,
          actorType: ActorType.SYSTEM,
          actorId: "system",
          description: `Invoice status changed from DRAFT to ${dueDateMapped.cashpilotStatus}`,
          metadata: { from: "DRAFT", to: dueDateMapped.cashpilotStatus },
        },
      });
    });
  } catch {
    // If local DB fails after provider confirmed send, flag as unknown outcome for reconciliation
    try {
      await db.externalOperation.update({
        where: { id: operation.id },
        data: {
          isOutcomeUnknown: true,
          reconcileResult: "PayPal send succeeded but local database update failed",
          errorCode: "DATABASE_PERSISTENCE_FAILED",
        },
      });
    } catch {
      // Suppress secondary error
    }

    return {
      ok: false,
      error: "PayPal invoice was sent on PayPal, but local database persistence failed. Reconciliation required.",
      code: "DATABASE_PERSISTENCE_FAILED",
    };
  }

  return {
    ok: true,
    data: {
      operationId: operation.id,
      invoiceId: invoice.id,
      paypalInvoiceId: invoice.paypalInvoiceId,
      paypalStatus: "SENT",
      cashpilotStatus: dueDateMapped.cashpilotStatus,
      isAlreadySent: false,
      sentAt: now,
      correlationId: sendResult.correlationId,
    },
  };
}

/**
 * Backward-compatible wrapper for executing an approved invoice send.
 */
export async function executeApprovedSend(
  workspaceId: string,
  actorId: string,
  approvalId: string
): Promise<ServiceResult<{ operationId: string; paypalInvoiceId?: string }>> {
  const approval = await db.approval.findFirst({
    where: { id: approvalId, workspaceId },
  });

  if (!approval || !approval.invoiceId) {
    return { ok: false, error: "Approval not found", code: "NOT_FOUND" };
  }

  const res = await sendInvoice(workspaceId, actorId, approval.invoiceId, approvalId);
  if (!res.ok) {
    return { ok: false, error: res.error, code: res.code };
  }

  return {
    ok: true,
    data: {
      operationId: res.data.operationId,
      paypalInvoiceId: res.data.paypalInvoiceId,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice Payment Reminder
// ─────────────────────────────────────────────────────────────────────────────

export interface SendReminderResult {
  operationId: string;
  invoiceId: string;
  paypalInvoiceId: string;
  recipientEmail: string;
  reminded: boolean;
  remindedAt: Date;
  correlationId?: string;
}

/**
 * Execute an approved invoice payment reminder against PayPal Sandbox.
 *
 * SRS §4 & Financial Integrity Rules:
 *   - Human approval required: MUST have an active SEND_REMINDER approval
 *   - Approval bound to exact current material payload hash (recomputed server-side)
 *   - Stale/modified invoice invalidates approval and rejects reminder (409 Conflict)
 *   - Pre-condition: PayPal invoice must already be sent and in eligible status (AWAITING_PAYMENT, DUE_SOON, OVERDUE)
 *   - Ineligible statuses (DRAFT, PAID, CANCELLED) rejected with 400 Bad Request
 *   - Recipient is strictly provider-linked/persisted client email; no arbitrary overrides
 *   - Rate-limited: Cooldown window (24h) prevents spamming the recipient
 *   - Concurrent in-flight operations blocked (409 Conflict)
 *   - Timeouts / uncertain outcomes recorded as UNKNOWN; blind retries blocked
 *   - DB persistence failure after provider response marks outcome unknown
 *   - Reminder is a notification ONLY: NEVER alters invoice state to PAID or changes workflow status
 *   - Append-only audit trail recorded
 */
export async function sendInvoiceReminder(
  workspaceId: string,
  actorId: string,
  invoiceId: string,
  explicitApprovalId?: string,
  options?: { note?: string; subject?: string }
): Promise<ServiceResult<SendReminderResult>> {
  // 1. Fetch current invoice with client and line items
  const invoice = await getInvoiceById(invoiceId, workspaceId);
  if (!invoice) {
    return { ok: false, error: "Invoice not found in this workspace", code: "NOT_FOUND" };
  }

  // 2. State invariant: Invoice must be in an eligible state for reminders
  if (!canSendReminder(invoice.cashpilotStatus)) {
    if (invoice.cashpilotStatus === CashPilotStatus.DRAFT) {
      return {
        ok: false,
        error: "Draft invoices cannot receive reminders. The invoice must be sent to PayPal first.",
        code: "INVALID_INVOICE_STATE",
      };
    }
    if (invoice.cashpilotStatus === CashPilotStatus.PAID) {
      return {
        ok: false,
        error: "Paid invoices cannot receive reminders.",
        code: "INVALID_INVOICE_STATE",
      };
    }
    if (invoice.cashpilotStatus === CashPilotStatus.CANCELLED) {
      return {
        ok: false,
        error: "Cancelled invoices cannot receive reminders.",
        code: "INVALID_INVOICE_STATE",
      };
    }
    return {
      ok: false,
      error: `Invoices in status ${invoice.cashpilotStatus} cannot receive reminders. Only AWAITING_PAYMENT, DUE_SOON, or OVERDUE invoices are eligible.`,
      code: "INVALID_INVOICE_STATE",
    };
  }

  // 3. Verify that PayPal invoice ID exists
  if (!invoice.paypalInvoiceId) {
    return {
      ok: false,
      error: "No PayPal invoice ID linked to this invoice. A draft must be created and sent before reminders can be issued.",
      code: "PAYPAL_DRAFT_REQUIRED",
    };
  }

  // 4. Check for prior unknown-outcome operations to prevent blind retry
  const unknownOp = await db.externalOperation.findFirst({
    where: {
      invoiceId,
      workspaceId,
      operationType: OperationType.SEND_REMINDER,
      isOutcomeUnknown: true,
    },
  });

  if (unknownOp) {
    return {
      ok: false,
      error: "A previous reminder operation has an unknown outcome (timed out). Please check or reconcile status before retrying.",
      code: "PENDING_UNKNOWN_OPERATION",
    };
  }

  // 5. Check for concurrent in-flight reminder operation
  const inFlightOp = await db.externalOperation.findFirst({
    where: {
      invoiceId,
      workspaceId,
      operationType: OperationType.SEND_REMINDER,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: { gt: new Date(Date.now() - 30_000) },
    },
  });

  if (inFlightOp) {
    return {
      ok: false,
      error: "A reminder operation is currently in flight for this invoice. Please wait.",
      code: "OPERATION_IN_FLIGHT",
    };
  }

  // 6. Rate Limit / Cooldown check (24h cooldown to prevent customer spam)
  const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const recentReminder = await db.externalOperation.findFirst({
    where: {
      invoiceId,
      workspaceId,
      operationType: OperationType.SEND_REMINDER,
      attemptState: OperationAttemptState.SUCCESS,
      completedAt: { gt: new Date(Date.now() - REMINDER_COOLDOWN_MS) },
    },
    orderBy: { completedAt: "desc" },
  });

  if (recentReminder) {
    return {
      ok: false,
      error: `A reminder was already sent for this invoice within the last 24 hours (at ${recentReminder.completedAt?.toISOString()}). Reminders are rate-limited to once per 24 hours to prevent spamming the customer.`,
      code: "REMINDER_RATE_LIMITED",
    };
  }

  // 7. Locate and validate the approval
  let approval;
  if (explicitApprovalId) {
    approval = await db.approval.findFirst({
      where: { id: explicitApprovalId, workspaceId, invoiceId },
    });

    if (!approval) {
      return {
        ok: false,
        error: "The specified approval does not exist for this invoice and workspace.",
        code: "APPROVAL_NOT_FOUND",
      };
    }

    if (approval.actionType !== ApprovalAction.SEND_REMINDER) {
      return {
        ok: false,
        error: `Approval action is ${approval.actionType}, but SEND_REMINDER is required.`,
        code: "INVALID_APPROVAL_ACTION",
      };
    }

    if (approval.status === ApprovalStatus.INVALIDATED) {
      return {
        ok: false,
        error: "Approval was invalidated because invoice details changed. Please review and approve again.",
        code: "APPROVAL_INVALIDATED",
      };
    }

    if (approval.status === ApprovalStatus.USED) {
      return {
        ok: false,
        error: "Approval has already been consumed by a prior operation.",
        code: "APPROVAL_USED",
      };
    }

    if (
      approval.status === ApprovalStatus.EXPIRED ||
      (approval.expiresAt && approval.expiresAt < new Date())
    ) {
      return {
        ok: false,
        error: "The approval for this invoice has expired. Please review and re-approve.",
        code: "APPROVAL_EXPIRED",
      };
    }

    if (approval.status !== ApprovalStatus.APPROVED) {
      return {
        ok: false,
        error: `Approval is not in APPROVED state (current: ${approval.status}).`,
        code: "APPROVAL_NOT_APPROVED",
      };
    }
  } else {
    approval = await db.approval.findFirst({
      where: {
        invoiceId,
        workspaceId,
        actionType: ApprovalAction.SEND_REMINDER,
        status: ApprovalStatus.APPROVED,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!approval) {
      const anyApproval = await db.approval.findFirst({
        where: { invoiceId, workspaceId, actionType: ApprovalAction.SEND_REMINDER },
        orderBy: { createdAt: "desc" },
      });

      if (
        anyApproval?.status === ApprovalStatus.EXPIRED ||
        (anyApproval?.expiresAt && anyApproval.expiresAt < new Date())
      ) {
        return {
          ok: false,
          error: "The approval for this invoice has expired. Please review and re-approve.",
          code: "APPROVAL_EXPIRED",
        };
      }
      if (anyApproval?.status === ApprovalStatus.INVALIDATED) {
        return {
          ok: false,
          error: "Approval was invalidated because invoice details changed. Please review and approve again.",
          code: "APPROVAL_INVALIDATED",
        };
      }
      if (anyApproval?.status === ApprovalStatus.USED) {
        return {
          ok: false,
          error: "Approval has already been consumed by a prior operation.",
          code: "APPROVAL_USED",
        };
      }

      return {
        ok: false,
        error: "An approved SEND_REMINDER action is required before sending a reminder.",
        code: "APPROVAL_REQUIRED",
      };
    }

    if (approval.expiresAt && approval.expiresAt < new Date()) {
      return {
        ok: false,
        error: "The approval for this invoice has expired. Please review and re-approve.",
        code: "APPROVAL_EXPIRED",
      };
    }
  }

  // 8. Recompute authoritative material hash on server & check for stale approval
  const approvedSnapshot = (approval.payloadSnapshot as Record<string, unknown>) || {};
  const approvedNote = typeof approvedSnapshot.note === "string" ? approvedSnapshot.note : undefined;
  const approvedSubject = typeof approvedSnapshot.subject === "string" ? approvedSnapshot.subject : undefined;

  // Verify requested note/subject matches approved reminder payload
  if (options?.note !== undefined && options.note !== approvedNote) {
    return {
      ok: false,
      error: "The reminder note does not match the approved reminder payload.",
      code: "PAYLOAD_MISMATCH",
    };
  }
  if (options?.subject !== undefined && options.subject !== approvedSubject) {
    return {
      ok: false,
      error: "The reminder subject does not match the approved reminder payload.",
      code: "PAYLOAD_MISMATCH",
    };
  }

  const currentHash = computeMaterialPayloadHash({
    ...invoice,
    actionType: approval.actionType,
    note: approvedNote,
    subject: approvedSubject,
  });

  if (currentHash !== approval.payloadHash) {
    await db.approval.update({
      where: { id: approval.id },
      data: {
        status: ApprovalStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: "Invoice material fields changed after approval",
      },
    });

    await db.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        approvalId: approval.id,
        eventType: ActivityEventType.APPROVAL_INVALIDATED,
        actorType: ActorType.SYSTEM,
        actorId: "system",
        description: "Approval invalidated: invoice content changed after approval",
        metadata: { expectedHash: approval.payloadHash, actualHash: currentHash },
      },
    });

    return {
      ok: false,
      error: "Invoice was modified after approval. Approval invalidated. Please review and re-approve.",
      code: "APPROVAL_STALE",
    };
  }

  // 9. Verify that recipient and amount match the approved payload snapshot
  if (approvedSnapshot.recipientEmail && approvedSnapshot.recipientEmail !== invoice.client.email) {
    return {
      ok: false,
      error: "Recipient email does not match approved payload snapshot.",
      code: "PAYLOAD_SNAPSHOT_MISMATCH",
    };
  }
  if (approvedSnapshot.totalMinorUnits !== undefined && approvedSnapshot.totalMinorUnits !== invoice.totalMinorUnits) {
    return {
      ok: false,
      error: "Invoice total does not match approved payload snapshot.",
      code: "PAYLOAD_SNAPSHOT_MISMATCH",
    };
  }
  if (approvedSnapshot.currency && approvedSnapshot.currency !== invoice.currency) {
    return {
      ok: false,
      error: "Invoice currency does not match approved payload snapshot.",
      code: "PAYLOAD_SNAPSHOT_MISMATCH",
    };
  }

  // 10. Persist operation intent before calling PayPal (with idempotency key)
  const idempotencyKey = `remind-${invoice.id}-${approval.id}`;
  const operation = await db.externalOperation.create({
    data: {
      workspaceId,
      invoiceId: invoice.id,
      approvalId: approval.id,
      operationType: OperationType.SEND_REMINDER,
      provider: "paypal",
      idempotencyKey,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: new Date(),
      providerInvoiceId: invoice.paypalInvoiceId,
    },
  });

  // 11. Execute the PayPal invoice reminder call via the adapter
  const reminderResult = await sendPayPalReminder(
    invoice.paypalInvoiceId,
    {
      note: approvedNote,
      subject: approvedSubject,
      requestId: idempotencyKey,
    }
  );

  // 12. Handle provider failure or timeout
  if (!reminderResult.success) {
    const isUnknown = "isOutcomeUnknown" in reminderResult && reminderResult.isOutcomeUnknown;
    await updateOperationAndAudit(
      operation.id,
      workspaceId,
      invoice.id,
      approval.id,
      actorId,
      isUnknown ? OperationAttemptState.UNKNOWN : OperationAttemptState.FAILED,
      isUnknown,
      reminderResult.error.code,
      reminderResult.error.message,
      reminderResult.correlationId
    );

    const isRateLimit =
      reminderResult.error.httpStatus === 429 ||
      reminderResult.error.code?.includes("RATE") ||
      reminderResult.error.code?.includes("LIMIT");

    return {
      ok: false,
      error: reminderResult.error.message,
      code: isUnknown
        ? "OPERATION_UNKNOWN_OUTCOME"
        : isRateLimit
        ? "REMINDER_RATE_LIMITED"
        : reminderResult.error.code,
    };
  }

  // 13. Provider reminder succeeded: record success and consume approval
  const now = new Date();

  try {
    await db.$transaction(async (tx) => {
      // Mark operation as SUCCESS
      await tx.externalOperation.update({
        where: { id: operation.id },
        data: {
          attemptState: OperationAttemptState.SUCCESS,
          completedAt: now,
          correlationId: reminderResult.correlationId,
          isOutcomeUnknown: false,
          providerResponse: { reminded: true },
        },
      });

      // Consume approval (mark USED)
      await tx.approval.update({
        where: { id: approval.id },
        data: {
          status: ApprovalStatus.USED,
        },
      });

      // Update invoice lastSyncAt (Preserve existing workflow status and paypalStatus!)
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          lastSyncAt: now,
          syncIsStale: false,
        },
      });

      // Record audit event: OPERATION_SUCCEEDED
      await tx.activityEvent.create({
        data: {
          workspaceId,
          invoiceId: invoice.id,
          approvalId: approval.id,
          operationId: operation.id,
          eventType: ActivityEventType.OPERATION_SUCCEEDED,
          actorType: ActorType.USER,
          actorId,
          description: `Payment reminder sent to ${invoice.client.email} via PayPal Sandbox. Provider ID: ${invoice.paypalInvoiceId}.`,
          metadata: {
            paypalInvoiceId: invoice.paypalInvoiceId,
            recipientEmail: invoice.client.email,
            note: approvedNote,
            subject: approvedSubject,
            correlationId: reminderResult.correlationId,
          },
        },
      });
    });
  } catch {
    // Local DB update failed after provider accepted reminder: mark outcome unknown
    try {
      await db.externalOperation.update({
        where: { id: operation.id },
        data: {
          isOutcomeUnknown: true,
          reconcileResult: "PayPal reminder sent but local database update failed",
          errorCode: "DATABASE_PERSISTENCE_FAILED",
        },
      });
    } catch {
      // Suppress secondary error
    }

    return {
      ok: false,
      error: "PayPal reminder was sent on PayPal, but local database persistence failed. Reconciliation required.",
      code: "DATABASE_PERSISTENCE_FAILED",
    };
  }

  return {
    ok: true,
    data: {
      operationId: operation.id,
      invoiceId: invoice.id,
      paypalInvoiceId: invoice.paypalInvoiceId,
      recipientEmail: invoice.client.email,
      reminded: true,
      remindedAt: now,
      correlationId: reminderResult.correlationId,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice Cancellation
// ─────────────────────────────────────────────────────────────────────────────

export interface CancelInvoiceResult {
  operationId: string;
  invoiceId: string;
  paypalInvoiceId: string;
  previousStatus: CashPilotStatus;
  currentStatus: CashPilotStatus;
  previousPaypalStatus: string | null;
  currentPaypalStatus: string;
  cancelledAt: Date;
  correlationId?: string;
}

/**
 * Execute an approved invoice cancellation against PayPal Sandbox.
 *
 * SRS §4 & Financial Integrity Rules:
 *   - Human approval required: MUST have an active, unexpired CANCEL_INVOICE approval
 *   - Approval bound to exact current material payload hash (recomputed server-side)
 *   - Stale/modified invoice invalidates approval and rejects cancellation (409 Conflict)
 *   - Pre-condition: PayPal invoice must already be sent and in cancellable status (AWAITING_PAYMENT, DUE_SOON, OVERDUE)
 *   - Ineligible statuses (DRAFT, PAID, PARTIALLY_PAID, CANCELLED, NEEDS_REVIEW) rejected with 400 Bad Request
 *   - Missing PayPal invoice ID rejected (400 Bad Request)
 *   - Stale/ambiguous provider state blocks cancellation until reconciled (409 Conflict)
 *   - Concurrent in-flight operations blocked (409 Conflict)
 *   - Timeouts / uncertain outcomes recorded as UNKNOWN; blind retries blocked (504 Gateway Timeout)
 *   - Upon provider success (204 No Content), invoice status transitions to CANCELLED atomically
 */
export async function cancelInvoice(
  workspaceId: string,
  actorId: string,
  invoiceId: string,
  explicitApprovalId?: string,
  options?: { note?: string; subject?: string; sendToRecipient?: boolean; sendToInvoicer?: boolean }
): Promise<ServiceResult<CancelInvoiceResult>> {
  // 1. Fetch current invoice with client and line items
  const invoice = await getInvoiceById(invoiceId, workspaceId);
  if (!invoice) {
    return { ok: false, error: "Invoice not found in this workspace", code: "NOT_FOUND" };
  }

  // 2. State invariant: Draft invoices cannot be cancelled via the sent invoice cancellation endpoint
  if (invoice.cashpilotStatus === CashPilotStatus.DRAFT || invoice.paypalStatus === "DRAFT") {
    return {
      ok: false,
      error: "Draft invoices cannot be cancelled via the sent invoice cancellation endpoint.",
      code: "INVALID_INVOICE_STATE",
    };
  }

  // 3. Pre-condition: PayPal invoice ID must exist
  if (!invoice.paypalInvoiceId) {
    return {
      ok: false,
      error: "No PayPal invoice ID linked to this invoice. A draft must be created and sent before it can be cancelled via PayPal.",
      code: "PAYPAL_INVOICE_REQUIRED",
    };
  }

  if (
    invoice.cashpilotStatus === CashPilotStatus.PAID ||
    invoice.paypalStatus === "PAID" ||
    invoice.paypalStatus === "MARKED_AS_PAID"
  ) {
    return {
      ok: false,
      error: "Paid invoices cannot be cancelled.",
      code: "INVALID_INVOICE_STATE",
    };
  }

  if (invoice.paypalStatus === "PARTIALLY_PAID") {
    return {
      ok: false,
      error: "Partially paid invoices cannot be cancelled through this workflow.",
      code: "INVALID_INVOICE_STATE",
    };
  }

  if (
    invoice.cashpilotStatus === CashPilotStatus.CANCELLED ||
    invoice.paypalStatus === "CANCELLED" ||
    invoice.paypalStatus === "VOIDED"
  ) {
    return {
      ok: false,
      error: "This invoice is already cancelled.",
      code: "INVALID_INVOICE_STATE",
    };
  }

  if (invoice.cashpilotStatus === CashPilotStatus.NEEDS_REVIEW || invoice.syncIsStale) {
    return {
      ok: false,
      error: "Invoice provider state is ambiguous or stale. Reconcile provider status before cancelling.",
      code: "PROVIDER_STATE_AMBIGUOUS",
    };
  }

  if (!canCancelInvoice(invoice.cashpilotStatus, invoice.paypalStatus)) {
    return {
      ok: false,
      error: `Invoices in status ${invoice.cashpilotStatus} (provider status: ${invoice.paypalStatus}) cannot be cancelled.`,
      code: "INVALID_INVOICE_STATE",
    };
  }

  // 4. Check for prior unknown-outcome operations to prevent blind retry
  const unknownOp = await db.externalOperation.findFirst({
    where: {
      invoiceId,
      workspaceId,
      operationType: OperationType.CANCEL_INVOICE,
      isOutcomeUnknown: true,
    },
  });

  if (unknownOp) {
    return {
      ok: false,
      error: "A previous cancellation operation has an unknown outcome (timed out). Please check or reconcile status before retrying.",
      code: "PENDING_UNKNOWN_OPERATION",
    };
  }

  // 5. Check for concurrent in-flight cancellation operation
  const inFlightOp = await db.externalOperation.findFirst({
    where: {
      invoiceId,
      workspaceId,
      operationType: OperationType.CANCEL_INVOICE,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: { gt: new Date(Date.now() - 30_000) },
    },
  });

  if (inFlightOp) {
    return {
      ok: false,
      error: "A cancellation operation is currently in flight for this invoice. Please wait.",
      code: "OPERATION_IN_FLIGHT",
    };
  }

  // 6. Locate and validate the approval
  let approval;
  if (explicitApprovalId) {
    approval = await db.approval.findFirst({
      where: { id: explicitApprovalId, workspaceId, invoiceId },
    });

    if (!approval) {
      return {
        ok: false,
        error: "The specified approval does not exist for this invoice and workspace.",
        code: "APPROVAL_NOT_FOUND",
      };
    }

    if (approval.actionType !== ApprovalAction.CANCEL_INVOICE) {
      return {
        ok: false,
        error: `Approval action is ${approval.actionType}, but CANCEL_INVOICE is required.`,
        code: "INVALID_APPROVAL_ACTION",
      };
    }

    if (approval.status === ApprovalStatus.INVALIDATED) {
      return {
        ok: false,
        error: "Approval was invalidated because invoice details changed. Please review and approve again.",
        code: "APPROVAL_INVALIDATED",
      };
    }

    if (approval.status === ApprovalStatus.USED) {
      return {
        ok: false,
        error: "Approval has already been consumed by a prior operation.",
        code: "APPROVAL_USED",
      };
    }

    if (
      approval.status === ApprovalStatus.EXPIRED ||
      (approval.expiresAt && approval.expiresAt < new Date())
    ) {
      return {
        ok: false,
        error: "The approval for this invoice has expired. Please review and re-approve.",
        code: "APPROVAL_EXPIRED",
      };
    }

    if (approval.status !== ApprovalStatus.APPROVED) {
      return {
        ok: false,
        error: `Approval is not in APPROVED state (current: ${approval.status}).`,
        code: "APPROVAL_NOT_APPROVED",
      };
    }
  } else {
    approval = await db.approval.findFirst({
      where: {
        invoiceId,
        workspaceId,
        actionType: ApprovalAction.CANCEL_INVOICE,
        status: ApprovalStatus.APPROVED,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!approval) {
      const anyApproval = await db.approval.findFirst({
        where: { invoiceId, workspaceId, actionType: ApprovalAction.CANCEL_INVOICE },
        orderBy: { createdAt: "desc" },
      });

      if (
        anyApproval?.status === ApprovalStatus.EXPIRED ||
        (anyApproval?.expiresAt && anyApproval.expiresAt < new Date())
      ) {
        return {
          ok: false,
          error: "The approval for this invoice has expired. Please review and re-approve.",
          code: "APPROVAL_EXPIRED",
        };
      }
      if (anyApproval?.status === ApprovalStatus.INVALIDATED) {
        return {
          ok: false,
          error: "Approval was invalidated because invoice details changed. Please review and approve again.",
          code: "APPROVAL_INVALIDATED",
        };
      }
      if (anyApproval?.status === ApprovalStatus.USED) {
        return {
          ok: false,
          error: "Approval has already been consumed by a prior operation.",
          code: "APPROVAL_USED",
        };
      }

      return {
        ok: false,
        error: "An approved CANCEL_INVOICE action is required before cancelling the invoice.",
        code: "APPROVAL_REQUIRED",
      };
    }

    if (approval.expiresAt && approval.expiresAt < new Date()) {
      return {
        ok: false,
        error: "The approval for this invoice has expired. Please review and re-approve.",
        code: "APPROVAL_EXPIRED",
      };
    }
  }

  // 7. Recompute authoritative material hash on server & check for stale approval
  const approvedSnapshot = (approval.payloadSnapshot as Record<string, unknown>) || {};
  const approvedNote = typeof approvedSnapshot.note === "string" ? approvedSnapshot.note : undefined;
  const approvedSubject = typeof approvedSnapshot.subject === "string" ? approvedSnapshot.subject : undefined;

  // Verify requested note/subject matches approved cancellation payload
  if (options?.note !== undefined && options.note !== approvedNote) {
    return {
      ok: false,
      error: "The cancellation note does not match the approved cancellation payload.",
      code: "PAYLOAD_MISMATCH",
    };
  }
  if (options?.subject !== undefined && options.subject !== approvedSubject) {
    return {
      ok: false,
      error: "The cancellation subject does not match the approved cancellation payload.",
      code: "PAYLOAD_MISMATCH",
    };
  }

  const currentHash = computeMaterialPayloadHash({
    ...invoice,
    actionType: approval.actionType,
    note: approvedNote,
    subject: approvedSubject,
  });

  if (currentHash !== approval.payloadHash) {
    await db.approval.update({
      where: { id: approval.id },
      data: {
        status: ApprovalStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: "Invoice material fields changed after approval",
      },
    });

    await db.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        approvalId: approval.id,
        eventType: ActivityEventType.APPROVAL_INVALIDATED,
        actorType: ActorType.SYSTEM,
        actorId: "system",
        description: "Approval invalidated: invoice content changed after approval",
        metadata: { expectedHash: approval.payloadHash, actualHash: currentHash },
      },
    });

    return {
      ok: false,
      error: "Invoice was modified after approval. Approval invalidated. Please review and re-approve.",
      code: "APPROVAL_STALE",
    };
  }

  // 8. Verify recipient and amount match approved payload snapshot
  if (approvedSnapshot.recipientEmail && approvedSnapshot.recipientEmail !== invoice.client.email) {
    return {
      ok: false,
      error: "Recipient email does not match approved payload snapshot.",
      code: "PAYLOAD_SNAPSHOT_MISMATCH",
    };
  }
  if (approvedSnapshot.totalMinorUnits !== undefined && approvedSnapshot.totalMinorUnits !== invoice.totalMinorUnits) {
    return {
      ok: false,
      error: "Invoice total does not match approved payload snapshot.",
      code: "PAYLOAD_SNAPSHOT_MISMATCH",
    };
  }
  if (approvedSnapshot.currency && approvedSnapshot.currency !== invoice.currency) {
    return {
      ok: false,
      error: "Invoice currency does not match approved payload snapshot.",
      code: "PAYLOAD_SNAPSHOT_MISMATCH",
    };
  }

  // 9. Persist operation intent before calling PayPal
  const idempotencyKey = `cancel-${invoice.id}-${approval.id}`;
  const operation = await db.externalOperation.create({
    data: {
      workspaceId,
      invoiceId: invoice.id,
      approvalId: approval.id,
      operationType: OperationType.CANCEL_INVOICE,
      provider: "paypal",
      idempotencyKey,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: new Date(),
      providerInvoiceId: invoice.paypalInvoiceId,
    },
  });

  // 10. Execute the PayPal invoice cancellation call via the adapter
  const cancelResult = await cancelPayPalInvoice(
    invoice.paypalInvoiceId,
    {
      note: approvedNote,
      subject: approvedSubject,
      sendToRecipient: options?.sendToRecipient ?? true,
      sendToInvoicer: options?.sendToInvoicer ?? false,
      requestId: idempotencyKey,
    }
  );

  // 11. Handle provider failure or timeout
  if (!cancelResult.success) {
    const isUnknown = "isOutcomeUnknown" in cancelResult && cancelResult.isOutcomeUnknown;
    await updateOperationAndAudit(
      operation.id,
      workspaceId,
      invoice.id,
      approval.id,
      actorId,
      isUnknown ? OperationAttemptState.UNKNOWN : OperationAttemptState.FAILED,
      isUnknown,
      cancelResult.error.code,
      cancelResult.error.message,
      cancelResult.correlationId
    );

    return {
      ok: false,
      error: cancelResult.error.message,
      code: isUnknown ? "OPERATION_UNKNOWN_OUTCOME" : cancelResult.error.code,
    };
  }

  // 12. Provider cancellation confirmed: record success, consume approval, transition invoice to CANCELLED
  const now = new Date();
  const previousStatus = invoice.cashpilotStatus;
  const previousPaypalStatus = invoice.paypalStatus;

  try {
    await db.$transaction(async (tx) => {
      // Mark operation as SUCCESS
      await tx.externalOperation.update({
        where: { id: operation.id },
        data: {
          attemptState: OperationAttemptState.SUCCESS,
          completedAt: now,
          correlationId: cancelResult.correlationId,
          isOutcomeUnknown: false,
          providerResponse: { cancelled: true },
        },
      });

      // Consume approval (mark USED)
      await tx.approval.update({
        where: { id: approval.id },
        data: {
          status: ApprovalStatus.USED,
        },
      });

      // Update invoice status to CANCELLED (both cashpilotStatus and paypalStatus)
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          cashpilotStatus: CashPilotStatus.CANCELLED,
          paypalStatus: "CANCELLED",
          lastSyncAt: now,
          syncIsStale: false,
        },
      });

      // Record audit event: OPERATION_SUCCEEDED
      await tx.activityEvent.create({
        data: {
          workspaceId,
          invoiceId: invoice.id,
          approvalId: approval.id,
          operationId: operation.id,
          eventType: ActivityEventType.OPERATION_SUCCEEDED,
          actorType: ActorType.USER,
          actorId,
          description: `Invoice ${invoice.paypalInvoiceId} cancelled via PayPal Sandbox. Status changed from ${previousStatus} to CANCELLED.`,
          metadata: {
            paypalInvoiceId: invoice.paypalInvoiceId,
            previousCashpilotStatus: previousStatus,
            currentCashpilotStatus: CashPilotStatus.CANCELLED,
            previousPaypalStatus,
            currentPaypalStatus: "CANCELLED",
            note: approvedNote,
            subject: approvedSubject,
            correlationId: cancelResult.correlationId,
          },
        },
      });
    });
  } catch {
    // Local DB update failed after provider accepted cancellation: mark outcome unknown
    try {
      await db.externalOperation.update({
        where: { id: operation.id },
        data: {
          isOutcomeUnknown: true,
          reconcileResult: "PayPal invoice cancelled but local database update failed",
          errorCode: "DATABASE_PERSISTENCE_FAILED",
        },
      });
    } catch {
      // Suppress secondary error
    }

    return {
      ok: false,
      error: "PayPal invoice was cancelled on PayPal, but local database persistence failed. Reconciliation required.",
      code: "DATABASE_PERSISTENCE_FAILED",
    };
  }

  return {
    ok: true,
    data: {
      operationId: operation.id,
      invoiceId: invoice.id,
      paypalInvoiceId: invoice.paypalInvoiceId,
      previousStatus,
      currentStatus: CashPilotStatus.CANCELLED,
      previousPaypalStatus,
      currentPaypalStatus: "CANCELLED",
      cancelledAt: now,
      correlationId: cancelResult.correlationId,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Refresh / Reconciliation
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncInvoiceResult {
  invoiceId: string;
  paypalInvoiceId: string | null;
  hasPaypalInvoice: boolean;
  previousPaypalStatus: string | null;
  currentPaypalStatus: string | null;
  previousCashpilotStatus: CashPilotStatus;
  currentCashpilotStatus: CashPilotStatus;
  statusChanged: boolean;
  isStale: boolean;
  reconciledOperationsCount: number;
  lastSyncAt: Date | null;
  correlationId?: string;
}

/**
 * Synchronize invoice status with PayPal Sandbox.
 *
 * SRS §4 & Financial Integrity Rules:
 *   - Fetches authoritative provider status from official GET /v2/invoicing/invoices/{id}
 *   - Only verified provider evidence can establish PAID status (via mapPayPalStatusToCashPilot)
 *   - Unknown / unmapped / malformed status maps to NEEDS_REVIEW (never PAID)
 *   - Failed status fetch preserves last known valid status and marks syncIsStale = true
 *   - Optimistic concurrency protection: older responses cannot overwrite newer sync results
 *   - Reconciles UNKNOWN-outcome operations when provider evidence establishes resolution
 *   - Discrepancy on 404 (provider invoice not found) recorded without blind recreation
 *   - Read-only provider call: zero resource mutations, zero sends, zero payments
 */
export async function syncInvoiceWithPayPal(
  workspaceId: string,
  actorId: string,
  invoiceId: string
): Promise<ServiceResult<SyncInvoiceResult>> {
  // 1. Fetch current invoice with client and line items
  const invoice = await getInvoiceById(invoiceId, workspaceId);
  if (!invoice) {
    return { ok: false, error: "Invoice not found in this workspace", code: "NOT_FOUND" };
  }

  // 2. If no PayPal invoice is linked, return structured response without guessing provider state
  if (!invoice.paypalInvoiceId) {
    return {
      ok: true,
      data: {
        invoiceId,
        paypalInvoiceId: null,
        hasPaypalInvoice: false,
        previousPaypalStatus: null,
        currentPaypalStatus: null,
        previousCashpilotStatus: invoice.cashpilotStatus,
        currentCashpilotStatus: invoice.cashpilotStatus,
        statusChanged: false,
        isStale: false,
        reconciledOperationsCount: 0,
        lastSyncAt: invoice.lastSyncAt,
      },
    };
  }

  const previousLastSyncAt = invoice.lastSyncAt;
  const previousPaypalStatus = invoice.paypalStatus;
  const previousCashpilotStatus = invoice.cashpilotStatus;

  // 3. Create ExternalOperation record for this sync operation
  const syncOp = await db.externalOperation.create({
    data: {
      workspaceId,
      invoiceId,
      operationType: OperationType.GET_INVOICE,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: new Date(),
    },
  });

  // 4. Fetch status from official PayPal Invoicing API
  const statusResult = await getPayPalInvoiceStatus(invoice.paypalInvoiceId);

  // 5. Handle provider fetch failure
  if (!statusResult.success) {
    const isUnknown = "isOutcomeUnknown" in statusResult && statusResult.isOutcomeUnknown;
    const isNotFound = statusResult.error.httpStatus === 404;

    await db.$transaction(async (tx) => {
      // Preserve last known valid status — mark stale
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { syncIsStale: true },
      });

      await tx.externalOperation.update({
        where: { id: syncOp.id },
        data: {
          attemptState: isUnknown ? OperationAttemptState.UNKNOWN : OperationAttemptState.FAILED,
          completedAt: new Date(),
          isOutcomeUnknown: isUnknown,
          errorCode: isNotFound ? "PROVIDER_INVOICE_NOT_FOUND" : statusResult.error.code,
          errorMessage: statusResult.error.message,
          correlationId: statusResult.correlationId,
        },
      });

      await tx.activityEvent.create({
        data: {
          workspaceId,
          invoiceId,
          operationId: syncOp.id,
          eventType: ActivityEventType.STATUS_SYNC_FAILED,
          actorType: ActorType.USER,
          actorId,
          description: isNotFound
            ? `Status sync failed: PayPal invoice ${invoice.paypalInvoiceId} was not found on PayPal Sandbox.`
            : `PayPal status sync failed: ${statusResult.error.message}. Last known status preserved.`,
          metadata: {
            errorCode: isNotFound ? "PROVIDER_INVOICE_NOT_FOUND" : statusResult.error.code,
            paypalInvoiceId: invoice.paypalInvoiceId,
            correlationId: statusResult.correlationId,
          },
        },
      });
    });

    if (isNotFound) {
      return {
        ok: false,
        error: `PayPal invoice ${invoice.paypalInvoiceId} was not found on PayPal Sandbox. Discrepancy recorded.`,
        code: "PROVIDER_INVOICE_NOT_FOUND",
      };
    }

    return {
      ok: false,
      error: statusResult.error.message,
      code: isUnknown ? "TIMEOUT" : statusResult.error.code,
    };
  }

  // 6. Validate provider response structure
  const rawStatus = statusResult.data.status;
  if (!rawStatus || typeof rawStatus !== "string" || rawStatus.trim().length === 0) {
    return {
      ok: false,
      error: "PayPal returned an invalid or empty status value in the response.",
      code: "MALFORMED_PROVIDER_RESPONSE",
    };
  }

  // 7. Map provider status to CashPilot status using existing tested engine
  const mapped = mapPayPalStatusToCashPilot(rawStatus, invoice.dueDate);
  const newCashpilotStatus = mapped.cashpilotStatus;
  const statusChanged =
    previousPaypalStatus !== rawStatus || previousCashpilotStatus !== newCashpilotStatus;

  // 8. Find any unknown-outcome operations on this invoice to reconcile
  const unknownOps = await db.externalOperation.findMany({
    where: {
      invoiceId,
      workspaceId,
      isOutcomeUnknown: true,
    },
  });

  const now = new Date();

  // 9. Persist verified status inside a database transaction with optimistic concurrency
  let overwrittenByNewer = false;

  await db.$transaction(async (tx) => {
    // Stale response protection: Ensure no newer sync finished while this fetch was in flight
    if (previousLastSyncAt) {
      const latest = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { lastSyncAt: true },
      });
      if (latest?.lastSyncAt && latest.lastSyncAt > now) {
        overwrittenByNewer = true;
        return;
      }
    }

    // Persist verified provider state
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paypalStatus: rawStatus,
        paypalStatusRaw: statusResult.data as unknown as Prisma.InputJsonValue,
        cashpilotStatus: newCashpilotStatus,
        lastSyncAt: now,
        syncIsStale: false,
      },
    });

    // Update sync operation record
    await tx.externalOperation.update({
      where: { id: syncOp.id },
      data: {
        attemptState: OperationAttemptState.SUCCESS,
        completedAt: now,
        providerInvoiceId: invoice.paypalInvoiceId,
        correlationId: statusResult.correlationId,
        providerResponse: {
          id: statusResult.data.id,
          status: rawStatus,
        },
      },
    });

    // Reconcile unknown operations if safe provider evidence establishes the outcome
    if (unknownOps.length > 0) {
      for (const op of unknownOps) {
        let reconcileResultMsg = `Reconciled via PayPal status sync: invoice confirmed in status ${rawStatus}`;
        let resolvedState: OperationAttemptState = OperationAttemptState.SUCCESS;

        if (op.operationType === OperationType.CREATE_DRAFT) {
          resolvedState = OperationAttemptState.SUCCESS;
          reconcileResultMsg = `Reconciled: PayPal confirmed draft creation exists in status ${rawStatus}`;
        } else if (op.operationType === OperationType.SEND_INVOICE) {
          if (["SENT", "PAID", "PARTIALLY_PAID", "PAYMENT_PENDING", "MARKED_AS_PAID"].includes(rawStatus.toUpperCase())) {
            resolvedState = OperationAttemptState.SUCCESS;
            reconcileResultMsg = `Reconciled: PayPal confirmed invoice send succeeded (status: ${rawStatus})`;
          } else if (rawStatus.toUpperCase() === "DRAFT") {
            resolvedState = OperationAttemptState.FAILED;
            reconcileResultMsg = "Reconciled: Invoice remains in DRAFT; send was not processed by PayPal";
          }
        } else if (op.operationType === OperationType.CANCEL_INVOICE) {
          if (["CANCELLED", "VOIDED"].includes(rawStatus.toUpperCase())) {
            resolvedState = OperationAttemptState.SUCCESS;
            reconcileResultMsg = `Reconciled: PayPal confirmed invoice cancellation succeeded (status: ${rawStatus})`;
          } else {
            resolvedState = OperationAttemptState.FAILED;
            reconcileResultMsg = `Reconciled: Invoice was not cancelled on PayPal; remains in active status (${rawStatus})`;
          }
        }

        await tx.externalOperation.update({
          where: { id: op.id },
          data: {
            attemptState: resolvedState,
            isOutcomeUnknown: false,
            reconciledAt: now,
            reconcileResult: reconcileResultMsg,
            correlationId: statusResult.correlationId,
          },
        });
      }
    }

    // Record activity audit event
    const eventType =
      unknownOps.length > 0
        ? ActivityEventType.STATUS_SYNC_RECONCILED
        : ActivityEventType.STATUS_SYNC_SUCCESS;

    const description =
      unknownOps.length > 0
        ? `Status sync reconciled ${unknownOps.length} uncertain operation(s). PayPal: ${rawStatus} → CashPilot: ${newCashpilotStatus}`
        : `Status synchronized with PayPal Sandbox. Provider status: ${rawStatus} → CashPilot: ${newCashpilotStatus}`;

    await tx.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        operationId: syncOp.id,
        eventType,
        actorType: ActorType.USER,
        actorId,
        description,
        metadata: {
          paypalInvoiceId: invoice.paypalInvoiceId,
          providerStatus: rawStatus,
          cashpilotStatus: newCashpilotStatus,
          previousPaypalStatus,
          previousCashpilotStatus,
          statusChanged,
          reconciledOperationsCount: unknownOps.length,
          correlationId: statusResult.correlationId,
        },
      },
    });
  });

  return {
    ok: true,
    data: {
      invoiceId,
      paypalInvoiceId: invoice.paypalInvoiceId,
      hasPaypalInvoice: true,
      previousPaypalStatus,
      currentPaypalStatus: rawStatus,
      previousCashpilotStatus,
      currentCashpilotStatus: newCashpilotStatus,
      statusChanged: overwrittenByNewer ? false : statusChanged,
      isStale: false,
      reconciledOperationsCount: unknownOps.length,
      lastSyncAt: now,
      correlationId: statusResult.correlationId,
    },
  };
}

/**
 * Backward-compatible wrapper for status refresh.
 */
export async function refreshInvoiceStatus(
  workspaceId: string,
  invoiceId: string,
  actorId: string = "system"
): Promise<ServiceResult<{ cashpilotStatus: CashPilotStatus; isStale: boolean }>> {
  const result = await syncInvoiceWithPayPal(workspaceId, actorId, invoiceId);
  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code };
  }
  return {
    ok: true,
    data: {
      cashpilotStatus: result.data.currentCashpilotStatus,
      isStale: result.data.isStale,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build PayPal API invoice payload from CashPilot invoice record */
export function buildPayPalInvoicePayload(
  invoice: NonNullable<Awaited<ReturnType<typeof getInvoiceById>>>
): PayPalInvoicePayload {
  const taxPercent =
    invoice.taxRateBasisPoints > 0
      ? (invoice.taxRateBasisPoints / 100).toString()
      : undefined;

  const items: PayPalInvoicePayload["items"] = invoice.lineItems.map((li) => {
    const item: PayPalInvoicePayload["items"][number] = {
      name: li.description,
      quantity: String(li.quantity),
      unit_amount: {
        currency_code: invoice.currency,
        value: minorUnitsToDecimalString(li.unitPriceMinorUnits),
      },
    };

    if (taxPercent) {
      item.tax = {
        name: "Sales Tax",
        percent: taxPercent,
      };
    }

    return item;
  });

  return {
    detail: {
      invoice_number: invoice.number ?? undefined,
      invoice_date: invoice.invoiceDate.toISOString().substring(0, 10),
      currency_code: invoice.currency,
      note: invoice.notes ?? undefined,
      term: invoice.terms ?? undefined,
      payment_term: {
        term_type: "DUE_ON_DATE_SPECIFIED",
        due_date: invoice.dueDate.toISOString().substring(0, 10),
      },
    },
    primary_recipients: [
      {
        billing_info: {
          email_address: invoice.client.email,
          name: invoice.client.name
            ? {
                given_name: invoice.client.name.split(" ")[0] ?? "",
                surname: invoice.client.name.split(" ").slice(1).join(" ") || undefined,
              }
            : undefined,
        },
      },
    ],
    items,
  };
}

/** Update operation state and record audit event */
async function updateOperationAndAudit(
  operationId: string,
  workspaceId: string,
  invoiceId: string,
  approvalId: string,
  actorId: string,
  state: OperationAttemptState,
  isOutcomeUnknown: boolean,
  errorCode?: string,
  errorMessage?: string,
  correlationId?: string
) {
  await db.$transaction(async (tx) => {
    await tx.externalOperation.update({
      where: { id: operationId },
      data: {
        attemptState: state,
        completedAt: isOutcomeUnknown ? undefined : new Date(),
        isOutcomeUnknown,
        errorCode,
        errorMessage: errorMessage?.substring(0, 500), // sanitize length
        correlationId,
      },
    });

    await tx.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        approvalId,
        operationId,
        eventType: isOutcomeUnknown
          ? ActivityEventType.OPERATION_TIMED_OUT
          : ActivityEventType.OPERATION_FAILED,
        actorType: ActorType.SYSTEM,
        actorId: "system",
        description: isOutcomeUnknown
          ? "PayPal operation timed out. Outcome is unknown — reconcile before retrying."
          : `PayPal operation failed: ${errorCode ?? "UNKNOWN_ERROR"}`,
        metadata: { errorCode, isOutcomeUnknown, correlationId },
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Batch Reconciliation (SRS §4, §5 & UI Design Reference Page 14)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconciliationItemResult {
  invoiceId: string;
  number: string | null;
  clientName: string;
  totalMinorUnits: number;
  currency: string;
  paypalInvoiceId: string | null;
  hasPaypalInvoice: boolean;
  previousPaypalStatus: string | null;
  currentPaypalStatus: string | null;
  previousCashpilotStatus: CashPilotStatus;
  currentCashpilotStatus: CashPilotStatus;
  statusChanged: boolean;
  isStale: boolean;
  reconciledOperationsCount: number;
  message: string;
}

export interface BatchSyncStageSummary {
  draft: number;
  awaitingPayment: number;
  dueSoon: number;
  overdue: number;
  paid: number;
  needsReview: number;
  cancelled: number;
}

export interface BatchSyncSummary {
  workspaceId: string;
  syncedAt: string;
  totalInvoicesScanned: number;
  totalPaypalInvoicesQueried: number;
  changedCount: number;
  staleCount: number;
  reconciledCount: number;
  beforeStages: BatchSyncStageSummary;
  afterStages: BatchSyncStageSummary;
  beforeOutstandingMinorUnits: number;
  afterOutstandingMinorUnits: number;
  currency: string;
  items: ReconciliationItemResult[];
}

function toInvoiceRecord(inv: {
  id: string;
  number: string | null;
  title: string | null;
  client: { id?: string; name: string; email: string; company?: string | null };
  currency: string;
  totalMinorUnits: number;
  subtotalMinorUnits?: number | null;
  taxMinorUnits?: number | null;
  invoiceDate: Date;
  dueDate: Date;
  cashpilotStatus: CashPilotStatus;
  paypalStatus: string | null;
  paypalInvoiceId: string | null;
  isDemoData: boolean;
  syncIsStale: boolean;
  aiDraftId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  lastSyncAt?: Date | null;
  notes?: string | null;
  lineItems?: Array<{
    id?: string;
    description: string;
    quantity: number;
    unitPriceMinorUnits: number;
    totalMinorUnits: number;
  }>;
}): InvoiceRecord {
  return {
    id: inv.id,
    number: inv.number,
    title: inv.title,
    client: inv.client,
    currency: inv.currency,
    totalMinorUnits: inv.totalMinorUnits,
    subtotalMinorUnits: inv.subtotalMinorUnits ?? undefined,
    taxMinorUnits: inv.taxMinorUnits ?? undefined,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    cashpilotStatus: inv.cashpilotStatus,
    paypalStatus: inv.paypalStatus,
    paypalInvoiceId: inv.paypalInvoiceId,
    isDemoData: inv.isDemoData,
    syncIsStale: inv.syncIsStale,
    aiDraftId: inv.aiDraftId,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    lastSyncAt: inv.lastSyncAt,
    notes: inv.notes,
    lineItems: inv.lineItems,
  };
}

function extractStageSummary(records: InvoiceRecord[], now: Date): { stages: BatchSyncStageSummary; outstandingMinorUnits: number } {
  const collections = groupInvoicesForCollections(records, now);
  const metrics = calculateDashboardMetrics(records, now);
  return {
    stages: {
      draft: collections.columns.draft.length,
      awaitingPayment: collections.columns.awaitingPayment.length,
      dueSoon: collections.columns.dueSoon.length,
      overdue: collections.columns.overdue.length,
      paid: collections.columns.paid.length,
      needsReview: collections.tray.needsReview.length,
      cancelled: collections.tray.cancelled.length,
    },
    outstandingMinorUnits: metrics.outstanding.amountMinorUnits,
  };
}

/**
 * Reconciles all active invoices for a workspace with PayPal Sandbox.
 *
 * Invariants (SRS §4, §5 & UI Design Reference Page 14):
 *   1. Ask PayPal: Queries status for every invoice linked to PayPal.
 *   2. Check the answer: Evaluates returned status against known invoice rules.
 *   3. Match to a stage: Maps provider status + due date to CashPilot lifecycle stages.
 *   4. Save and log: Persists state atomically and records append-only audit trail.
 *   5. Update the board: Produces before-and-after column summaries and delta metrics.
 *   - Stale preservation: If PayPal is unreachable for an invoice, preserves last known state.
 *   - Financial integrity: Only verified provider proof can set PAID; never assumes Paid on error.
 */
export async function batchSyncWorkspaceInvoicesWithPayPal(
  workspaceId: string,
  actorId: string
): Promise<ServiceResult<BatchSyncSummary>> {
  // 1. Verify workspace exists
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, ownerId: true },
  });

  if (!workspace) {
    return { ok: false, error: "Workspace not found", code: "NOT_FOUND" };
  }

  // 2. Fetch all current invoices for the workspace
  const initialRawInvoices = await db.invoice.findMany({
    where: { workspaceId },
    include: {
      client: {
        select: { id: true, name: true, email: true, company: true },
      },
      lineItems: {
        select: {
          id: true,
          description: true,
          quantity: true,
          unitPriceMinorUnits: true,
          totalMinorUnits: true,
        },
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();
  const defaultCurrency = initialRawInvoices[0]?.currency ?? "USD";

  // 3. Compute baseline before-metrics
  const initialRecords = initialRawInvoices.map(toInvoiceRecord);
  const beforeSummary = extractStageSummary(initialRecords, now);

  if (initialRawInvoices.length === 0) {
    return {
      ok: true,
      data: {
        workspaceId,
        syncedAt: now.toISOString(),
        totalInvoicesScanned: 0,
        totalPaypalInvoicesQueried: 0,
        changedCount: 0,
        staleCount: 0,
        reconciledCount: 0,
        beforeStages: beforeSummary.stages,
        afterStages: beforeSummary.stages,
        beforeOutstandingMinorUnits: 0,
        afterOutstandingMinorUnits: 0,
        currency: defaultCurrency,
        items: [],
      },
    };
  }

  // 4. Reconcile each invoice
  const items: ReconciliationItemResult[] = [];
  let changedCount = 0;
  let staleCount = 0;
  let reconciledCount = 0;
  let paypalInvoicesQueried = 0;

  for (const inv of initialRawInvoices) {
    if (!inv.paypalInvoiceId) {
      items.push({
        invoiceId: inv.id,
        number: inv.number,
        clientName: inv.client.name,
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        paypalInvoiceId: null,
        hasPaypalInvoice: false,
        previousPaypalStatus: null,
        currentPaypalStatus: null,
        previousCashpilotStatus: inv.cashpilotStatus,
        currentCashpilotStatus: inv.cashpilotStatus,
        statusChanged: false,
        isStale: false,
        reconciledOperationsCount: 0,
        message: "Local draft — not dispatched to PayPal",
      });
      continue;
    }

    paypalInvoicesQueried++;
    const syncResult = await syncInvoiceWithPayPal(workspaceId, actorId, inv.id);

    if (!syncResult.ok) {
      staleCount++;
      items.push({
        invoiceId: inv.id,
        number: inv.number,
        clientName: inv.client.name,
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        paypalInvoiceId: inv.paypalInvoiceId,
        hasPaypalInvoice: true,
        previousPaypalStatus: inv.paypalStatus,
        currentPaypalStatus: inv.paypalStatus,
        previousCashpilotStatus: inv.cashpilotStatus,
        currentCashpilotStatus: inv.cashpilotStatus,
        statusChanged: false,
        isStale: true,
        reconciledOperationsCount: 0,
        message: `PayPal sync failed: ${syncResult.error}. Preserved last known status.`,
      });
    } else {
      const res = syncResult.data;
      if (res.statusChanged) changedCount++;
      if (res.isStale) staleCount++;
      if (res.reconciledOperationsCount > 0) reconciledCount += res.reconciledOperationsCount;

      let msg = "Status verified with PayPal Sandbox — no changes";
      if (res.statusChanged) {
        msg = `Status updated: ${res.previousCashpilotStatus} → ${res.currentCashpilotStatus} (PayPal: ${res.currentPaypalStatus})`;
      } else if (res.reconciledOperationsCount > 0) {
        msg = `Reconciled ${res.reconciledOperationsCount} uncertain operation(s)`;
      }

      items.push({
        invoiceId: inv.id,
        number: inv.number,
        clientName: inv.client.name,
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        paypalInvoiceId: inv.paypalInvoiceId,
        hasPaypalInvoice: true,
        previousPaypalStatus: res.previousPaypalStatus,
        currentPaypalStatus: res.currentPaypalStatus,
        previousCashpilotStatus: res.previousCashpilotStatus,
        currentCashpilotStatus: res.currentCashpilotStatus,
        statusChanged: res.statusChanged,
        isStale: res.isStale,
        reconciledOperationsCount: res.reconciledOperationsCount,
        message: msg,
      });
    }
  }

  // 5. Query updated state and compute after-summary
  const updatedRawInvoices = await db.invoice.findMany({
    where: { workspaceId },
    include: {
      client: {
        select: { id: true, name: true, email: true, company: true },
      },
      lineItems: {
        select: {
          id: true,
          description: true,
          quantity: true,
          unitPriceMinorUnits: true,
          totalMinorUnits: true,
        },
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const updatedRecords = updatedRawInvoices.map(toInvoiceRecord);
  const afterSummary = extractStageSummary(updatedRecords, now);

  // 6. Record batch audit event
  await db.activityEvent.create({
    data: {
      workspaceId,
      eventType: ActivityEventType.STATUS_SYNC_SUCCESS,
      actorType: ActorType.USER,
      actorId,
      description: `Batch PayPal status reconciliation completed: ${paypalInvoicesQueried} invoice(s) checked, ${changedCount} updated, ${staleCount} stale.`,
      metadata: {
        totalInvoicesScanned: initialRawInvoices.length,
        totalPaypalInvoicesQueried: paypalInvoicesQueried,
        changedCount,
        staleCount,
        reconciledCount,
        beforeOutstandingMinorUnits: beforeSummary.outstandingMinorUnits,
        afterOutstandingMinorUnits: afterSummary.outstandingMinorUnits,
      },
    },
  });

  return {
    ok: true,
    data: {
      workspaceId,
      syncedAt: now.toISOString(),
      totalInvoicesScanned: initialRawInvoices.length,
      totalPaypalInvoicesQueried: paypalInvoicesQueried,
      changedCount,
      staleCount,
      reconciledCount,
      beforeStages: beforeSummary.stages,
      afterStages: afterSummary.stages,
      beforeOutstandingMinorUnits: beforeSummary.outstandingMinorUnits,
      afterOutstandingMinorUnits: afterSummary.outstandingMinorUnits,
      currency: defaultCurrency,
      items,
    },
  };
}

