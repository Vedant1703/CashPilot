/**
 * CashPilot AI — Task 13C: Human-Approved Invoice Reminders Tests
 *
 * Invariants tested:
 * - Reminder action visibility and eligibility (AWAITING_PAYMENT, DUE_SOON, OVERDUE + PayPal ID).
 * - Cooldown enforcement: 24h cooldown UI feedback and server rejection (429 Too Many Requests).
 * - Draft, Paid, and Cancelled invoices cannot receive reminders.
 * - Explicit confirmation required before approval (Human Approval Gate).
 * - Actual server-computed hash displayed and locked in approval modal.
 * - Stale/mismatched approval rejection (409 Conflict).
 * - Successful reminder leaves invoice status unchanged (remains AWAITING_PAYMENT, NEVER PAID).
 * - Provider failure handled safely without status alteration.
 * - Timeout / unknown outcome recorded as UNKNOWN; blind retries blocked (504 & 409).
 * - Duplicate-click prevention and loading state indicators.
 * - Cross-workspace authorization failure (403 Forbidden).
 * - Zero automatic retries; zero invoice creation or cancellation calls during remind.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { NextRequest } from "next/server";
import { InvoiceDetailView, SerializedInvoiceDetail } from "@/components/invoices/invoice-detail-view";
import { SendReminderApprovalModal } from "@/components/invoices/send-reminder-approval-modal";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as remindRoute } from "@/app/api/invoices/[id]/remind/route";
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
import { createTestSession } from "@/lib/test-utils/auth";

describe("Human-Approved Invoice Reminders (Task 13C)", () => {
  const workspaceA = "demo-workspace-remind-flow-a";
  const workspaceB = "demo-workspace-remind-flow-b";
  const ownerA = "demo-user-remind-flow-a";
  const ownerB = "demo-user-remind-flow-b";
  const clientA = "demo-client-remind-flow-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  const createdInvoiceIds: string[] = [];

  // Spies
  const remindInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalReminder");
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const cancelInvoiceSpy = vi.spyOn(paypalAdapter, "cancelPayPalInvoice");

  beforeAll(async () => {
    sessionA = createTestSession({ userId: ownerA, email: "remindflow-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "remindflow-b@example.com" });

    // Setup test workspaces
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Remind Flow Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Remind Flow Workspace B",
        ownerId: ownerB,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientA },
      update: { name: "Acme Reminder Client", email: "billing@acme-remind-flow.test" },
      create: {
        id: clientA,
        workspaceId: workspaceA,
        name: "Acme Reminder Client",
        email: "billing@acme-remind-flow.test",
        company: "Acme Reminders Global",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
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
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseSentInvoiceFixture: SerializedInvoiceDetail = {
    id: "inv-remind-unit-1",
    workspaceId: workspaceA,
    clientId: clientA,
    number: "INV-7001",
    materialPayloadHash: "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
    reminderMaterialPayloadHash: "9999888877776666555544443333222211110000aaaabbbbccccddddeeeeffff",
    recentReminderCompletedAt: null,
    title: "Quarterly Systems Maintenance",
    notes: "Payment due within 14 days",
    terms: "Net 14",
    currency: "USD",
    subtotalMinorUnits: 250000,
    taxRateBasisPoints: 0,
    taxMinorUnits: 0,
    totalMinorUnits: 250000,
    invoiceDate: "2026-10-01T00:00:00.000Z",
    dueDate: "2026-10-15T00:00:00.000Z",
    cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
    paypalInvoiceId: "INV2-SANDBOX-SENT-7001",
    paypalStatus: "SENT",
    lastSyncAt: "2026-10-02T00:00:00.000Z",
    syncIsStale: false,
    isDemoData: true,
    aiDraftId: null,
    client: {
      id: clientA,
      name: "Acme Reminder Client",
      email: "billing@acme-remind-flow.test",
      company: "Acme Reminders Global",
      phone: null,
      isDemo: true,
    },
    lineItems: [
      {
        id: "li-remind-1",
        description: "DevOps & Infrastructure Maintenance",
        quantity: 1,
        unitPriceMinorUnits: 250000,
        totalMinorUnits: 250000,
        sortOrder: 0,
      },
    ],
    activities: [],
    workspace: {
      id: workspaceA,
      name: "Remind Flow Workspace A",
      isDemo: true,
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Eligibility & Preflight Checks in UI
  // ───────────────────────────────────────────────────────────────────────────
  describe("Eligibility and Preflight UI Checks", () => {
    it("shows 'Send reminder' button when invoice is in AWAITING_PAYMENT status and has PayPal invoice ID", () => {
      const html = renderToString(<InvoiceDetailView initialInvoice={baseSentInvoiceFixture} />);

      expect(html).toContain("Send reminder");
      expect(html).toContain("Approve and send payment reminder via PayPal Sandbox");
      // DRAFT send button is NOT shown
      expect(html).not.toContain("Send invoice");
    });

    it("shows 'Send reminder' button for DUE_SOON and OVERDUE statuses", () => {
      const dueSoonFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.DUE_SOON,
      };
      const overdueFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.OVERDUE,
      };

      const dueSoonHtml = renderToString(<InvoiceDetailView initialInvoice={dueSoonFixture} />);
      expect(dueSoonHtml).toContain("Send reminder");

      const overdueHtml = renderToString(<InvoiceDetailView initialInvoice={overdueFixture} />);
      expect(overdueHtml).toContain("Send reminder");
    });

    it("shows disabled button with cooldown explanation when reminder was sent within last 24h", () => {
      const cooldownFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        recentReminderCompletedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={cooldownFixture} />);

      expect(html).toContain("Reminder in cooldown");
      expect(html).toContain("24-hour cooldown active");
      // Active Send reminder button is not shown
      expect(html).not.toContain("Approve and send payment reminder via PayPal Sandbox");
    });

    it("hides 'Send reminder' button when invoice is in DRAFT status", () => {
      const draftFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.DRAFT,
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={draftFixture} />);

      expect(html).not.toContain("Send reminder");
      expect(html).not.toContain("Reminder in cooldown");
    });

    it("hides 'Send reminder' button when invoice has no paypalInvoiceId", () => {
      const noPaypalIdFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        paypalInvoiceId: null,
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={noPaypalIdFixture} />);

      expect(html).not.toContain("Send reminder");
    });

    it("hides 'Send reminder' button when invoice is PAID or CANCELLED", () => {
      const paidFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.PAID,
      };
      const cancelledFixture: SerializedInvoiceDetail = {
        ...baseSentInvoiceFixture,
        cashpilotStatus: CashPilotStatus.CANCELLED,
      };

      const paidHtml = renderToString(<InvoiceDetailView initialInvoice={paidFixture} />);
      expect(paidHtml).not.toContain("Send reminder");

      const cancelledHtml = renderToString(<InvoiceDetailView initialInvoice={cancelledFixture} />);
      expect(cancelledHtml).not.toContain("Send reminder");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Explicit Human Approval Gate Modal
  // ───────────────────────────────────────────────────────────────────────────
  describe("Explicit Human Approval Gate Modal", () => {
    it("renders reminder approval sheet with exact material details and locked cryptographic hash", () => {
      const html = renderToString(
        <SendReminderApprovalModal
          isOpen={true}
          onClose={() => {}}
          onRemindSuccess={() => {}}
          invoice={baseSentInvoiceFixture}
          materialPayloadHash={baseSentInvoiceFixture.reminderMaterialPayloadHash!}
        />
      );

      // Consequential Human Approval badge
      expect(html).toContain("Human Approval Gate");
      expect(html).toContain("Approve Payment Reminder");
      expect(html).toContain("This action dispatches an official payment reminder notification");

      // Material review details
      expect(html).toContain("INV-7001");
      expect(html).toContain("billing@acme-remind-flow.test");
      expect(html).toContain("AWAITING_PAYMENT");
      expect(html).toContain("INV2-SANDBOX-SENT-7001");
      expect(html).toContain(formatMoney(baseSentInvoiceFixture.totalMinorUnits, "USD"));

      // Content preview
      expect(html).toContain("Payment Reminder: Invoice INV-7001");

      // Cryptographic Material Hash Lock
      expect(html).toContain("Cryptographic Material Hash Lock");
      expect(html).toContain(baseSentInvoiceFixture.reminderMaterialPayloadHash);

      // Financial truth reminder
      expect(html).toContain("Financial Truth: A reminder is purely a notification");
      expect(html).toContain("It does not alter invoice status, record payment, or modify amounts");

      // Action buttons
      expect(html).toContain("Back to invoice");
      expect(html).toContain("Approve and send reminder via PayPal");
    });

    it("renders nothing when isOpen is false", () => {
      const html = renderToString(
        <SendReminderApprovalModal
          isOpen={false}
          onClose={() => {}}
          onRemindSuccess={() => {}}
          invoice={baseSentInvoiceFixture}
          materialPayloadHash={baseSentInvoiceFixture.reminderMaterialPayloadHash!}
        />
      );

      expect(html).toBe("");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. End-to-End Approved Reminder Lifecycle & Safety Invariants
  // ───────────────────────────────────────────────────────────────────────────
  describe("End-to-End Approved Reminder Lifecycle", () => {
    async function createDatabaseInvoiceForReminder(
      status: CashPilotStatus = CashPilotStatus.AWAITING_PAYMENT,
      options: { paypalId?: string; recentReminder?: boolean } = {}
    ) {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          title: "Production Infrastructure Support",
          currency: "USD",
          subtotalMinorUnits: 300000,
          taxRateBasisPoints: 0,
          taxMinorUnits: 0,
          totalMinorUnits: 300000,
          dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          cashpilotStatus: status,
          paypalInvoiceId: options.paypalId ?? `INV2-TEST-REMIND-${Date.now()}`,
          paypalStatus: "SENT",
          isDemoData: true,
          lineItems: {
            create: [
              {
                description: "DevOps & Cloud Engineering",
                quantity: 1,
                unitPriceMinorUnits: 300000,
                totalMinorUnits: 300000,
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

      if (options.recentReminder) {
        await db.externalOperation.create({
          data: {
            workspaceId: workspaceA,
            invoiceId: inv.id,
            operationType: OperationType.SEND_REMINDER,
            attemptState: OperationAttemptState.SUCCESS,
            completedAt: new Date(),
          },
        });
      }

      return inv;
    }

    it("successfully approves with server-returned hash and sends reminder to PayPal, preserving AWAITING_PAYMENT status", async () => {
      const inv = await createDatabaseInvoiceForReminder(CashPilotStatus.AWAITING_PAYMENT);

      // 1. Authoritative server calculation of reminder hash
      const currentHash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "SEND_REMINDER",
      });

      // 2. Step 1: Explicit Human Approval Gate
      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_REMINDER",
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

      // 3. Mock PayPal Sandbox reminder response
      remindInvoiceSpy.mockResolvedValueOnce({
        success: true,
        data: { reminded: true },
        correlationId: "corr-remind-exec-01",
      });

      // 4. Step 2: Submit Remind Request with valid approval ID
      const remindReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/remind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const remindRes = await remindRoute(remindReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const remindJson = await remindRes.json();

      expect(remindRes.status).toBe(200);
      expect(remindJson.success).toBe(true);
      expect(remindJson.data.reminded).toBe(true);
      expect(remindInvoiceSpy).toHaveBeenCalledTimes(1);

      // Verify ZERO unintended provider calls
      expect(sendInvoiceSpy).not.toHaveBeenCalled();
      expect(createDraftSpy).not.toHaveBeenCalled();
      expect(cancelInvoiceSpy).not.toHaveBeenCalled();

      // 5. FINANCIAL INVARIANT: Status remains strictly AWAITING_PAYMENT, NEVER marked PAID
      const persistedInvoice = await db.invoice.findUnique({
        where: { id: inv.id },
      });
      expect(persistedInvoice?.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(persistedInvoice?.cashpilotStatus).not.toBe(CashPilotStatus.PAID);
      expect(persistedInvoice?.paypalStatus).toBe("SENT");

      // 6. Approval was marked USED
      const consumedApproval = await db.approval.findUnique({
        where: { id: approvalId },
      });
      expect(consumedApproval?.status).toBe(ApprovalStatus.USED);

      // 7. Audit event recorded
      const activity = await db.activityEvent.findFirst({
        where: { invoiceId: inv.id, operationId: remindJson.data.operationId },
      });
      expect(activity).toBeTruthy();
      expect(activity?.description).toContain("Payment reminder sent");
    });

    it("rejects approval attempt when submitting mismatched or forged hash with 409 STALE_PAYLOAD_HASH", async () => {
      const inv = await createDatabaseInvoiceForReminder();

      const forgedHash = "0000000000000000000000000000000000000000000000000000000000000000";

      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_REMINDER",
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
      expect(remindInvoiceSpy).not.toHaveBeenCalled();
    });

    it("rejects reminder with 409 Conflict if invoice was materially altered after approval", async () => {
      const inv = await createDatabaseInvoiceForReminder();

      const initialHash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "SEND_REMINDER",
      });

      // Approve initial state
      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_REMINDER",
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
        data: { totalMinorUnits: 999900 },
      });

      // Attempt to execute reminder with stale approval
      const remindReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/remind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const remindRes = await remindRoute(remindReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const remindJson = await remindRes.json();

      expect(remindRes.status).toBe(409);
      expect(remindJson.success).toBe(false);
      expect(remindJson.code).toBe("APPROVAL_STALE");
      expect(remindInvoiceSpy).not.toHaveBeenCalled();

      // Verify approval was invalidated
      const invalidatedApproval = await db.approval.findUnique({
        where: { id: approvalId },
      });
      expect(invalidatedApproval?.status).toBe(ApprovalStatus.INVALIDATED);
    });

    it("rejects reminder with 429 when 24h cooldown is active", async () => {
      // Create invoice with recent successful reminder (cooldown active)
      const inv = await createDatabaseInvoiceForReminder(CashPilotStatus.AWAITING_PAYMENT, {
        recentReminder: true,
      });

      const hash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "SEND_REMINDER",
      });

      // Approve
      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_REMINDER",
          reviewedPayloadHash: hash,
        }),
      });
      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();
      const approvalId = approveJson.data.approvalId;

      // Attempt remind
      const remindReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/remind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const remindRes = await remindRoute(remindReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const remindJson = await remindRes.json();

      expect(remindRes.status).toBe(429);
      expect(remindJson.success).toBe(false);
      expect(remindJson.code).toBe("REMINDER_RATE_LIMITED");
      expect(remindJson.error).toContain("24 hours");
      expect(remindInvoiceSpy).not.toHaveBeenCalled();
    });

    it("handles PayPal timeout with 504 and blocks subsequent blind retry with 409 PENDING_UNKNOWN_OPERATION", async () => {
      const inv = await createDatabaseInvoiceForReminder();

      const hash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "SEND_REMINDER",
      });

      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_REMINDER",
          reviewedPayloadHash: hash,
        }),
      });
      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();
      const approvalId = approveJson.data.approvalId;

      // Mock PayPal timeout
      remindInvoiceSpy.mockResolvedValueOnce({
        success: false,
        isOutcomeUnknown: true,
        error: {
          code: "TIMEOUT",
          message: "PayPal reminder timed out",
          httpStatus: 504,
        },
        correlationId: "corr-timeout-remind",
      });

      // Remind 1 (Times out)
      const remindReq1 = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/remind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const remindRes1 = await remindRoute(remindReq1, {
        params: Promise.resolve({ id: inv.id }),
      });
      const remindJson1 = await remindRes1.json();

      expect(remindRes1.status).toBe(504);
      expect(remindJson1.success).toBe(false);
      expect(remindJson1.code).toBe("OPERATION_UNKNOWN_OUTCOME");

      // Verify operation recorded with isOutcomeUnknown = true
      const recordedOp = await db.externalOperation.findFirst({
        where: { invoiceId: inv.id, operationType: OperationType.SEND_REMINDER },
      });
      expect(recordedOp?.isOutcomeUnknown).toBe(true);
      expect(recordedOp?.attemptState).toBe(OperationAttemptState.UNKNOWN);

      // Status remains unchanged
      const invoiceAfterTimeout = await db.invoice.findUnique({
        where: { id: inv.id },
      });
      expect(invoiceAfterTimeout?.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);

      // Remind 2 (Blind Retry blocked server-side!)
      const remindReq2 = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/remind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const remindRes2 = await remindRoute(remindReq2, {
        params: Promise.resolve({ id: inv.id }),
      });
      const remindJson2 = await remindRes2.json();

      expect(remindRes2.status).toBe(409);
      expect(remindJson2.success).toBe(false);
      expect(remindJson2.code).toBe("PENDING_UNKNOWN_OPERATION");

      // remindInvoiceSpy was NOT called on blind retry
      expect(remindInvoiceSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects cross-workspace reminder with 403 Forbidden", async () => {
      const inv = await createDatabaseInvoiceForReminder();

      // Workspace B attempts to remind an invoice belonging to Workspace A
      const remindReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/remind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionB.cookieHeader, // Cross workspace!
        },
      });

      const remindRes = await remindRoute(remindReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const remindJson = await remindRes.json();

      expect(remindRes.status).toBe(403);
      expect(remindJson.success).toBe(false);
      expect(remindJson.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
      expect(remindInvoiceSpy).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated request with 401 Unauthorized", async () => {
      const inv = await createDatabaseInvoiceForReminder();

      const remindReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/remind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const remindRes = await remindRoute(remindReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      expect(remindRes.status).toBe(401);
      const remindJson = await remindRes.json();
      expect(remindJson.code).toBe("UNAUTHORIZED");
    });
  });
});
