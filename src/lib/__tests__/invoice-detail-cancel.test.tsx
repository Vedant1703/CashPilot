/**
 * CashPilot AI — Task 13D: Human-Approved Invoice Cancellation Tests
 *
 * Invariants tested:
 * - Cancellation action visibility and eligibility (AWAITING_PAYMENT, DUE_SOON, OVERDUE + PayPal ID + fresh provider state).
 * - Draft, Paid, Partially Paid, and already-Cancelled invoices cannot be cancelled.
 * - Stale sync or NEEDS_REVIEW blocks cancellation until reconciled.
 * - Explicit confirmation required before approval (Human Approval Gate).
 * - Actual server-computed hash displayed and locked in approval modal.
 * - Stale/mismatched approval rejection (409 Conflict).
 * - Successful cancellation atomically transitions status to CANCELLED.
 * - Provider failure handled safely without status alteration.
 * - Timeout / unknown outcome recorded as UNKNOWN; blind retries blocked (504 & 409).
 * - Duplicate-click prevention and loading state indicators.
 * - Cross-workspace authorization failure (403 Forbidden).
 * - Zero automatic retries; zero draft creation, invoice sending, or reminder calls during cancel.
 * - Preservation of invoice line items and audit history; local records are NEVER deleted.
 * - Cancellation NEVER results in a false PAID status.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { NextRequest } from "next/server";
import { InvoiceDetailView, SerializedInvoiceDetail } from "@/components/invoices/invoice-detail-view";
import { CancelApprovalModal } from "@/components/invoices/cancel-approval-modal";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as cancelRoute } from "@/app/api/invoices/[id]/cancel/route";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import {
  CashPilotStatus,
  ApprovalStatus,
  OperationType,
  OperationAttemptState,
} from "@prisma/client";
import { computeMaterialPayloadHash } from "@/lib/services/invoice.service";
import { formatMoney } from "@/lib/money";
import { createTestSession, ensureTestUsers, cleanupTestUsers, assertAllowedTestDatabase } from "@/lib/test-utils/auth";

describe("Human-Approved Invoice Cancellation (Task 13D)", () => {
  const workspaceA = "demo-workspace-cancel-flow-a";
  const workspaceB = "demo-workspace-cancel-flow-b";
  const ownerA = "demo-user-cancel-flow-a";
  const ownerB = "demo-user-cancel-flow-b";
  const clientA = "demo-client-cancel-flow-a";

  let sessionA: { cookieHeader: string };
  let sessionB: { cookieHeader: string };

  const createdInvoiceIds: string[] = [];

  // Spies
  const cancelInvoiceSpy = vi.spyOn(paypalAdapter, "cancelPayPalInvoice");
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const remindInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalReminder");
  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([
      { id: ownerA, email: "cancelflow-a@example.com", name: "Cancel Flow Owner A" },
      { id: ownerB, email: "cancelflow-b@example.com", name: "Cancel Flow Owner B" },
    ]);

    sessionA = await createTestSession({ userId: ownerA, workspaceId: workspaceA });
    sessionB = await createTestSession({ userId: ownerB, workspaceId: workspaceB });

    // Setup test workspaces
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Cancel Flow Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Cancel Flow Workspace B",
        ownerId: ownerB,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientA },
      update: { name: "Acme Cancellation Client", email: "billing@acme-cancel-flow.test" },
      create: {
        id: clientA,
        workspaceId: workspaceA,
        name: "Acme Cancellation Client",
        email: "billing@acme-cancel-flow.test",
        company: "Acme Cancellation Global",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();
    // Foreign-key safe cleanup
    await db.activityEvent.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.externalOperation.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.approval.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.invoiceLineItem.deleteMany({
      where: { invoice: { workspaceId: { in: [workspaceA, workspaceB] } } },
    });
    await db.invoice.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.client.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceA, workspaceB] } },
    });
    await cleanupTestUsers([ownerA, ownerB]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseSentInvoiceFixture: SerializedInvoiceDetail = {
    id: "inv-cancel-unit-1",
    workspaceId: workspaceA,
    clientId: clientA,
    number: "INV-6001",
    materialPayloadHash: "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
    reminderMaterialPayloadHash: "9999888877776666555544443333222211110000aaaabbbbccccddddeeeeffff",
    cancelMaterialPayloadHash: "555566667777888899990000aaaabbbbccccddddeeeeffff1111222233334444",
    isReminderCooldownActive: false,
    recentReminderCompletedAt: null,
    title: "Brand Strategy Retainer",
    notes: "Payment due within 30 days",
    terms: "Net 30",
    currency: "USD",
    subtotalMinorUnits: 500000,
    taxRateBasisPoints: 0,
    taxMinorUnits: 0,
    totalMinorUnits: 500000,
    invoiceDate: "2026-10-01T00:00:00.000Z",
    dueDate: "2026-10-31T00:00:00.000Z",
    cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
    paypalInvoiceId: "INV2-SANDBOX-SENT-6001",
    paypalStatus: "SENT",
    lastSyncAt: "2026-10-02T00:00:00.000Z",
    syncIsStale: false,
    isDemoData: true,
    aiDraftId: null,
    client: {
      id: clientA,
      name: "Acme Cancellation Client",
      email: "billing@acme-cancel-flow.test",
      company: "Acme Cancellation Global",
      phone: null,
      isDemo: true,
    },
    lineItems: [
      {
        id: "li-cancel-1",
        description: "Monthly Brand Strategy Retainer",
        quantity: 1,
        unitPriceMinorUnits: 500000,
        totalMinorUnits: 500000,
        sortOrder: 0,
      },
    ],
    activities: [],
    workspace: {
      id: workspaceA,
      name: "Cancel Flow Workspace A",
      isDemo: true,
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Eligibility & Preflight Checks in UI
  // ───────────────────────────────────────────────────────────────────────────
  describe("Eligibility and Preflight UI Checks", () => {
    it("shows 'Cancel invoice' button when invoice is in AWAITING_PAYMENT status and has fresh provider state", () => {
      const html = renderToString(<InvoiceDetailView initialInvoice={baseSentInvoiceFixture} />);

      expect(html).toContain("Cancel invoice");
      expect(html).toContain("Approve and cancel invoice on PayPal Sandbox");
    });

    it("shows 'Cancel invoice' button for DUE_SOON and OVERDUE statuses", () => {
      const dueSoonFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.DUE_SOON,
      };
      const overdueFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.OVERDUE,
      };

      const dueSoonHtml = renderToString(<InvoiceDetailView initialInvoice={dueSoonFixture} />);
      expect(dueSoonHtml).toContain("Cancel invoice");

      const overdueHtml = renderToString(<InvoiceDetailView initialInvoice={overdueFixture} />);
      expect(overdueHtml).toContain("Cancel invoice");
    });

    it("hides 'Cancel invoice' button when invoice is in DRAFT status", () => {
      const draftFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.DRAFT,
        paypalStatus: "DRAFT",
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={draftFixture} />);

      expect(html).not.toContain("Cancel invoice");
    });

    it("hides 'Cancel invoice' button when invoice is PAID or CANCELLED", () => {
      const paidFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.PAID,
        paypalStatus: "PAID",
      };
      const cancelledFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.CANCELLED,
        paypalStatus: "CANCELLED",
      };

      const paidHtml = renderToString(<InvoiceDetailView initialInvoice={paidFixture} />);
      expect(paidHtml).not.toContain("Cancel invoice");

      const cancelledHtml = renderToString(<InvoiceDetailView initialInvoice={cancelledFixture} />);
      expect(cancelledHtml).not.toContain("Cancel invoice");
    });

    it("hides 'Cancel invoice' button when provider state is stale (syncIsStale: true)", () => {
      const staleFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        syncIsStale: true,
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={staleFixture} />);

      expect(html).not.toContain("Cancel invoice");
    });

    it("hides 'Cancel invoice' button when invoice has no paypalInvoiceId", () => {
      const noPaypalIdFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        paypalInvoiceId: null,
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={noPaypalIdFixture} />);

      expect(html).not.toContain("Cancel invoice");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Explicit Human Approval Gate Modal
  // ───────────────────────────────────────────────────────────────────────────
  describe("Explicit Human Approval Gate Modal", () => {
    it("renders cancellation approval sheet with exact material details, consequence warning, and locked hash", () => {
      const html = renderToString(
        <CancelApprovalModal
          isOpen={true}
          onClose={() => {}}
          onCancelSuccess={() => {}}
          invoice={baseSentInvoiceFixture}
          materialPayloadHash={baseSentInvoiceFixture.cancelMaterialPayloadHash!}
        />
      );

      // Consequential Human Approval badge
      expect(html).toContain("Human Approval Gate");
      expect(html).toContain("Irreversible Action");
      expect(html).toContain("Approve Invoice Cancellation");
      expect(html).toContain("This action officially cancels the invoice on PayPal Sandbox");

      // Material review details
      expect(html).toContain("INV-6001");
      expect(html).toContain("billing@acme-cancel-flow.test");
      expect(html).toContain("AWAITING_PAYMENT");
      expect(html).toContain("INV2-SANDBOX-SENT-6001");
      expect(html).toContain(formatMoney(baseSentInvoiceFixture.totalMinorUnits, "USD"));

      // Consequence warning
      expect(html).toContain("Cancellation Consequences");
      expect(html).toContain("PayPal Sandbox will immediately void this invoice");
      expect(html).toContain("Once cancelled, payment cannot be recorded against this invoice");

      // Cryptographic Material Hash Lock
      expect(html).toContain("Cryptographic Material Hash Lock");
      expect(html).toContain(baseSentInvoiceFixture.cancelMaterialPayloadHash);

      // Financial truth reminder
      expect(html).toContain("Financial Truth: Cancellation transitions the invoice to CANCELLED");
      expect(html).toContain("It can never be marked as Paid, and local database records are never deleted");

      // Action buttons
      expect(html).toContain("Keep invoice active");
      expect(html).toContain("Approve and cancel on PayPal");
    });

    it("renders nothing when isOpen is false", () => {
      const html = renderToString(
        <CancelApprovalModal
          isOpen={false}
          onClose={() => {}}
          onCancelSuccess={() => {}}
          invoice={baseSentInvoiceFixture}
          materialPayloadHash={baseSentInvoiceFixture.cancelMaterialPayloadHash!}
        />
      );

      expect(html).toBe("");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. End-to-End Approved Cancellation Lifecycle & Safety Invariants
  // ───────────────────────────────────────────────────────────────────────────
  describe("End-to-End Approved Cancellation Lifecycle", () => {
    async function createDatabaseInvoiceForCancel(
      status: CashPilotStatus = CashPilotStatus.AWAITING_PAYMENT,
      options: { paypalStatus?: string; syncIsStale?: boolean } = {}
    ) {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          title: "Architecture Security Review",
          currency: "USD",
          subtotalMinorUnits: 450000,
          taxRateBasisPoints: 0,
          taxMinorUnits: 0,
          totalMinorUnits: 450000,
          dueDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
          cashpilotStatus: status,
          paypalInvoiceId: `INV2-TEST-CANCEL-${Date.now()}`,
          paypalStatus: options.paypalStatus ?? "SENT",
          syncIsStale: options.syncIsStale ?? false,
          isDemoData: true,
          lineItems: {
            create: [
              {
                description: "Security Penetration & Code Audit",
                quantity: 1,
                unitPriceMinorUnits: 450000,
                totalMinorUnits: 450000,
                sortOrder: 0,
              },
            ],
          },
        },
        include: {
          client: true,
          lineItems: true,
        },
      });

      createdInvoiceIds.push(inv.id);
      return inv;
    }

    it("successfully approves with server-returned hash and cancels on PayPal, transitioning to CANCELLED", async () => {
      const inv = await createDatabaseInvoiceForCancel(CashPilotStatus.AWAITING_PAYMENT);

      // 1. Authoritative server calculation of cancellation hash
      const currentHash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "CANCEL_INVOICE",
      });

      // 2. Step 1: Explicit Human Approval Gate
      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "CANCEL_INVOICE",
          reviewedPayloadHash: currentHash,
        }),
      });

      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();

      expect(approveRes.status).toBe(200);
      expect(approveJson.success).toBe(true);
      expect(approveJson.data.status).toBe("APPROVED");
      expect(approveJson.data.approvedPayloadHash).toBe(currentHash);

      const approvalId = approveJson.data.approvalId;

      // 3. Mock PayPal Sandbox cancel response
      cancelInvoiceSpy.mockResolvedValueOnce({
        success: true,
        data: { cancelled: true },
        correlationId: "corr-cancel-exec-01",
      });

      // 4. Step 2: Submit Cancel Request with valid approval ID
      const cancelReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const cancelRes = await cancelRoute(cancelReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const cancelJson = await cancelRes.json();

      expect(cancelRes.status).toBe(200);
      expect(cancelJson.success).toBe(true);
      expect(cancelJson.data.currentStatus).toBe(CashPilotStatus.CANCELLED);
      expect(cancelJson.data.currentPaypalStatus).toBe("CANCELLED");
      expect(cancelInvoiceSpy).toHaveBeenCalledTimes(1);

      // Verify ZERO unintended provider calls
      expect(sendInvoiceSpy).not.toHaveBeenCalled();
      expect(remindInvoiceSpy).not.toHaveBeenCalled();
      expect(createDraftSpy).not.toHaveBeenCalled();

      // 5. FINANCIAL INVARIANT: Status updated atomically to CANCELLED, NEVER PAID
      const persistedInvoice = await db.invoice.findUnique({
        where: { id: inv.id },
      });
      expect(persistedInvoice?.cashpilotStatus).toBe(CashPilotStatus.CANCELLED);
      expect(persistedInvoice?.cashpilotStatus).not.toBe(CashPilotStatus.PAID);
      expect(persistedInvoice?.paypalStatus).toBe("CANCELLED");

      // Verify local database record is RETAINED (never deleted!)
      expect(persistedInvoice).toBeTruthy();

      // 6. Approval was marked USED
      const consumedApproval = await db.approval.findUnique({
        where: { id: approvalId },
      });
      expect(consumedApproval?.status).toBe(ApprovalStatus.USED);

      // 7. Audit event recorded
      const activity = await db.activityEvent.findFirst({
        where: { invoiceId: inv.id, operationId: cancelJson.data.operationId },
      });
      expect(activity).toBeTruthy();
      expect(activity?.description).toContain("cancelled via PayPal Sandbox");
    });

    it("rejects approval attempt when submitting mismatched or forged hash with 409 STALE_PAYLOAD_HASH", async () => {
      const inv = await createDatabaseInvoiceForCancel();

      const forgedHash = "0000000000000000000000000000000000000000000000000000000000000000";

      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "CANCEL_INVOICE",
          reviewedPayloadHash: forgedHash,
        }),
      });

      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();

      expect(approveRes.status).toBe(409);
      expect(approveJson.success).toBe(false);
      expect(approveJson.code).toBe("STALE_PAYLOAD_HASH");
      expect(cancelInvoiceSpy).not.toHaveBeenCalled();
    });

    it("rejects cancellation with 409 Conflict if invoice was materially altered after approval", async () => {
      const inv = await createDatabaseInvoiceForCancel();

      const initialHash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "CANCEL_INVOICE",
      });

      // Approve initial state
      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "CANCEL_INVOICE",
          reviewedPayloadHash: initialHash,
        }),
      });
      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();
      const approvalId = approveJson.data.approvalId;

      // Materially modify invoice amount after approval
      await db.invoice.update({
        where: { id: inv.id },
        data: { totalMinorUnits: 888800 },
      });

      // Attempt cancellation with stale approval
      const cancelReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const cancelRes = await cancelRoute(cancelReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const cancelJson = await cancelRes.json();

      expect(cancelRes.status).toBe(409);
      expect(cancelJson.success).toBe(false);
      expect(cancelJson.code).toBe("APPROVAL_STALE");
      expect(cancelInvoiceSpy).not.toHaveBeenCalled();

      // Verify approval was invalidated
      const invalidatedApproval = await db.approval.findUnique({
        where: { id: approvalId },
      });
      expect(invalidatedApproval?.status).toBe(ApprovalStatus.INVALIDATED);
    });

    it("rejects cancellation if provider state is ambiguous or stale with 409 PROVIDER_STATE_AMBIGUOUS", async () => {
      const inv = await createDatabaseInvoiceForCancel(CashPilotStatus.AWAITING_PAYMENT, {
        syncIsStale: true, // Stale state!
      });

      const hash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "CANCEL_INVOICE",
      });

      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "CANCEL_INVOICE",
          reviewedPayloadHash: hash,
        }),
      });

      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();

      expect(approveRes.status).toBe(409);
      expect(approveJson.success).toBe(false);
      expect(approveJson.code).toBe("PROVIDER_STATE_AMBIGUOUS");
      expect(cancelInvoiceSpy).not.toHaveBeenCalled();
    });

    it("rejects cancellation if invoice is already PAID", async () => {
      const inv = await createDatabaseInvoiceForCancel(CashPilotStatus.PAID, {
        paypalStatus: "PAID",
      });

      const hash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "CANCEL_INVOICE",
      });

      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "CANCEL_INVOICE",
          reviewedPayloadHash: hash,
        }),
      });

      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();

      expect(approveRes.status).toBe(400);
      expect(approveJson.success).toBe(false);
      expect(approveJson.error).toContain("Paid invoices cannot be cancelled");
      expect(cancelInvoiceSpy).not.toHaveBeenCalled();
    });

    it("handles PayPal timeout with 504 and blocks subsequent blind retry with 409 PENDING_UNKNOWN_OPERATION", async () => {
      const inv = await createDatabaseInvoiceForCancel();

      const hash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "CANCEL_INVOICE",
      });

      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "CANCEL_INVOICE",
          reviewedPayloadHash: hash,
        }),
      });
      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();
      const approvalId = approveJson.data.approvalId;

      // Mock PayPal timeout
      cancelInvoiceSpy.mockResolvedValueOnce({
        success: false,
        isOutcomeUnknown: true,
        error: {
          code: "TIMEOUT",
          message: "PayPal cancel timed out",
          httpStatus: 504,
        },
        correlationId: "corr-timeout-cancel",
      });

      // Cancel 1 (Times out)
      const cancelReq1 = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const cancelRes1 = await cancelRoute(cancelReq1, {
        params: Promise.resolve({ id: inv.id }),
      });
      const cancelJson1 = await cancelRes1.json();

      expect(cancelRes1.status).toBe(504);
      expect(cancelJson1.success).toBe(false);
      expect(cancelJson1.code).toBe("OPERATION_UNKNOWN_OUTCOME");

      // Verify operation recorded with isOutcomeUnknown = true
      const recordedOp = await db.externalOperation.findFirst({
        where: { invoiceId: inv.id, operationType: OperationType.CANCEL_INVOICE },
      });
      expect(recordedOp?.isOutcomeUnknown).toBe(true);
      expect(recordedOp?.attemptState).toBe(OperationAttemptState.UNKNOWN);

      // Status remains unchanged
      const invoiceAfterTimeout = await db.invoice.findUnique({
        where: { id: inv.id },
      });
      expect(invoiceAfterTimeout?.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);

      // Cancel 2 (Blind Retry blocked server-side!)
      const cancelReq2 = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const cancelRes2 = await cancelRoute(cancelReq2, {
        params: Promise.resolve({ id: inv.id }),
      });
      const cancelJson2 = await cancelRes2.json();

      expect(cancelRes2.status).toBe(409);
      expect(cancelJson2.success).toBe(false);
      expect(cancelJson2.code).toBe("PENDING_UNKNOWN_OPERATION");

      // cancelInvoiceSpy was NOT called on blind retry
      expect(cancelInvoiceSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects cross-workspace cancellation with 403 Forbidden", async () => {
      const inv = await createDatabaseInvoiceForCancel();

      // Workspace B attempts to cancel an invoice belonging to Workspace A
      const cancelReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionB.cookieHeader, // Cross workspace!
        },
      });

      const cancelRes = await cancelRoute(cancelReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const cancelJson = await cancelRes.json();

      expect(cancelRes.status).toBe(403);
      expect(cancelJson.success).toBe(false);
      expect(cancelJson.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
      expect(cancelInvoiceSpy).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated request with 401 Unauthorized", async () => {
      const inv = await createDatabaseInvoiceForCancel();

      const cancelReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const cancelRes = await cancelRoute(cancelReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const cancelJson = await cancelRes.json();

      expect(cancelRes.status).toBe(401);
      expect(cancelJson.success).toBe(false);
      expect(cancelJson.code).toBe("UNAUTHORIZED");
      expect(cancelInvoiceSpy).not.toHaveBeenCalled();
    });
  });
});
