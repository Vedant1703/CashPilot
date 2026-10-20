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
} from "@/lib/money";
import {
  invoiceInputSchema,
  type InvoiceInput,
  type ApprovalPayload,
} from "@/lib/validations/invoice";
import {
  createPayPalDraftInvoice,
  sendPayPalInvoice,
  getPayPalInvoiceStatus,
  type PayPalInvoicePayload,
} from "@/lib/paypal/adapter";
import {
  mapPayPalStatusToCashPilot,
  canSendToPayPal,
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
}): string {
  const canonical = {
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
  const invoice = await getInvoiceById(invoiceId, workspaceId);
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
    await tx.activityEvent.create({
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
      },
      materialPayloadHash,
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
  reviewedPayloadHash: string
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

  // 3. Compute authoritative current material payload hash on server
  const currentPayloadHash = computeMaterialPayloadHash({
    ...invoice,
    actionType,
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
  const items: PayPalInvoicePayload["items"] = invoice.lineItems.map((li) => ({
    name: li.description,
    quantity: String(li.quantity),
    unit_amount: {
      currency_code: invoice.currency,
      value: minorUnitsToDecimalString(li.unitPriceMinorUnits),
    },
  }));

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
