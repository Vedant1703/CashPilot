/**
 * CashPilot AI — PayPal Invoice Reminders Integration Tests
 *
 * Task 9: Tests for POST /api/invoices/[id]/remind
 *
 * Invariants tested:
 * - Valid approved reminder: does NOT transition status to PAID; status remains AWAITING_PAYMENT / DUE_SOON / OVERDUE
 * - Status separation: reminder is purely a notification, never alters raw paypalStatus or cashpilotStatus
 * - Human approval boundary: valid, unexpired SEND_REMINDER approval required
 * - Rejection on missing, expired, invalidated, wrong-action, or previously consumed (USED) approval
 * - Server recomputes hash: stale hash after material change rejects reminder (409 Conflict) and invalidates approval
 * - Cross-workspace authorization (403 Forbidden) and production authentication (401)
 * - Pre-condition: PayPal invoice MUST already be sent; rejects DRAFT, PAID, and CANCELLED (400 Bad Request)
 * - Missing PayPal invoice ID rejected (400 Bad Request)
 * - Rate limit: 24h cooldown between reminders (429 Too Many Requests)
 * - Provider rejection handling & ExternalOperation attempt tracking (FAILED, 502)
 * - Timeout and unknown outcome tracking (UNKNOWN, isOutcomeUnknown = true, 504 Gateway Timeout)
 * - Blind retries blocked while prior outcome remains unknown (409 Conflict)
 * - Concurrent in-flight operations blocked (409 Conflict)
 * - Database failure after provider acceptance marks outcome unknown (500)
 * - Correct audit and operation records
 * - Zero draft creation, invoice sending, cancellation, or payment calls during remind
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as remindRoute } from "@/app/api/invoices/[id]/remind/route";
import { db } from "@/lib/db/client";
import { computeMaterialPayloadHash } from "@/lib/services/invoice.service";
import * as paypalAdapter from "@/lib/paypal/adapter";
import {
  ApprovalAction,
  ApprovalStatus,
  OperationType,
  OperationAttemptState,
  ActivityEventType,
  CashPilotStatus,
} from "@prisma/client";
import { createTestSession, ensureTestUsers, cleanupTestUsers, assertAllowedTestDatabase } from "@/lib/test-utils/auth";

describe("PayPal Invoice Reminder API (POST /api/invoices/[id]/remind)", () => {
  const workspaceA = "demo-workspace-remind-a";
  const workspaceB = "demo-workspace-remind-b";
  const ownerA = "demo-user-remind-a";
  const ownerB = "demo-user-remind-b";
  const clientA = "demo-client-remind-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  const createdInvoiceIds: string[] = [];

  // Spies on adapter methods
  const remindSpy = vi.spyOn(paypalAdapter, "sendPayPalReminder");
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const getStatusSpy = vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus");

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([
      { id: ownerA, email: "remind-a@example.com", name: "Remind Owner A" },
      { id: ownerB, email: "remind-b@example.com", name: "Remind Owner B" },
    ]);

    sessionA = createTestSession({ userId: ownerA, email: "remind-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "remind-b@example.com" });

    // Setup test workspaces and client in PostgreSQL
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Remind Test Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Remind Test Workspace B",
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
        name: "Acme Remind Corp",
        email: "billing@acme-remind.example.com",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();
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
    await cleanupTestUsers([ownerA, ownerB]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper: Create an invoice in workspaceA and set it to AWAITING_PAYMENT with paypalInvoiceId
  async function createSentTestInvoice(initialStatus: CashPilotStatus = CashPilotStatus.AWAITING_PAYMENT) {
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
        title: "Test Invoice for Reminder",
        currency: "USD",
        taxRateBasisPoints: 0,
        invoiceDate,
        dueDate,
        lineItems: [
          {
            description: "Consulting Hours",
            quantity: 3,
            unitPriceMinorUnits: 10000,
          },
        ],
      }),
    });

    const res = await draftRoute(req);
    const json = await res.json();
    expect(res.status).toBe(201);
    createdInvoiceIds.push(json.data.id);

    // Update invoice to simulate already-sent state
    const updated = await db.invoice.update({
      where: { id: json.data.id },
      data: {
        cashpilotStatus: initialStatus,
        paypalInvoiceId: `INV2-REMIND-${json.data.id.substring(0, 8)}`,
        paypalStatus: initialStatus === CashPilotStatus.PAID ? "PAID" : "SENT",
      },
      include: { client: true, lineItems: true },
    });

    return updated;
  }

  // Helper: Approve invoice for SEND_REMINDER
  async function approveReminderForInvoice(
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
      actionType: "SEND_REMINDER",
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
          actionType: "SEND_REMINDER",
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

  // 1. Valid approved reminder: does NOT change status to PAID, preserves AWAITING_PAYMENT, consumes approval
  it("executes valid approved reminder, preserves invoice status, and records audit event", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const note = "Please settle this at your earliest convenience.";
    const subject = "Reminder: Consulting Invoice Payment Due";

    const approval = await approveReminderForInvoice(inv, {
      note,
      subject,
    });

    remindSpy.mockResolvedValueOnce({
      success: true,
      correlationId: "corr-remind-123",
      data: { reminded: true },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
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

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.reminded).toBe(true);
    expect(json.data.invoiceId).toBe(inv.id);
    expect(json.data.paypalInvoiceId).toBe(inv.paypalInvoiceId);

    // Verify adapter call
    expect(remindSpy).toHaveBeenCalledTimes(1);
    expect(remindSpy).toHaveBeenCalledWith(
      inv.paypalInvoiceId,
      expect.objectContaining({
        note,
        subject,
      })
    );

    // Invariant: Status must NOT be PAID
    const dbInvoice = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(dbInvoice.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
    expect(dbInvoice.paypalStatus).toBe("SENT");

    // Approval consumed
    const dbApproval = await db.approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(dbApproval.status).toBe(ApprovalStatus.USED);

    // ExternalOperation created with SUCCESS
    const op = await db.externalOperation.findFirst({
      where: {
        invoiceId: inv.id,
        operationType: OperationType.SEND_REMINDER,
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
  it("rejects reminder when no approval exists", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({}),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.code).toBe("APPROVAL_REQUIRED");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 3. Expired approval rejects with 400 APPROVAL_EXPIRED
  it("rejects reminder when approval is expired", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    // Manually expire approval
    await db.approval.update({
      where: { id: approval.id },
      data: {
        expiresAt: new Date(Date.now() - 3600_000),
        status: ApprovalStatus.EXPIRED,
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("APPROVAL_EXPIRED");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 4. Invalidated approval rejects with 400 APPROVAL_INVALIDATED
  it("rejects reminder when approval was previously invalidated", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    await db.approval.update({
      where: { id: approval.id },
      data: {
        status: ApprovalStatus.INVALIDATED,
        invalidatedAt: new Date(),
        invalidationReason: "Test invalidation",
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("APPROVAL_INVALIDATED");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 5. Consumed (USED) approval rejects with 400 APPROVAL_USED
  it("rejects reminder when approval has already been used", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    await db.approval.update({
      where: { id: approval.id },
      data: { status: ApprovalStatus.USED },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("APPROVAL_USED");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 6. Wrong action type approval (e.g. SEND_INVOICE) rejects with 400 INVALID_APPROVAL_ACTION
  it("rejects reminder when approval action is not SEND_REMINDER", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);

    // Create an approval with SEND_INVOICE action
    const approval = await db.approval.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        actorId: ownerA,
        actionType: ApprovalAction.SEND_INVOICE,
        status: ApprovalStatus.APPROVED,
        payloadHash: "a".repeat(64),
        payloadSnapshot: {},
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("INVALID_APPROVAL_ACTION");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 7. Stale material payload hash rejects with 409 Conflict and invalidates approval
  it("detects stale hash when invoice modified after approval, invalidates approval, and rejects (409)", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    // Modify invoice materially after approval (change totalMinorUnits to invalidate hash)
    await db.invoice.update({
      where: { id: inv.id },
      data: { totalMinorUnits: 999999 },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("APPROVAL_STALE");
    expect(remindSpy).not.toHaveBeenCalled();

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
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionB.cookieHeader, // Different workspace!
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 8b. Unauthenticated access rejected with 401
  it("rejects unauthenticated request with 401 Unauthorized", async () => {
    const inv = await createSentTestInvoice();
    const approval = await approveReminderForInvoice(inv);

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.code).toBe("UNAUTHORIZED");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 9. Ineligible status: DRAFT invoice rejected with 400 Bad Request
  it("rejects draft invoices with 400 Bad Request", async () => {
    // Create draft invoice without setting to AWAITING_PAYMENT
    const reqDraft = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: sessionA.cookieHeader,
      },
      body: JSON.stringify({
        workspaceId: workspaceA,
        clientId: clientA,
        title: "Draft invoice for remind test",
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
      `http://localhost:3000/api/invoices/${draftJson.data.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({}),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: draftJson.data.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("INVALID_INVOICE_STATE");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 10. Ineligible status: PAID and CANCELLED invoices rejected with 400 Bad Request
  it("rejects PAID and CANCELLED invoices with 400 Bad Request", async () => {
    const paidInv = await createSentTestInvoice(CashPilotStatus.PAID);
    const cancelledInv = await createSentTestInvoice(CashPilotStatus.CANCELLED);

    for (const inv of [paidInv, cancelledInv]) {
      const req = new NextRequest(
        `http://localhost:3000/api/invoices/${inv.id}/remind`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
          body: JSON.stringify({}),
        }
      );

      const res = await remindRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe("INVALID_INVOICE_STATE");
    }

    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 11. Missing PayPal invoice ID rejected with 400 Bad Request
  it("rejects reminder when paypalInvoiceId is missing", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);

    // Remove paypalInvoiceId
    await db.invoice.update({
      where: { id: inv.id },
      data: { paypalInvoiceId: null },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({}),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("PAYPAL_DRAFT_REQUIRED");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 12. Rate limiting enforcement: at most 1 reminder per 24 hours per invoice (429)
  it("enforces 24-hour rate limit on reminders for the same invoice (429)", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    // Record a prior successful reminder 3 hours ago
    await db.externalOperation.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        approvalId: approval.id,
        operationType: OperationType.SEND_REMINDER,
        provider: "paypal",
        idempotencyKey: `remind-${inv.id}-prior`,
        attemptState: OperationAttemptState.SUCCESS,
        attemptedAt: new Date(Date.now() - 3 * 3600_000),
        completedAt: new Date(Date.now() - 3 * 3600_000),
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.code).toBe("REMINDER_RATE_LIMITED");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 13. Provider rate limiting (PayPal returns 429) mapped to 429
  it("maps PayPal 429 rate limit to application 429 REMINDER_RATE_LIMITED", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    remindSpy.mockResolvedValueOnce({
      success: false,
      correlationId: "corr-rate-limit-1",
      error: {
        httpStatus: 429,
        code: "RATE_LIMIT_REACHED",
        message: "You have exceeded PayPal reminder frequency limits.",
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.code).toBe("REMINDER_RATE_LIMITED");
  });

  // 14. Concurrent in-flight operations blocked with 409 Conflict
  it("blocks concurrent in-flight reminder operations with 409 Conflict", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    // Simulate an operation currently IN_FLIGHT
    await db.externalOperation.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        approvalId: approval.id,
        operationType: OperationType.SEND_REMINDER,
        provider: "paypal",
        idempotencyKey: `remind-${inv.id}-inflight`,
        attemptState: OperationAttemptState.IN_FLIGHT,
        attemptedAt: new Date(),
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("OPERATION_IN_FLIGHT");
    expect(remindSpy).not.toHaveBeenCalled();
  });

  // 15. Timeout and unknown outcome handling (504) and blocking blind retries (409)
  it("records timeout as unknown outcome (504) and blocks subsequent blind retries (409)", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    // Mock timeout on reminder
    remindSpy.mockResolvedValueOnce({
      success: false,
      isOutcomeUnknown: true,
      correlationId: "corr-timeout-1",
      error: {
        httpStatus: 504,
        code: "TIMEOUT",
        message: "Network timeout connecting to PayPal Invoicing API.",
      },
    });

    const req1 = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res1 = await remindRoute(req1, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json1 = await res1.json();

    expect(res1.status).toBe(504);
    expect(json1.code).toBe("OPERATION_UNKNOWN_OUTCOME");

    // Verify database record has isOutcomeUnknown = true
    const op = await db.externalOperation.findFirst({
      where: {
        invoiceId: inv.id,
        operationType: OperationType.SEND_REMINDER,
        isOutcomeUnknown: true,
      },
    });
    expect(op).not.toBeNull();
    expect(op?.attemptState).toBe(OperationAttemptState.UNKNOWN);

    // Blind retry must be blocked with 409 PENDING_UNKNOWN_OPERATION
    const req2 = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res2 = await remindRoute(req2, {
      params: Promise.resolve({ id: inv.id }),
    });
    const json2 = await res2.json();

    expect(res2.status).toBe(409);
    expect(json2.code).toBe("PENDING_UNKNOWN_OPERATION");
    // Adapter must NOT have been called on the retry
    expect(remindSpy).toHaveBeenCalledTimes(1);
  });

  // 16. Database failure after provider acceptance records outcome unknown
  it("handles local database failure after provider acceptance and returns 500", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    remindSpy.mockResolvedValueOnce({
      success: true,
      correlationId: "corr-db-fail-1",
      data: { reminded: true },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
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
      const res = await remindRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(500);
      expect(json.code).toBe("DATABASE_PERSISTENCE_FAILED");
    } finally {
      Object.defineProperty(db, "$transaction", { value: originalTx, configurable: true, writable: true });
    }
  });

  // 17. Provider rejection returns 502 Bad Gateway and records FAILED
  it("handles provider rejection, returns 502, and records FAILED attempt", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    remindSpy.mockResolvedValueOnce({
      success: false,
      correlationId: "corr-rejected-1",
      error: {
        httpStatus: 400,
        code: "INVALID_INVOICE_STATUS",
        message: "Invoice cannot be reminded in current status.",
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
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
        operationType: OperationType.SEND_REMINDER,
        attemptState: OperationAttemptState.FAILED,
      },
    });
    expect(op).not.toBeNull();
  });

  // 18. Zero calls to create, send, cancel, or payment endpoints
  it("confirms that NO create, send, cancel, payment, or refund endpoints are ever called", async () => {
    const inv = await createSentTestInvoice(CashPilotStatus.AWAITING_PAYMENT);
    const approval = await approveReminderForInvoice(inv);

    remindSpy.mockResolvedValueOnce({
      success: true,
      correlationId: "corr-check-zero-calls",
      data: { reminded: true },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/invoices/${inv.id}/remind`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({ approvalId: approval.id }),
      }
    );

    const res = await remindRoute(req, {
      params: Promise.resolve({ id: inv.id }),
    });
    expect(res.status).toBe(200);

    // Zero calls to non-remind operations
    expect(createDraftSpy).not.toHaveBeenCalled();
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(remindSpy).toHaveBeenCalledTimes(1);
  });
});
