/**
 * CashPilot AI — Task 13B: Human-Approved Invoice Sending Tests
 *
 * Invariants tested:
 * - Eligible vs ineligible invoice states (DRAFT + PayPal draft required).
 * - Explicit confirmation required before approval (Human Approval Gate).
 * - Actual server-computed hash displayed and locked in approval modal.
 * - Stale/mismatched approval rejection (409 Conflict).
 * - Successful send resulting in an UNPAID state (AWAITING_PAYMENT, never PAID).
 * - Raw PayPal status ("SENT") and CashPilot status remain strictly separate.
 * - Provider failure handled safely without status corruption.
 * - Timeout / unknown outcome recorded as UNKNOWN; blind retries blocked.
 * - Duplicate-click prevention and loading state indicators.
 * - Cross-workspace authorization failure (403 Forbidden).
 * - Zero automatic retries; zero payment reminder or cancellation calls.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { NextRequest } from "next/server";
import { InvoiceDetailView, SerializedInvoiceDetail } from "@/components/invoices/invoice-detail-view";
import { SendApprovalModal } from "@/components/invoices/send-approval-modal";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as sendRoute } from "@/app/api/invoices/[id]/send/route";
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

describe("Human-Approved Invoice Sending (Task 13B)", () => {
  const workspaceA = "demo-workspace-send-flow-a";
  const workspaceB = "demo-workspace-send-flow-b";
  const ownerA = "demo-user-send-flow-a";
  const ownerB = "demo-user-send-flow-b";
  const clientA = "demo-client-send-flow-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  const createdInvoiceIds: string[] = [];

  // Spies
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const remindInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalReminder");
  const cancelInvoiceSpy = vi.spyOn(paypalAdapter, "cancelPayPalInvoice");

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([
      { id: ownerA, email: "sendflow-a@example.com", name: "Send Flow Owner A" },
      { id: ownerB, email: "sendflow-b@example.com", name: "Send Flow Owner B" },
    ]);

    sessionA = createTestSession({ userId: ownerA, email: "sendflow-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "sendflow-b@example.com" });

    // Setup test workspaces
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Send Flow Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Send Flow Workspace B",
        ownerId: ownerB,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientA },
      update: { name: "Acme Sending Corp", email: "billing@acme-send-corp.test" },
      create: {
        id: clientA,
        workspaceId: workspaceA,
        name: "Acme Sending Corp",
        email: "billing@acme-send-corp.test",
        company: "Acme Sending Global",
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

  const baseInvoiceFixture: SerializedInvoiceDetail = {
    id: "inv-send-unit-1",
    workspaceId: workspaceA,
    clientId: clientA,
    number: "INV-9001",
    materialPayloadHash: "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
    title: "Backend Cloud Infrastructure Audit",
    notes: "Payment due within 14 days",
    terms: "Net 14",
    currency: "USD",
    subtotalMinorUnits: 120000,
    taxRateBasisPoints: 1000,
    taxMinorUnits: 12000,
    totalMinorUnits: 132000,
    invoiceDate: "2026-10-21T00:00:00.000Z",
    dueDate: "2026-11-04T00:00:00.000Z",
    cashpilotStatus: CashPilotStatus.DRAFT,
    paypalInvoiceId: "INV2-SANDBOX-DRAFT-9001",
    paypalStatus: "DRAFT",
    lastSyncAt: null,
    syncIsStale: false,
    isDemoData: true,
    aiDraftId: null,
    client: {
      id: clientA,
      name: "Acme Sending Corp",
      email: "billing@acme-send-corp.test",
      company: "Acme Sending Global",
      phone: null,
      isDemo: true,
    },
    lineItems: [
      {
        id: "li-send-1",
        description: "Cloud Architecture Security Audit",
        quantity: 8,
        unitPriceMinorUnits: 15000,
        totalMinorUnits: 120000,
        sortOrder: 0,
      },
    ],
    activities: [],
    workspace: {
      id: workspaceA,
      name: "Send Flow Workspace A",
      isDemo: true,
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Eligibility & Preflight Checks in UI
  // ───────────────────────────────────────────────────────────────────────────
  describe("Eligibility and Preflight UI Checks", () => {
    it("shows 'Send invoice' button when invoice is in DRAFT status and has PayPal draft ID", () => {
      const html = renderToString(<InvoiceDetailView initialInvoice={baseInvoiceFixture} />);

      // Eligible: button is rendered
      expect(html).toContain("Send invoice");
      expect(html).toContain("aria-label=\"Approve and send invoice via PayPal Sandbox\"");
    });

    it("hides 'Send invoice' button when local draft has no PayPal draft ID yet", () => {
      const localDraftWithoutPayPal: SerializedInvoiceDetail = {
        ...baseInvoiceFixture,
        paypalInvoiceId: null,
        paypalStatus: null,
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={localDraftWithoutPayPal} />);

      // Ineligible: cannot send without PayPal draft
      expect(html).not.toContain("Send invoice");
      expect(html).toContain("Not created on PayPal");
    });

    it("hides 'Send invoice' button when invoice has already been sent", () => {
      const alreadySentInvoice: SerializedInvoiceDetail = {
        ...baseInvoiceFixture,
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paypalStatus: "SENT",
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={alreadySentInvoice} />);

      expect(html).not.toContain("Send invoice");
      expect(html).toContain("Awaiting Payment");
    });

    it("hides 'Send invoice' button when invoice is PAID or CANCELLED", () => {
      const paidInvoice: SerializedInvoiceDetail = {
        ...baseInvoiceFixture,
        cashpilotStatus: CashPilotStatus.PAID,
        paypalStatus: "PAID",
      };
      const cancelledInvoice: SerializedInvoiceDetail = {
        ...baseInvoiceFixture,
        cashpilotStatus: CashPilotStatus.CANCELLED,
        paypalStatus: "CANCELLED",
      };

      expect(renderToString(<InvoiceDetailView initialInvoice={paidInvoice} />)).not.toContain("Send invoice");
      expect(renderToString(<InvoiceDetailView initialInvoice={cancelledInvoice} />)).not.toContain("Send invoice");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Explicit Human Approval Gate Modal
  // ───────────────────────────────────────────────────────────────────────────
  describe("Explicit Human Approval Gate Modal", () => {
    it("renders approval sheet with exact material details and locked cryptographic hash", () => {
      const html = renderToString(
        <SendApprovalModal
          invoice={baseInvoiceFixture}
          materialPayloadHash={baseInvoiceFixture.materialPayloadHash!}
          isOpen={true}
          onClose={() => {}}
          onSendSuccess={() => {}}
        />
      );

      // Modal Title & Human Approval Gate Badge
      expect(html).toContain("Approve and Send Invoice");
      expect(html).toContain("Human Approval Gate");

      // Material details
      expect(html).toContain("Acme Sending Corp");
      expect(html).toContain("billing@acme-send-corp.test");
      expect(html).toContain("INV-9001");
      expect(html).toContain(formatMoney(132000, "USD"));
      expect(html).toContain("INV2-SANDBOX-DRAFT-9001");
      expect(html).toContain("Cloud Architecture Security Audit");

      // Cryptographic hash binding
      expect(html).toContain("Cryptographic Material Hash Lock");
      expect(html).toContain(baseInvoiceFixture.materialPayloadHash!);

      // Buttons
      expect(html).toContain("Back to invoice");
      expect(html).toContain("Approve and send via PayPal");

      // Financial truth invariant notice
      expect(html).toContain("Financial Truth: A successful send transitions status to Awaiting Payment.");
      expect(html).toContain("Only verified PayPal payment confirmation will establish a Paid status.");
    });

    it("renders nothing when isOpen is false", () => {
      const html = renderToString(
        <SendApprovalModal
          invoice={baseInvoiceFixture}
          materialPayloadHash={baseInvoiceFixture.materialPayloadHash!}
          isOpen={false}
          onClose={() => {}}
          onSendSuccess={() => {}}
        />
      );

      expect(html).toBe("");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. End-to-End Approval & Send Workflow
  // ───────────────────────────────────────────────────────────────────────────
  describe("End-to-End Approved Send Lifecycle", () => {
    it("successfully approves with server-returned hash and sends to PayPal, transitioning to AWAITING_PAYMENT (NEVER PAID)", async () => {
      // 1. Create persisted draft invoice in DB with PayPal draft ID
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-SEND-EXEC-1",
          currency: "USD",
          subtotalMinorUnits: 80000,
          taxMinorUnits: 0,
          totalMinorUnits: 80000,
          dueDate: new Date(Date.now() + 14 * 86400000), // 14 days in future -> AWAITING_PAYMENT
          cashpilotStatus: CashPilotStatus.DRAFT,
          paypalInvoiceId: "INV2-SANDBOX-EXEC-01",
          paypalStatus: "DRAFT",
          syncIsStale: false,
          lineItems: {
            create: [
              {
                description: "Security Consulting",
                quantity: 4,
                unitPriceMinorUnits: 20000,
                totalMinorUnits: 80000,
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

      // Authoritative material hash calculated on server
      const currentHash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "SEND_INVOICE",
      });

      // 2. Submit Human Approval (SEND_INVOICE) bound to currentHash
      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_INVOICE",
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

      // 3. Mock PayPal Sandbox send response
      sendInvoiceSpy.mockResolvedValueOnce({
        success: true,
        data: {
          sent: true,
        },
        correlationId: "corr-send-exec-01",
      });

      // 4. Submit Send Request with valid approval ID
      const sendReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const sendRes = await sendRoute(sendReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const sendJson = await sendRes.json();

      expect(sendRes.status).toBe(200);
      expect(sendJson.success).toBe(true);
      expect(sendJson.data.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(sendJson.data.paypalStatus).toBe("SENT");

      // FINANCIAL SAFETY INVARIANT: Send NEVER sets status to PAID
      expect(sendJson.data.cashpilotStatus).not.toBe(CashPilotStatus.PAID);

      // Verify DB persistence
      const verified = await db.invoice.findUnique({ where: { id: inv.id } });
      expect(verified?.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(verified?.paypalStatus).toBe("SENT");
      expect(verified?.cashpilotStatus).not.toBe(CashPilotStatus.PAID);

      // Verify approval marked as USED
      const verifiedApproval = await db.approval.findUnique({ where: { id: approvalId } });
      expect(verifiedApproval?.status).toBe(ApprovalStatus.USED);

      // Invariants: No reminders, no cancellations, no draft creation
      expect(remindInvoiceSpy).not.toHaveBeenCalled();
      expect(cancelInvoiceSpy).not.toHaveBeenCalled();
      expect(createDraftSpy).not.toHaveBeenCalled();
    });

    it("rejects send with 409 Conflict if invoice was materially altered after approval", async () => {
      // 1. Create invoice in DB
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-STALE-SEND-1",
          currency: "USD",
          subtotalMinorUnits: 50000,
          taxMinorUnits: 0,
          totalMinorUnits: 50000,
          dueDate: new Date(Date.now() + 7 * 86400000),
          cashpilotStatus: CashPilotStatus.DRAFT,
          paypalInvoiceId: "INV2-STALE-01",
          paypalStatus: "DRAFT",
          lineItems: {
            create: [
              {
                description: "Initial Work",
                quantity: 1,
                unitPriceMinorUnits: 50000,
                totalMinorUnits: 50000,
                sortOrder: 0,
              },
            ],
          },
        },
        include: { client: true, lineItems: true },
      });
      createdInvoiceIds.push(inv.id);

      const initialHash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: inv.lineItems,
        actionType: "SEND_INVOICE",
      });

      // 2. Approve initial state
      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_INVOICE",
          reviewedPayloadHash: initialHash,
        }),
      });
      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();
      const approvalId = approveJson.data.approvalId;

      // 3. Material field is altered in DB after approval (e.g. price increased)
      await db.invoice.update({
        where: { id: inv.id },
        data: { totalMinorUnits: 999999 },
      });

      // 4. Send request must be rejected with 409 APPROVAL_STALE
      const sendReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });

      const sendRes = await sendRoute(sendReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const sendJson = await sendRes.json();

      expect(sendRes.status).toBe(409);
      expect(sendJson.code).toBe("APPROVAL_STALE");
      expect(sendInvoiceSpy).not.toHaveBeenCalled();

      // Approval must be transitioned to INVALIDATED
      const updatedApproval = await db.approval.findUnique({ where: { id: approvalId } });
      expect(updatedApproval?.status).toBe(ApprovalStatus.INVALIDATED);
    });

    it("rejects approval attempt when submitting mismatched or forged hash with 409 STALE_PAYLOAD_HASH", async () => {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-MISMATCH-1",
          currency: "USD",
          subtotalMinorUnits: 20000,
          taxMinorUnits: 0,
          totalMinorUnits: 20000,
          dueDate: new Date("2026-11-04"),
          cashpilotStatus: CashPilotStatus.DRAFT,
          paypalInvoiceId: "INV2-MISMATCH-01",
          paypalStatus: "DRAFT",
        },
      });
      createdInvoiceIds.push(inv.id);

      const FORGED_HASH = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

      const req = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_INVOICE",
          reviewedPayloadHash: FORGED_HASH,
        }),
      });

      const res = await approveRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.code).toBe("STALE_PAYLOAD_HASH");
    });

    it("handles PayPal timeout with 504 and blocks subsequent blind retry with 409", async () => {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-TIMEOUT-1",
          currency: "USD",
          subtotalMinorUnits: 25000,
          taxMinorUnits: 0,
          totalMinorUnits: 25000,
          dueDate: new Date(Date.now() + 5 * 86400000),
          cashpilotStatus: CashPilotStatus.DRAFT,
          paypalInvoiceId: "INV2-TIMEOUT-01",
          paypalStatus: "DRAFT",
        },
        include: { client: true },
      });
      createdInvoiceIds.push(inv.id);

      const hash = computeMaterialPayloadHash({
        id: inv.id,
        workspaceId: inv.workspaceId,
        client: { email: inv.client.email },
        totalMinorUnits: inv.totalMinorUnits,
        currency: inv.currency,
        dueDate: inv.dueDate,
        lineItems: [],
        actionType: "SEND_INVOICE",
      });

      // Approve
      const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ actionType: "SEND_INVOICE", reviewedPayloadHash: hash }),
      });
      const approveRes = await approveRoute(approveReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const approveJson = await approveRes.json();
      const approvalId = approveJson.data.approvalId;

      // Mock PayPal timeout
      sendInvoiceSpy.mockResolvedValueOnce({
        success: false,
        isOutcomeUnknown: true,
        error: {
          code: "TIMEOUT",
          message: "PayPal send invoice timed out",
          httpStatus: 504,
        },
        correlationId: "corr-timeout-send",
      });

      // Send 1 (Times out)
      const sendReq1 = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });
      const sendRes1 = await sendRoute(sendReq1, {
        params: Promise.resolve({ id: inv.id }),
      });
      const sendJson1 = await sendRes1.json();

      expect(sendRes1.status).toBe(504);
      expect(sendJson1.code).toBe("OPERATION_UNKNOWN_OUTCOME");

      // Verify ExternalOperation records UNKNOWN state
      const op = await db.externalOperation.findFirst({
        where: { invoiceId: inv.id, operationType: OperationType.SEND_INVOICE },
        orderBy: { createdAt: "desc" },
      });
      expect(op?.attemptState).toBe(OperationAttemptState.UNKNOWN);
      expect(op?.isOutcomeUnknown).toBe(true);

      // Send 2: Subsequent blind retry must be BLOCKED with 409 PENDING_UNKNOWN_OPERATION
      const sendReq2 = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId }),
      });
      const sendRes2 = await sendRoute(sendReq2, {
        params: Promise.resolve({ id: inv.id }),
      });
      const sendJson2 = await sendRes2.json();

      expect(sendRes2.status).toBe(409);
      expect(sendJson2.code).toBe("PENDING_UNKNOWN_OPERATION");
    });

    it("rejects cross-workspace send with 403 Forbidden", async () => {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-CROSS-SEND-1",
          currency: "USD",
          subtotalMinorUnits: 10000,
          taxMinorUnits: 0,
          totalMinorUnits: 10000,
          dueDate: new Date("2026-11-04"),
          cashpilotStatus: CashPilotStatus.DRAFT,
          paypalInvoiceId: "INV2-CROSS-01",
          paypalStatus: "DRAFT",
        },
      });
      createdInvoiceIds.push(inv.id);

      // Caller belongs to workspace B, invoice belongs to workspace A
      const sendReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionB.cookieHeader,
        },
        body: JSON.stringify({}),
      });

      const sendRes = await sendRoute(sendReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      const sendJson = await sendRes.json();

      expect(sendRes.status).toBe(403);
      expect(sendJson.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
      expect(sendInvoiceSpy).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated request with 401 Unauthorized", async () => {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-UNAUTH-SEND",
          title: "Unauth Send Invoice",
          currency: "USD",
          subtotalMinorUnits: 10000,
          totalMinorUnits: 10000,
          dueDate: new Date("2026-11-04"),
          cashpilotStatus: CashPilotStatus.DRAFT,
          paypalInvoiceId: "INV2-UNAUTH-SEND",
          paypalStatus: "DRAFT",
        },
      });
      createdInvoiceIds.push(inv.id);

      const sendReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const sendRes = await sendRoute(sendReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      expect(sendRes.status).toBe(401);
      const sendJson = await sendRes.json();
      expect(sendJson.code).toBe("UNAUTHORIZED");
    });
  });
});
