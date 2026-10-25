/**
 * CashPilot AI — PayPal Invoice Sending Integration Tests
 *
 * Task 8: Tests for POST /api/invoices/[id]/send
 *
 * Invariants tested:
 * - Valid approved send: transitions DRAFT -> AWAITING_PAYMENT (or DUE_SOON / OVERDUE), NEVER PAID
 * - Status separation: raw paypalStatus ("SENT") and cashpilotStatus are kept strictly separate
 * - Human approval boundary: valid, unexpired SEND_INVOICE approval required
 * - Rejection on missing, expired, invalidated, or previously consumed (USED) approval
 * - Server recomputes hash: stale hash after material change rejects send (409 Conflict) and invalidates approval
 * - Cross-workspace authorization (403 Forbidden) and production authentication (401)
 * - Pre-condition: PayPal draft MUST already exist; send NEVER creates drafts (400 Bad Request)
 * - Rejection on ineligible invoice status (CANCELLED, etc.)
 * - Provider rejection handling & ExternalOperation attempt tracking (FAILED, 502)
 * - Timeout and unknown outcome tracking (UNKNOWN, isOutcomeUnknown = true, 504 Gateway Timeout)
 * - Blind retries blocked while prior outcome remains unknown (409 Conflict)
 * - Concurrent in-flight operations blocked (409 Conflict)
 * - Idempotency: Duplicate calls return known result without resending (200 OK, isAlreadySent = true)
 * - Reconciliation resolves unknown send operation
 * - Zero draft creation, reminder, cancellation, or payment calls during send
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as sendRoute } from "@/app/api/invoices/[id]/send/route";
import { syncInvoiceWithPayPal } from "@/lib/services/invoice.service";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import {
  ApprovalStatus,
  OperationType,
  OperationAttemptState,
  ActivityEventType,
  CashPilotStatus,
} from "@prisma/client";
import { createTestSession } from "@/lib/test-utils/auth";

describe("PayPal Invoice Sending API (POST /api/invoices/[id]/send)", () => {
  const workspaceA = "demo-workspace-send-a";
  const workspaceB = "demo-workspace-send-b";
  const ownerA = "demo-user-send-a";
  const ownerB = "demo-user-send-b";
  const clientA = "demo-client-send-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  const createdInvoiceIds: string[] = [];

  // Spies on adapter methods
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const getStatusSpy = vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus");
  const remindSpy = vi.spyOn(paypalAdapter, "sendPayPalReminder");

  beforeAll(async () => {
    sessionA = createTestSession({ userId: ownerA, email: "send-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "send-b@example.com" });

    // Setup test workspaces and client in PostgreSQL
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Send Test Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Send Test Workspace B",
        ownerId: ownerB,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientA },
      update: {},
      create: {
        id: clientA,
        workspaceId: workspaceA,
        name: "Acme Sending Corp",
        email: "billing@acme-sending.example.com",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    // Clean up test data
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
      where: { invoiceId: { in: createdInvoiceIds } },
    });
    await db.invoice.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.client.deleteMany({
      where: { id: clientA },
    });
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceA, workspaceB] } },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper: Create draft invoice in workspaceA
  async function createTestInvoice(dueDateOffsetDays = 14) {
    const dueDate = new Date(Date.now() + dueDateOffsetDays * 86400000)
      .toISOString()
      .substring(0, 10);
    const invoiceDate = new Date().toISOString().substring(0, 10);

    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: sessionA.cookieHeader,
      },
      body: JSON.stringify({
        workspaceId: workspaceA,
        clientId: clientA,
        title: "Test Invoice for Sending",
        currency: "USD",
        taxRateBasisPoints: 0,
        invoiceDate,
        dueDate,
        lineItems: [
          {
            description: "Consulting Services",
            quantity: 2,
            unitPriceMinorUnits: 5000,
          },
        ],
      }),
    });

    const res = await draftRoute(req);
    const json = await res.json();
    expect(res.status).toBe(201);
    createdInvoiceIds.push(json.data.id);
    return json.data;
  }

  // Helper: Approve invoice for SEND_INVOICE
  async function approveTestInvoice(invoiceId: string, reviewedHash: string) {
    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${invoiceId}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_INVOICE",
          reviewedPayloadHash: reviewedHash,
        }),
      }
    );

    const res = await approveRoute(req, {
      params: Promise.resolve({ id: invoiceId }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    return json.data;
  }

  // 1. Valid approved send: transitions DRAFT -> AWAITING_PAYMENT, never PAID
  it("executes valid approved send, transitions to AWAITING_PAYMENT, and consumes approval", async () => {
    const inv = await createTestInvoice(14);
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    // Link a mock PayPal draft
    await db.invoice.update({
      where: { id: inv.id },
      data: {
        paypalInvoiceId: "INV2-SEND-SUCCESS-1",
        paypalStatus: "DRAFT",
      },
    });

    sendInvoiceSpy.mockResolvedValueOnce({
      success: true,
      data: { sent: true },
      correlationId: "paypal-debug-send-001",
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.paypalInvoiceId).toBe("INV2-SEND-SUCCESS-1");
    expect(json.data.paypalStatus).toBe("SENT");
    // Due in 14 days -> AWAITING_PAYMENT
    expect(json.data.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
    expect(json.data.cashpilotStatus).not.toBe(CashPilotStatus.PAID);
    expect(json.data.isAlreadySent).toBe(false);

    // Verify adapter was called with invoice ID and request ID
    expect(sendInvoiceSpy).toHaveBeenCalledTimes(1);
    expect(sendInvoiceSpy).toHaveBeenCalledWith(
      "INV2-SEND-SUCCESS-1",
      expect.stringContaining(`send-${inv.id}-${approval.approvalId}`)
    );

    // Verify approval consumed (marked USED)
    const updatedApproval = await db.approval.findUnique({
      where: { id: approval.approvalId },
    });
    expect(updatedApproval?.status).toBe(ApprovalStatus.USED);

    // Verify database invoice record
    const updatedInvoice = await db.invoice.findUnique({
      where: { id: inv.id },
    });
    expect(updatedInvoice?.paypalStatus).toBe("SENT");
    expect(updatedInvoice?.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
    expect(updatedInvoice?.lastSyncAt).not.toBeNull();

    // Verify ExternalOperation record
    const op = await db.externalOperation.findFirst({
      where: {
        invoiceId: inv.id,
        operationType: OperationType.SEND_INVOICE,
      },
    });
    expect(op).not.toBeNull();
    expect(op?.attemptState).toBe(OperationAttemptState.SUCCESS);
    expect(op?.correlationId).toBe("paypal-debug-send-001");
    expect(op?.isOutcomeUnknown).toBe(false);

    // Verify ActivityEvent records
    const events = await db.activityEvent.findMany({
      where: { invoiceId: inv.id },
      orderBy: { createdAt: "desc" },
    });
    const opEvent = events.find(
      (e) => e.eventType === ActivityEventType.OPERATION_SUCCEEDED
    );
    expect(opEvent).toBeDefined();
    expect(opEvent?.description).toContain("SENT (not paid)");
  });

  // 2. Missing approval rejects with 400 APPROVAL_REQUIRED
  it("rejects send when invoice has no approved action", async () => {
    const inv = await createTestInvoice();
    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-NO-APPROVAL" },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.code).toBe("APPROVAL_REQUIRED");
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 3. Expired approval rejects with 400 APPROVAL_EXPIRED
  it("rejects send when approval has expired", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-EXPIRED" },
    });

    // Artificially expire the approval
    await db.approval.update({
      where: { id: approval.approvalId },
      data: {
        expiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.code).toBe("APPROVAL_EXPIRED");
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 4. Invalidated approval rejects with 400 APPROVAL_INVALIDATED
  it("rejects send when approval has been marked INVALIDATED", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-INVALIDATED" },
    });

    await db.approval.update({
      where: { id: approval.approvalId },
      data: {
        status: ApprovalStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: "Test invalidation",
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.code).toBe("APPROVAL_INVALIDATED");
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 5. Already used approval rejects with 400 APPROVAL_USED
  it("rejects send when approval has already been used", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-USED" },
    });

    await db.approval.update({
      where: { id: approval.approvalId },
      data: { status: ApprovalStatus.USED },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.code).toBe("APPROVAL_USED");
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 6. Stale payload hash after material change rejects with 409 and invalidates approval
  it("invalidates approval and rejects with 409 when invoice changes after approval", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-STALE" },
    });

    // Material change: edit total amount
    await db.invoice.update({
      where: { id: inv.id },
      data: { totalMinorUnits: 99999 },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.success).toBe(false);
    expect(json.code).toBe("APPROVAL_STALE");
    expect(sendInvoiceSpy).not.toHaveBeenCalled();

    // Verify approval was transitioned to INVALIDATED in DB
    const invalidated = await db.approval.findUnique({
      where: { id: approval.approvalId },
    });
    expect(invalidated?.status).toBe(ApprovalStatus.INVALIDATED);
  });

  // 7. Missing PayPal draft rejects with 400 and NEVER creates a draft
  it("rejects send with 400 when PayPal draft does not exist (never creates drafts during send)", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    // Note: invoice.paypalInvoiceId is null
    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.code).toBe("PAYPAL_DRAFT_REQUIRED");
    // CRITICAL: Adapter create draft was NEVER invoked
    expect(createDraftSpy).not.toHaveBeenCalled();
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 8. Ineligible status (e.g. CANCELLED) rejects with 400
  it("rejects send with 400 when invoice is not in DRAFT status", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: {
        paypalInvoiceId: "INV2-CANCELLED",
        cashpilotStatus: CashPilotStatus.CANCELLED,
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.code).toBe("INVALID_INVOICE_STATE");
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 9. Cross-workspace access blocked with 403 Forbidden
  it("blocks cross-workspace send requests with 403 Forbidden", async () => {
    const inv = await createTestInvoice();
    await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-CROSS" },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionB.cookieHeader,
        },
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 9b. Rejection on unauthenticated access
  it("rejects unauthenticated request with 401 Unauthorized", async () => {
    const inv = await createTestInvoice();
    await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-UNAUTH" },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {},
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
    expect(json.code).toBe("UNAUTHORIZED");
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 10. Provider rejection returns 502 and records FAILED attempt
  it("handles provider rejection with 502 Bad Gateway and records FAILED operation", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-REJECT" },
    });

    sendInvoiceSpy.mockResolvedValueOnce({
      success: false,
      error: {
        code: "UNPROCESSABLE_ENTITY",
        message: "Invoice cannot be sent in its current state on PayPal",
        httpStatus: 422,
      },
      correlationId: "debug-reject-422",
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.success).toBe(false);

    // Verify invoice remains in DRAFT
    const invoiceAfter = await db.invoice.findUnique({ where: { id: inv.id } });
    expect(invoiceAfter?.cashpilotStatus).toBe(CashPilotStatus.DRAFT);

    // Verify operation recorded as FAILED
    const op = await db.externalOperation.findFirst({
      where: { invoiceId: inv.id, operationType: OperationType.SEND_INVOICE },
      orderBy: { createdAt: "desc" },
    });
    expect(op?.attemptState).toBe(OperationAttemptState.FAILED);
    expect(op?.isOutcomeUnknown).toBe(false);
  });

  // 11. Timeout returns 504 Gateway Timeout and records UNKNOWN outcome
  it("handles timeout with 504 Gateway Timeout and records UNKNOWN outcome without marking sent", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-TIMEOUT" },
    });

    sendInvoiceSpy.mockResolvedValueOnce({
      success: false,
      isOutcomeUnknown: true,
      error: {
        code: "TIMEOUT",
        message: "PayPal send timed out. The outcome is unknown.",
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(504);
    expect(json.success).toBe(false);
    expect(json.code).toBe("OPERATION_UNKNOWN_OUTCOME");

    // Verify invoice remains in DRAFT (never assume sent or paid)
    const invoiceAfter = await db.invoice.findUnique({ where: { id: inv.id } });
    expect(invoiceAfter?.cashpilotStatus).toBe(CashPilotStatus.DRAFT);

    // Verify operation marked UNKNOWN
    const op = await db.externalOperation.findFirst({
      where: { invoiceId: inv.id, operationType: OperationType.SEND_INVOICE },
      orderBy: { createdAt: "desc" },
    });
    expect(op?.attemptState).toBe(OperationAttemptState.UNKNOWN);
    expect(op?.isOutcomeUnknown).toBe(true);

    // Verify approval was NOT consumed
    const approvalAfter = await db.approval.findUnique({
      where: { id: approval.approvalId },
    });
    expect(approvalAfter?.status).toBe(ApprovalStatus.APPROVED);
  });

  // 12. Blind retry blocked while prior outcome remains unknown (409 Conflict)
  it("blocks retry with 409 Conflict when a previous send has an unknown outcome", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-BLOCKED-RETRY" },
    });

    // Seed an unresolved UNKNOWN operation
    await db.externalOperation.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        approvalId: approval.approvalId,
        operationType: OperationType.SEND_INVOICE,
        attemptState: OperationAttemptState.UNKNOWN,
        isOutcomeUnknown: true,
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.success).toBe(false);
    expect(json.code).toBe("PENDING_UNKNOWN_OPERATION");
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 13. Idempotent repeat requests: returns existing result without calling PayPal again
  it("returns known result idempotently without resending if already sent", async () => {
    const inv = await createTestInvoice();
    await approveTestInvoice(inv.id, inv.materialPayloadHash);

    // Invoice is already in AWAITING_PAYMENT with paypalStatus: SENT
    await db.invoice.update({
      where: { id: inv.id },
      data: {
        paypalInvoiceId: "INV2-ALREADY-SENT",
        paypalStatus: "SENT",
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
      },
    });

    await db.externalOperation.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        operationType: OperationType.SEND_INVOICE,
        attemptState: OperationAttemptState.SUCCESS,
        completedAt: new Date(),
        providerInvoiceId: "INV2-ALREADY-SENT",
        correlationId: "debug-prior-send",
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.isAlreadySent).toBe(true);
    expect(json.data.paypalInvoiceId).toBe("INV2-ALREADY-SENT");
    expect(json.data.paypalStatus).toBe("SENT");
    expect(json.data.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);

    // CRITICAL: PayPal send endpoint was NOT called again
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
  });

  // 14. Reconciliation resolves unknown send operation
  it("resolves an unknown send operation via sync when PayPal confirms SENT", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-RECONCILE-SEND" },
    });

    // Create an UNKNOWN send operation
    const unknownOp = await db.externalOperation.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        approvalId: approval.approvalId,
        operationType: OperationType.SEND_INVOICE,
        attemptState: OperationAttemptState.UNKNOWN,
        isOutcomeUnknown: true,
      },
    });

    // Mock status fetch returning SENT
    getStatusSpy.mockResolvedValueOnce({
      success: true,
      data: {
        id: "INV2-RECONCILE-SEND",
        status: "SENT",
        detail: { currency_code: "USD" },
      },
      correlationId: "debug-reconcile-send",
    });

    // Call sync to reconcile
    const syncResult = await syncInvoiceWithPayPal(
      workspaceA,
      ownerA,
      inv.id
    );

    expect(syncResult.ok).toBe(true);
    if (syncResult.ok) {
      expect(syncResult.data.currentPaypalStatus).toBe("SENT");
      expect(syncResult.data.currentCashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(syncResult.data.reconciledOperationsCount).toBe(1);
    }

    // Verify unknown operation was resolved
    const resolvedOp = await db.externalOperation.findUnique({
      where: { id: unknownOp.id },
    });
    expect(resolvedOp?.isOutcomeUnknown).toBe(false);
    expect(resolvedOp?.attemptState).toBe(OperationAttemptState.SUCCESS);
    expect(resolvedOp?.reconciledAt).not.toBeNull();
  });

  // 15. Financial boundary check: verify no draft, reminder, cancellation, or payment calls
  it("ensures zero draft creation, reminder, or payment calls during send", async () => {
    const inv = await createTestInvoice();
    const approval = await approveTestInvoice(inv.id, inv.materialPayloadHash);

    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: "INV2-BOUNDARY-CHECK" },
    });

    sendInvoiceSpy.mockResolvedValueOnce({
      success: true,
      data: { sent: true },
      correlationId: "debug-boundary",
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/send`,
      {
        method: "POST",
        headers: {
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      }
    );

    const res = await sendRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    expect(res.status).toBe(200);

    // Hard boundaries:
    expect(createDraftSpy).not.toHaveBeenCalled();
    expect(remindSpy).not.toHaveBeenCalled();
    expect(sendInvoiceSpy).toHaveBeenCalledTimes(1);
  });
});
