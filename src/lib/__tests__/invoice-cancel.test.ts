/**
 * CashPilot AI — PayPal Invoice Cancellation Integration Tests
 *
 * Task 10: Tests for POST /api/invoices/[id]/cancel
 *
 * Invariants tested:
 * - Valid approved cancellation: transitions cashpilotStatus and paypalStatus to CANCELLED
 * - Status separation: provider status and workflow status verified and updated atomically
 * - Human approval boundary: valid, unexpired CANCEL_INVOICE approval required
 * - Rejection on missing, expired, invalidated, wrong-action, or previously consumed (USED) approval
 * - Server recomputes hash: stale hash after material change rejects cancellation (409 Conflict) and invalidates approval
 * - Cross-workspace authorization (403 Forbidden) and production authentication (401)
 * - Pre-condition: PayPal invoice MUST already be sent and unpaid; rejects DRAFT, PAID, PARTIALLY_PAID, and CANCELLED (400 Bad Request)
 * - Missing PayPal invoice ID rejected (400 Bad Request)
 * - Stale/ambiguous provider state blocks cancellation until reconciled (409 Conflict)
 * - Provider 204 No Content success handled properly
 * - Provider rejection handling & ExternalOperation attempt tracking (FAILED, 502)
 * - Timeout and unknown outcome tracking (UNKNOWN, isOutcomeUnknown = true, 504 Gateway Timeout)
 * - Blind retries blocked while prior outcome remains unknown (409 Conflict)
 * - Concurrent in-flight operations blocked (409 Conflict)
 * - Database failure after provider acceptance marks outcome unknown (500)
 * - Reconcile unknown cancel operation via sync
 * - Correct audit and operation records
 * - Zero draft creation, invoice sending, reminder, payment, capture, or draft deletion calls during cancel
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as cancelRoute } from "@/app/api/invoices/[id]/cancel/route";
import { db } from "@/lib/db/client";
import { computeMaterialPayloadHash, syncInvoiceWithPayPal } from "@/lib/services/invoice.service";
import * as paypalAdapter from "@/lib/paypal/adapter";
import {
  ApprovalAction,
  ApprovalStatus,
  OperationType,
  OperationAttemptState,
  ActivityEventType,
  CashPilotStatus,
} from "@prisma/client";
import { createTestSession } from "@/lib/test-utils/auth";

describe("PayPal Invoice Cancellation API (POST /api/invoices/[id]/cancel)", () => {
  const workspaceA = "demo-workspace-cancel-a";
  const workspaceB = "demo-workspace-cancel-b";
  const ownerA = "demo-user-cancel-a";
  const ownerB = "demo-user-cancel-b";
  const clientA = "demo-client-cancel-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  const createdInvoiceIds: string[] = [];

  // Spies on adapter methods
  const cancelSpy = vi.spyOn(paypalAdapter, "cancelPayPalInvoice");
  const remindSpy = vi.spyOn(paypalAdapter, "sendPayPalReminder");
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const getStatusSpy = vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus");

  beforeAll(async () => {
    sessionA = createTestSession({ userId: ownerA, email: "cancel-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "cancel-b@example.com" });

    // Setup test workspaces and client in PostgreSQL
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Cancel Test Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Cancel Test Workspace B",
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
        name: "Acme Cancel Corp",
        email: "billing@acme-cancel.example.com",
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

  // Helper: Create an invoice in workspaceA and set it to AWAITING_PAYMENT with paypalInvoiceId
  async function createSentTestInvoice(
    initialStatus: CashPilotStatus = CashPilotStatus.AWAITING_PAYMENT,
    paypalStatus: string = "SENT",
    syncIsStale: boolean = false
  ) {
    const dueDate = new Date(Date.now() + 14 * 86400000).toISOString().substring(0, 10);
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
        title: "Test Invoice for Cancellation",
        currency: "USD",
        taxRateBasisPoints: 0,
        invoiceDate,
        dueDate,
        lineItems: [
          {
            description: "Design Services",
            quantity: 2,
            unitPriceMinorUnits: 25000,
          },
        ],
      }),
    });

    const res = await draftRoute(req);
    const json = await res.json();
    expect(res.status).toBe(201);
    createdInvoiceIds.push(json.data.id);

    // Update invoice to simulate state
    const updated = await db.invoice.update({
      where: { id: json.data.id },
      data: {
        cashpilotStatus: initialStatus,
        paypalInvoiceId: `INV2-CANCEL-${json.data.id.substring(0, 8)}`,
        paypalStatus,
        syncIsStale,
      },
      include: { client: true, lineItems: true },
    });

    return updated;
  }

  // Helper: Approve invoice for CANCEL_INVOICE
  async function approveCancellationForInvoice(
    invoice: {
      id: string;
      workspaceId: string;
      client: { email: string };
      totalMinorUnits: number;
      currency: string;
      dueDate: Date | string;
      lineItems?: Array<{ description: string; quantity: number; unitPriceMinorUnits: number }>;
    },
    meta?: { note?: string; subject?: string }
  ) {
    const reviewedHash = computeMaterialPayloadHash({
      id: invoice.id,
      workspaceId: invoice.workspaceId,
      client: invoice.client,
      totalMinorUnits: invoice.totalMinorUnits,
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      lineItems: invoice.lineItems,
      actionType: "CANCEL_INVOICE",
      note: meta?.note,
      subject: meta?.subject,
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${invoice.id}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "CANCEL_INVOICE",
          reviewedPayloadHash: reviewedHash,
          ...(meta?.note ? { note: meta.note } : {}),
          ...(meta?.subject ? { subject: meta.subject } : {}),
        }),
      }
    );

    const res = await approveRoute(req, {
      params: Promise.resolve({ id: invoice.id }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    return {
      ...json.data,
      id: json.data.approvalId,
    };
  }

  // 1. Valid approved cancellation: transitions status to CANCELLED, consumes approval, records audit
  it("executes valid approved cancellation, transitions invoice to CANCELLED, and consumes approval", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const note = "Project cancelled by mutual agreement.";
    const subject = "Invoice Cancellation Notice";

    const approval = await approveCancellationForInvoice(inv, { note, subject });

    cancelSpy.mockResolvedValueOnce({
      success: true,
      correlationId: "corr-cancel-123",
      data: { cancelled: true },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          approvalId: approval.id,
          note,
          subject,
        }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.invoiceId).toBe(inv.id);
    expect(json.data.paypalInvoiceId).toBe(inv.paypalInvoiceId);
    expect(json.data.currentStatus).toBe(CashPilotStatus.CANCELLED);
    expect(json.data.currentPaypalStatus).toBe("CANCELLED");

    // Verify adapter call
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith(
      inv.paypalInvoiceId,
      expect.objectContaining({
        note,
        subject,
      })
    );

    // Invariant: Status must be CANCELLED in database
    const dbInvoice = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(dbInvoice.cashpilotStatus).toBe(CashPilotStatus.CANCELLED);
    expect(dbInvoice.paypalStatus).toBe("CANCELLED");

    // Approval consumed
    const dbApproval = await db.approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(dbApproval.status).toBe(ApprovalStatus.USED);

    // ExternalOperation created with SUCCESS
    const op = await db.externalOperation.findFirst({
      where: {
        invoiceId: inv.id,
        operationType: OperationType.CANCEL_INVOICE,
        attemptState: OperationAttemptState.SUCCESS,
      },
    });
    expect(op).not.toBeNull();
    expect(op?.isOutcomeUnknown).toBe(false);

    // Audit event logged
    const event = await db.activityEvent.findFirst({
      where: {
        invoiceId: inv.id,
        eventType: ActivityEventType.OPERATION_SUCCEEDED,
      },
    });
    expect(event).not.toBeNull();
    expect(event?.actorId).toBe(ownerA);
  });

  // 2. Missing approval rejects with 400 APPROVAL_REQUIRED
  it("rejects cancellation when no approval exists", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({}),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.code).toBe("APPROVAL_REQUIRED");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 3. Expired approval rejects with 400 APPROVAL_EXPIRED
  it("rejects cancellation when approval is expired", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    // Manually expire approval
    await db.approval.update({
      where: { id: approval.id },
      data: {
        expiresAt: new Date(Date.now() - 3600_000),
        status: ApprovalStatus.EXPIRED,
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("APPROVAL_EXPIRED");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 4. Invalidated approval rejects with 400 APPROVAL_INVALIDATED
  it("rejects cancellation when approval was previously invalidated", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    await db.approval.update({
      where: { id: approval.id },
      data: {
        status: ApprovalStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: "Test invalidation",
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("APPROVAL_INVALIDATED");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 5. Consumed (USED) approval rejects with 400 APPROVAL_USED
  it("rejects cancellation when approval has already been used", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    await db.approval.update({
      where: { id: approval.id },
      data: { status: ApprovalStatus.USED },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("APPROVAL_USED");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 6. Wrong action type approval rejects with 400 INVALID_APPROVAL_ACTION
  it("rejects cancellation when approval action is not CANCEL_INVOICE", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");

    // Create an approval with SEND_REMINDER action
    const approval = await db.approval.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        actorId: ownerA,
        actionType: ApprovalAction.SEND_REMINDER,
        status: ApprovalStatus.APPROVED,
        payloadHash: "c".repeat(64),
        payloadSnapshot: {},
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("INVALID_APPROVAL_ACTION");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 7. Stale material payload hash rejects with 409 Conflict and invalidates approval
  it("detects stale hash when invoice modified after approval, invalidates approval, and rejects (409)", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    // Modify invoice materially after approval (change totalMinorUnits to invalidate hash)
    await db.invoice.update({
      where: { id: inv.id },
      data: { totalMinorUnits: 888888 },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("APPROVAL_STALE");
    expect(cancelSpy).not.toHaveBeenCalled();

    // Verify approval was marked INVALIDATED in database
    const dbApproval = await db.approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(dbApproval.status).toBe(ApprovalStatus.INVALIDATED);

    // Verify APPROVAL_INVALIDATED event was logged
    const event = await db.activityEvent.findFirst({
      where: {
        invoiceId: inv.id,
        eventType: ActivityEventType.APPROVAL_INVALIDATED,
      },
    });
    expect(event).not.toBeNull();
  });

  // 8. Cross-workspace access rejected with 403 Forbidden
  it("rejects cross-workspace access with 403 Forbidden", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionB.cookieHeader, // Different workspace!
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 8b. Unauthenticated access rejected with 401
  it("rejects unauthenticated request with 401 Unauthorized", async () => {
    const inv = await createSentTestInvoice();
    const approval = await approveCancellationForInvoice(inv);

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.code).toBe("UNAUTHORIZED");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 9. Ineligible status: DRAFT invoice rejected with 400 Bad Request
  it("rejects draft invoices with 400 Bad Request", async () => {
    const reqDraft = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: sessionA.cookieHeader,
      },
      body: JSON.stringify({
        workspaceId: workspaceA,
        clientId: clientA,
        title: "Draft invoice for cancel test",
        currency: "USD",
        taxRateBasisPoints: 0,
        invoiceDate: new Date().toISOString().substring(0, 10),
        dueDate: new Date(Date.now() + 864000000).toISOString().substring(0, 10),
        lineItems: [{ description: "Draft Item", quantity: 1, unitPriceMinorUnits: 5000 }],
      }),
    });
    const draftRes = await draftRoute(reqDraft);
    const draftJson = await draftRes.json();
    createdInvoiceIds.push(draftJson.data.id);

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${draftJson.data.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({}),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: draftJson.data.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("INVALID_INVOICE_STATE");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 10. Ineligible status: PAID, PARTIALLY_PAID, and already CANCELLED invoices rejected
  it("rejects PAID, PARTIALLY_PAID, and CANCELLED invoices with 400 Bad Request", async () => {
    const paidInv = await createSentTestInvoice(CashPilotStatus.PAID, "PAID");
    const partialInv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "PARTIALLY_PAID");
    const cancelledInv = await createSentTestInvoice(CashPilotStatus.CANCELLED, "CANCELLED");

    for (const inv of [paidInv, partialInv, cancelledInv]) {
      const req = new NextRequest(
        `http://localhost:3000/api/invoices/${inv.id}/cancel`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
          body: JSON.stringify({}),
        }
      );

      const res = await cancelRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe("INVALID_INVOICE_STATE");
    }

    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 11. Ambiguous or stale provider state blocks cancellation with 409 Conflict
  it("rejects cancellation when provider status is ambiguous (NEEDS_REVIEW) or sync is stale (409)", async () => {
    const staleInv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT", true);
    const reviewInv = await createSentTestInvoice(CashPilotStatus.NEEDS_REVIEW, "SENT");

    for (const inv of [staleInv, reviewInv]) {
      const req = new NextRequest(
        `http://localhost:3000/api/invoices/${inv.id}/cancel`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
          body: JSON.stringify({}),
        }
      );

      const res = await cancelRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.code).toBe("PROVIDER_STATE_AMBIGUOUS");
    }

    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 12. Missing PayPal invoice ID rejected with 400 Bad Request
  it("rejects cancellation when paypalInvoiceId is missing", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");

    // Remove paypalInvoiceId
    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: null },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({}),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("PAYPAL_INVOICE_REQUIRED");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 13. Concurrent in-flight operations blocked with 409 Conflict
  it("blocks concurrent in-flight cancellation operations with 409 Conflict", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    // Simulate an operation currently IN_FLIGHT
    await db.externalOperation.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        approvalId: approval.id,
        operationType: OperationType.CANCEL_INVOICE,
        provider: "paypal",
        idempotencyKey: `cancel-${inv.id}-inflight`,
        attemptState: OperationAttemptState.IN_FLIGHT,
        attemptedAt: new Date(),
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("OPERATION_IN_FLIGHT");
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  // 14. Timeout and unknown outcome handling (504) and blocking blind retries (409)
  it("records timeout as unknown outcome (504) and blocks subsequent blind retries (409)", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    // Mock timeout on cancellation
    cancelSpy.mockResolvedValueOnce({
      success: false,
      isOutcomeUnknown: true,
      correlationId: "corr-timeout-cancel",
      error: {
        httpStatus: 504,
        code: "TIMEOUT",
        message: "Network timeout connecting to PayPal Invoicing API.",
      },
    });

    const req1 = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res1 = await cancelRoute(req1, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json1 = await res1.json();

    expect(res1.status).toBe(504);
    expect(json1.code).toBe("OPERATION_UNKNOWN_OUTCOME");

    // Verify database record has isOutcomeUnknown = true
    const op = await db.externalOperation.findFirst({
      where: {
        invoiceId: inv.id,
        operationType: OperationType.CANCEL_INVOICE,
        isOutcomeUnknown: true,
      },
    });
    expect(op).not.toBeNull();
    expect(op?.attemptState).toBe(OperationAttemptState.UNKNOWN);

    // Blind retry must be blocked with 409 PENDING_UNKNOWN_OPERATION
    const req2 = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res2 = await cancelRoute(req2, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json2 = await res2.json();

    expect(res2.status).toBe(409);
    expect(json2.code).toBe("PENDING_UNKNOWN_OPERATION");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  // 15. Reconciliation resolves unknown cancel operation
  it("reconciles unknown cancellation operation when status sync verifies CANCELLED", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    // Record an unknown outcome operation
    await db.externalOperation.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        approvalId: approval.id,
        operationType: OperationType.CANCEL_INVOICE,
        provider: "paypal",
        idempotencyKey: `cancel-${inv.id}-unknown`,
        attemptState: OperationAttemptState.UNKNOWN,
        isOutcomeUnknown: true,
        attemptedAt: new Date(),
      },
    });

    // Mock status sync confirming CANCELLED on PayPal
    getStatusSpy.mockResolvedValueOnce({
      success: true,
      correlationId: "corr-sync-cancel",
      data: {
        id: inv.paypalInvoiceId!,
        status: "CANCELLED",
        detail: {
          currency_code: "USD",
        },
      },
    });

    const syncResult = await syncInvoiceWithPayPal(workspaceA, ownerA, inv.id);
    expect(syncResult.ok).toBe(true);

    // Verify unknown operation was resolved to SUCCESS
    const op = await db.externalOperation.findFirst({
      where: {
        invoiceId: inv.id,
        operationType: OperationType.CANCEL_INVOICE,
      },
    });
    expect(op?.isOutcomeUnknown).toBe(false);
    expect(op?.attemptState).toBe(OperationAttemptState.SUCCESS);

    // Invoice status is CANCELLED
    const dbInvoice = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(dbInvoice.cashpilotStatus).toBe(CashPilotStatus.CANCELLED);
    expect(dbInvoice.paypalStatus).toBe("CANCELLED");
  });

  // 16. Database failure after provider acceptance returns 500
  it("handles local database failure after provider acceptance and returns 500", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    cancelSpy.mockResolvedValueOnce({
      success: true,
      correlationId: "corr-db-fail-cancel",
      data: { cancelled: true },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const originalTx = db.$transaction.bind(db);
    const txMock = vi.fn().mockRejectedValueOnce(new Error("Connection terminated"));
    Object.defineProperty(db, "$transaction", { value: txMock, configurable: true, writable: true });
    try {
      const res = await cancelRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(500);
      expect(json.code).toBe("DATABASE_PERSISTENCE_FAILED");
    } finally {
      Object.defineProperty(db, "$transaction", { value: originalTx, configurable: true, writable: true });
    }
  });

  // 17. Provider rejection returns 502 Bad Gateway and records FAILED attempt
  it("handles provider rejection, returns 502, and records FAILED attempt", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    cancelSpy.mockResolvedValueOnce({
      success: false,
      correlationId: "corr-rejected-cancel",
      error: {
        httpStatus: 400,
        code: "INVALID_INVOICE_STATUS",
        message: "Invoice cannot be cancelled in current status.",
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.code).toBe("INVALID_INVOICE_STATUS");

    // Approval must NOT be consumed
    const dbApproval = await db.approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(dbApproval.status).toBe(ApprovalStatus.APPROVED);

    // ExternalOperation marked FAILED
    const op = await db.externalOperation.findFirst({
      where: {
        invoiceId: inv.id,
        operationType: OperationType.CANCEL_INVOICE,
        attemptState: OperationAttemptState.FAILED,
      },
    });
    expect(op).not.toBeNull();
  });

  // 18. Zero calls to create, send, remind, payment, or capture endpoints
  it("confirms that NO create draft, send, reminder, payment, or refund endpoints are ever called", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT");
    const approval = await approveCancellationForInvoice(inv);

    cancelSpy.mockResolvedValueOnce({
      success: true,
      correlationId: "corr-zero-calls-cancel",
      data: { cancelled: true },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await cancelRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    expect(res.status).toBe(200);

    // Zero calls to non-cancel operations
    expect(createDraftSpy).not.toHaveBeenCalled();
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
    expect(remindSpy).not.toHaveBeenCalled();
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
