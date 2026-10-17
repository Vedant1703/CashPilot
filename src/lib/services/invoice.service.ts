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

function hashApprovalPayload(payload: ApprovalPayload): string {
  const canonicalJson = JSON.stringify({
    invoiceId: payload.invoiceId,
    workspaceId: payload.workspaceId,
    actionType: payload.actionType,
    recipientEmail: payload.recipientEmail,
    totalMinorUnits: payload.totalMinorUnits,
    currency: payload.currency,
    dueDate: payload.dueDate,
  });
  return createHash("sha256").update(canonicalJson).digest("hex");
}

export function computeMaterialPayloadHash(invoice: {
  id: string;
  workspaceId: string;
  client: { email: string };
  totalMinorUnits: number;
  currency: string;
  dueDate: Date | string;
  actionType?: "SEND_INVOICE" | "SEND_REMINDER" | "CANCEL_INVOICE";
}): string {
  const canonicalJson = JSON.stringify({
    invoiceId: invoice.id,
    workspaceId: invoice.workspaceId,
    actionType: invoice.actionType ?? "SEND_INVOICE",
    recipientEmail: invoice.client.email,
    totalMinorUnits: invoice.totalMinorUnits,
    currency: invoice.currency,
    dueDate:
      typeof invoice.dueDate === "string"
        ? invoice.dueDate.substring(0, 10)
        : invoice.dueDate.toISOString().substring(0, 10),
  });
  return createHash("sha256").update(canonicalJson).digest("hex");
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

  // Build the material payload snapshot
  const payload = buildApprovalPayload(invoice, actionType);
  const payloadHash = hashApprovalPayload(payload);

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

// ─────────────────────────────────────────────────────────────────────────────
// PayPal Operations — Require Valid Approval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute an approved invoice send operation.
 * This is the ONLY path that can result in a PayPal invoice being sent.
 *
 * SRS §4: Revalidate authorization, approval, and payload version immediately
 * before executing. A successful send does NOT transition to PAID.
 */
export async function executeApprovedSend(
  workspaceId: string,
  actorId: string,
  approvalId: string
): Promise<ServiceResult<{ operationId: string; paypalInvoiceId?: string }>> {
  // ── 1. Load and re-validate approval immediately before execution ──────────
  const approval = await db.approval.findFirst({
    where: { id: approvalId, workspaceId },
    include: { invoice: { include: { client: true, lineItems: true } } },
  });

  if (!approval) {
    return { ok: false, error: "Approval not found", code: "NOT_FOUND" };
  }

  if (approval.status !== ApprovalStatus.APPROVED) {
    return {
      ok: false,
      error: `Approval is not APPROVED (current: ${approval.status})`,
      code: "APPROVAL_NOT_APPROVED",
    };
  }

  if (!approval.invoice) {
    return { ok: false, error: "Invoice not found on approval", code: "NOT_FOUND" };
  }

  // ── 2. Verify the invoice material fields still match the approved payload ─
  const currentPayload = buildApprovalPayload(approval.invoice, "SEND_INVOICE");
  const currentHash = hashApprovalPayload(currentPayload);

  if (currentHash !== approval.payloadHash) {
    // Material field has changed — invalidate approval
    await db.approval.update({
      where: { id: approvalId },
      data: {
        status: ApprovalStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: "Invoice material fields changed after approval",
      },
    });

    await db.activityEvent.create({
      data: {
        workspaceId,
        invoiceId: approval.invoiceId ?? undefined,
        approvalId,
        eventType: ActivityEventType.APPROVAL_INVALIDATED,
        actorType: ActorType.SYSTEM,
        actorId: "system",
        description: "Approval invalidated: invoice content changed after approval",
        metadata: { expectedHash: approval.payloadHash, actualHash: currentHash },
      },
    });

    return {
      ok: false,
      error: "Invoice was modified after approval. Please review and re-approve.",
      code: "PAYLOAD_MISMATCH",
    };
  }

  // ── 3. Verify invoice state permits sending ────────────────────────────────
  const invoice = approval.invoice;
  if (!canSendToPayPal(invoice.cashpilotStatus)) {
    return {
      ok: false,
      error: `Invoice cannot be sent in state: ${invoice.cashpilotStatus}`,
      code: "INVALID_INVOICE_STATE",
    };
  }

  // ── 4. Check for existing unknown-outcome operations (prevent duplicate) ───
  const pendingOp = await db.externalOperation.findFirst({
    where: {
      invoiceId: invoice.id,
      operationType: OperationType.SEND_INVOICE,
      isOutcomeUnknown: true,
    },
  });

  if (pendingOp) {
    return {
      ok: false,
      error: "A previous send operation has an unknown outcome. Reconcile before retrying.",
      code: "PENDING_UNKNOWN_OPERATION",
    };
  }

  // ── 5. Create the operation record (generates idempotency key) ─────────────
  const idempotencyKey = `send-${invoice.id}-${approvalId}-${Date.now()}`;

  const operation = await db.externalOperation.create({
    data: {
      workspaceId,
      invoiceId: invoice.id,
      approvalId,
      operationType: OperationType.SEND_INVOICE,
      idempotencyKey,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: new Date(),
    },
  });

  // ── 6. Step A: Create draft in PayPal if no provider ID yet ───────────────
  let paypalInvoiceId = invoice.paypalInvoiceId;

  if (!paypalInvoiceId) {
    const draftPayload = buildPayPalInvoicePayload(invoice);
    const draftResult = await createPayPalDraftInvoice(draftPayload);

    if (!draftResult.success) {
      const isUnknown = "isOutcomeUnknown" in draftResult && draftResult.isOutcomeUnknown;

      await updateOperationAndAudit(
        operation.id,
        workspaceId,
        invoice.id,
        approvalId,
        actorId,
        isUnknown ? OperationAttemptState.UNKNOWN : OperationAttemptState.FAILED,
        isUnknown,
        draftResult.error.code,
        draftResult.error.message
      );

      return {
        ok: false,
        error: draftResult.error.message,
        code: draftResult.error.code,
      };
    }

    paypalInvoiceId = draftResult.data.id;

    // Persist provider invoice ID
    await db.invoice.update({
      where: { id: invoice.id },
      data: {
        paypalInvoiceId,
        paypalStatus: draftResult.data.status,
      },
    });
  }

  // ── 7. Step B: Send the invoice ───────────────────────────────────────────
  const sendResult = await sendPayPalInvoice(paypalInvoiceId);

  if (!sendResult.success) {
    const isUnknown = "isOutcomeUnknown" in sendResult && sendResult.isOutcomeUnknown;

    await updateOperationAndAudit(
      operation.id,
      workspaceId,
      invoice.id,
      approvalId,
      actorId,
      isUnknown ? OperationAttemptState.UNKNOWN : OperationAttemptState.FAILED,
      isUnknown,
      sendResult.error.code,
      sendResult.error.message
    );

    return {
      ok: false,
      error: sendResult.error.message,
      code: sendResult.error.code,
    };
  }

  // ── 8. Successful send — transition to AWAITING_PAYMENT ───────────────────
  // NOTE: This is NOT Paid. A send is NOT a payment.
  const dueDateMapped = mapPayPalStatusToCashPilot("SENT", invoice.dueDate);

  await db.$transaction(async (tx) => {
    // Mark operation success
    await tx.externalOperation.update({
      where: { id: operation.id },
      data: {
        attemptState: OperationAttemptState.SUCCESS,
        completedAt: new Date(),
        providerInvoiceId: paypalInvoiceId,
        isOutcomeUnknown: false,
      },
    });

    // Update invoice status — NEVER set to PAID here
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        cashpilotStatus: dueDateMapped.cashpilotStatus,
        paypalStatus: "SENT",
        lastSyncAt: new Date(),
        syncIsStale: false,
      },
    });

    // Mark approval as used
    await tx.approval.update({
      where: { id: approvalId },
      data: { status: ApprovalStatus.USED },
    });

    // Record audit
    await tx.activityEvent.create({
      data: {
        workspaceId,
        invoiceId: invoice.id,
        approvalId,
        operationId: operation.id,
        eventType: ActivityEventType.OPERATION_SUCCEEDED,
        actorType: ActorType.USER,
        actorId,
        description: `Invoice sent via PayPal Sandbox. Provider ID: ${paypalInvoiceId}. Status: SENT (not paid).`,
        metadata: {
          paypalInvoiceId,
          newStatus: dueDateMapped.cashpilotStatus,
          correlationId: sendResult.correlationId,
        },
      },
    });

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

  return { ok: true, data: { operationId: operation.id, paypalInvoiceId } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Refresh / Reconciliation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refresh the invoice status from PayPal.
 * SRS §4: Preserve last known status and mark stale if refresh fails.
 * Never infer Paid without verified provider evidence.
 */
export async function refreshInvoiceStatus(
  workspaceId: string,
  invoiceId: string
): Promise<ServiceResult<{ cashpilotStatus: CashPilotStatus; isStale: boolean }>> {
  const invoice = await getInvoiceById(invoiceId, workspaceId);
  if (!invoice) {
    return { ok: false, error: "Invoice not found", code: "NOT_FOUND" };
  }

  if (!invoice.paypalInvoiceId) {
    // No provider ID — nothing to refresh
    return { ok: true, data: { cashpilotStatus: invoice.cashpilotStatus, isStale: false } };
  }

  // Record the sync attempt
  const syncOp = await db.externalOperation.create({
    data: {
      workspaceId,
      invoiceId,
      operationType: OperationType.GET_INVOICE,
      attemptState: OperationAttemptState.IN_FLIGHT,
      attemptedAt: new Date(),
    },
  });

  const statusResult = await getPayPalInvoiceStatus(invoice.paypalInvoiceId);

  if (!statusResult.success) {
    const isUnknown = "isOutcomeUnknown" in statusResult && statusResult.isOutcomeUnknown;

    // Preserve last valid status — mark stale
    await db.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { syncIsStale: true },
      });

      await tx.externalOperation.update({
        where: { id: syncOp.id },
        data: {
          attemptState: isUnknown ? OperationAttemptState.UNKNOWN : OperationAttemptState.FAILED,
          isOutcomeUnknown: isUnknown,
          completedAt: new Date(),
          errorCode: statusResult.error.code,
          errorMessage: statusResult.error.message,
        },
      });

      await tx.activityEvent.create({
        data: {
          workspaceId,
          invoiceId,
          operationId: syncOp.id,
          eventType: ActivityEventType.STATUS_SYNC_FAILED,
          actorType: ActorType.SYSTEM,
          actorId: "system",
          description: "Status refresh failed. Last known status preserved and marked stale.",
          metadata: { error: statusResult.error.code },
        },
      });
    });

    return {
      ok: true, // Not a hard error — return stale status gracefully
      data: { cashpilotStatus: invoice.cashpilotStatus, isStale: true },
    };
  }

  // Map provider status to CashPilot status
  const mapped = mapPayPalStatusToCashPilot(
    statusResult.data.status,
    invoice.dueDate
  );

  await db.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        cashpilotStatus: mapped.cashpilotStatus,
        paypalStatus: statusResult.data.status,
        paypalStatusRaw: statusResult.data as unknown as Prisma.InputJsonValue,
        lastSyncAt: new Date(),
        syncIsStale: false,
      },
    });

    await tx.externalOperation.update({
      where: { id: syncOp.id },
      data: {
        attemptState: OperationAttemptState.SUCCESS,
        completedAt: new Date(),
        providerResponse: {
          status: statusResult.data.status,
          id: statusResult.data.id,
        },
      },
    });

    await tx.activityEvent.create({
      data: {
        workspaceId,
        invoiceId,
        operationId: syncOp.id,
        eventType: ActivityEventType.STATUS_SYNC_SUCCESS,
        actorType: ActorType.SYSTEM,
        actorId: "system",
        description: `Status refreshed from PayPal. Provider status: ${statusResult.data.status} → CashPilot: ${mapped.cashpilotStatus}`,
        metadata: {
          providerStatus: statusResult.data.status,
          cashpilotStatus: mapped.cashpilotStatus,
          requiresReview: mapped.requiresReview,
        },
      },
    });
  });

  return { ok: true, data: { cashpilotStatus: mapped.cashpilotStatus, isStale: false } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build PayPal API invoice payload from CashPilot invoice record */
function buildPayPalInvoicePayload(
  invoice: NonNullable<Awaited<ReturnType<typeof getInvoiceById>>>
): PayPalInvoicePayload {
  const items: PayPalInvoicePayload["items"] = invoice.lineItems.map((li) => ({
    name: li.description,
    quantity: String(li.quantity),
    unit_amount: {
      currency_code: invoice.currency,
      // Convert minor units to decimal for PayPal API
      value: (li.unitPriceMinorUnits / 100).toFixed(2),
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
  errorMessage?: string
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
        metadata: { errorCode, isOutcomeUnknown },
      },
    });
  });
}
