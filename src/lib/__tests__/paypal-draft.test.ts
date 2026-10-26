/**
 * CashPilot AI — PayPal Sandbox Draft Creation & Sync Integration Tests
 *
 * Task 6: Tests for POST /api/invoices/[id]/paypal-draft
 *
 * Invariants tested:
 * - Official PayPal Invoicing v2 draft creation endpoint (POST /v2/invoicing/invoices)
 * - Provider request mapping: recipient, currency, line items, quantities, unit prices (minor units to decimal)
 * - Required approval check: valid SEND_INVOICE approval bound to exact material hash
 * - Invalidation & rejection on stale approvals (409 Conflict)
 * - Rejection on expired approvals (400 Bad Request)
 * - Rejection on missing approval or wrong action type (400 Bad Request)
 * - Cross-workspace access control (403 Forbidden) and production auth (401 Unauthorized)
 * - Provider rejection handling & ExternalOperation status tracking (FAILED)
 * - Finite timeout & unknown outcome tracking (UNKNOWN, no blind retries, 504 Gateway Timeout)
 * - Idempotency & deduplication: returns existing draft without creating duplicate provider resources
 * - Status separation: paypalStatus = DRAFT, cashpilotStatus = DRAFT (NEVER marked PAID)
 * - Zero external send or payment operations executed
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as paypalDraftRoute } from "@/app/api/invoices/[id]/paypal-draft/route";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import { buildPayPalInvoicePayload } from "@/lib/services/invoice.service";
import {
  ApprovalStatus,
  ApprovalAction,
  OperationType,
  OperationAttemptState,
  ActivityEventType,
  CashPilotStatus,
} from "@prisma/client";
import { createTestSession, ensureTestUsers, cleanupTestUsers, assertAllowedTestDatabase } from "@/lib/test-utils/auth";

describe("PayPal Sandbox Draft Creation & Status Synchronization", () => {
  const workspaceA = "demo-workspace-paypal-a";
  const workspaceB = "demo-workspace-paypal-b";
  const ownerA = "demo-user-paypal-a";
  const ownerB = "demo-user-paypal-b";
  const clientA = "demo-client-paypal-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  const createdInvoiceIds: string[] = [];

  // Spies
  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const getStatusSpy = vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus");

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([
      { id: ownerA, email: "paypal-a@example.com", name: "PayPal Owner A" },
      { id: ownerB, email: "paypal-b@example.com", name: "PayPal Owner B" },
    ]);

    sessionA = createTestSession({ userId: ownerA, email: "paypal-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "paypal-b@example.com" });

    // Setup test workspaces and client in local PostgreSQL
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "PayPal Test Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "PayPal Test Workspace B",
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
        name: "Jane Smith Consulting",
        email: "jane.smith@client-sandbox.example.com",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();
    // Clean up test data in foreign-key order
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

  // Helper to create an approved test invoice
  async function createApprovedTestInvoice() {
    const draftPayload = {
      workspaceId: workspaceA,
      clientId: clientA,
      title: "Cloud Infrastructure Setup",
      currency: "USD",
      taxRateBasisPoints: 1000, // 10.00%
      invoiceDate: "2026-10-18",
      dueDate: "2026-11-01",
      notes: "Payable within 14 days",
      terms: "Standard consulting terms",
      lineItems: [
        {
          description: "Kubernetes Cluster Provisioning",
          quantity: 2,
          unitPriceMinorUnits: 75000, // $750.00
        },
        {
          description: "Monitoring & Alerting Setup",
          quantity: 1,
          unitPriceMinorUnits: 50000, // $500.00
        },
      ],
    };

    const draftRes = await draftRoute(
      new NextRequest("http://localhost:3000/api/invoices/draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify(draftPayload),
      })
    );
    const draftJson = await draftRes.json();
    expect(draftRes.status).toBe(201);
    const invoiceId = draftJson.data.id as string;
    const materialPayloadHash = draftJson.data.materialPayloadHash as string;
    createdInvoiceIds.push(invoiceId);

    // Approve the invoice
    const approveRes = await approveRoute(
      new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
        body: JSON.stringify({
          actionType: "SEND_INVOICE",
          reviewedPayloadHash: materialPayloadHash,
        }),
      }),
      { params: Promise.resolve({ id: invoiceId }) }
    );
    const approveJson = await approveRes.json();
    expect(approveRes.status).toBe(200);

    return {
      invoiceId,
      approvalId: approveJson.data.approvalId as string,
      materialPayloadHash,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Provider Request Mapping
  // ───────────────────────────────────────────────────────────────────────────
  describe("Provider Request Mapping", () => {
    it("correctly maps invoice fields to PayPal Invoicing v2 format", async () => {
      const { invoiceId } = await createApprovedTestInvoice();

      const invoice = await db.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { client: true, lineItems: true },
      });

      const payload = buildPayPalInvoicePayload(invoice);

      expect(payload.detail.currency_code).toBe("USD");
      expect(payload.detail.payment_term?.due_date).toBe("2026-11-01");
      expect(payload.primary_recipients[0].billing_info.email_address).toBe(
        "jane.smith@client-sandbox.example.com"
      );
      expect(payload.primary_recipients[0].billing_info.name?.given_name).toBe("Jane");
      expect(payload.primary_recipients[0].billing_info.name?.surname).toBe("Smith Consulting");

      // Verify line items mapping (minor units to decimal string)
      expect(payload.items).toHaveLength(2);
      expect(payload.items[0]).toEqual({
        name: "Kubernetes Cluster Provisioning",
        quantity: "2",
        unit_amount: {
          currency_code: "USD",
          value: "750.00",
        },
      });
      expect(payload.items[1]).toEqual({
        name: "Monitoring & Alerting Setup",
        quantity: "1",
        unit_amount: {
          currency_code: "USD",
          value: "500.00",
        },
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Valid Draft Creation Flow & Status Separation
  // ───────────────────────────────────────────────────────────────────────────
  describe("Valid Approved Draft Creation", () => {
    it("creates a PayPal draft, persists provider ID and raw status, and maintains cashpilotStatus DRAFT", async () => {
      const { invoiceId, approvalId } = await createApprovedTestInvoice();

      const mockPayPalInvoiceId = "INV2-TEST-MOCK-DRAFT-001";
      const mockCorrelationId = "paypal-debug-id-abc123";

      createDraftSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: mockPayPalInvoiceId,
          status: "DRAFT",
          detail: { currency_code: "USD" },
        },
        correlationId: mockCorrelationId,
      });

      const res = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
          body: JSON.stringify({ approvalId }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.paypalInvoiceId).toBe(mockPayPalInvoiceId);
      expect(json.data.paypalStatus).toBe("DRAFT");
      expect(json.data.correlationId).toBe(mockCorrelationId);

      // Verify adapter was called with idempotency key
      expect(createDraftSpy).toHaveBeenCalledTimes(1);
      const expectedIdempotencyKey = `draft-${invoiceId}-${approvalId}`;
      expect(createDraftSpy).toHaveBeenCalledWith(
        expect.any(Object),
        expectedIdempotencyKey
      );

      // Verify database invoice record
      const updatedInvoice = await db.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
      expect(updatedInvoice.paypalInvoiceId).toBe(mockPayPalInvoiceId);
      expect(updatedInvoice.paypalStatus).toBe("DRAFT");
      expect(updatedInvoice.lastSyncAt).not.toBeNull();
      expect(updatedInvoice.syncIsStale).toBe(false);

      // CRITICAL INVARIANT: cashpilotStatus remains DRAFT — NEVER marked PAID or SENT
      expect(updatedInvoice.cashpilotStatus).toBe(CashPilotStatus.DRAFT);

      // Verify ExternalOperation record
      const operation = await db.externalOperation.findFirst({
        where: {
          invoiceId,
          operationType: OperationType.CREATE_DRAFT,
        },
      });
      expect(operation).not.toBeNull();
      expect(operation?.attemptState).toBe(OperationAttemptState.SUCCESS);
      expect(operation?.providerInvoiceId).toBe(mockPayPalInvoiceId);
      expect(operation?.correlationId).toBe(mockCorrelationId);

      // Verify ActivityEvent record
      const activity = await db.activityEvent.findFirst({
        where: {
          invoiceId,
          eventType: ActivityEventType.OPERATION_SUCCEEDED,
        },
      });
      expect(activity).not.toBeNull();
      expect(activity?.description).toContain(mockPayPalInvoiceId);

      // Verify ZERO send or payment operations
      expect(sendInvoiceSpy).not.toHaveBeenCalled();
      expect(getStatusSpy).not.toHaveBeenCalled();
    });

    it("returns existing draft idempotently on repeated calls without calling PayPal again", async () => {
      const { invoiceId } = await createApprovedTestInvoice();

      const mockPayPalInvoiceId = "INV2-EXISTING-DRAFT-002";
      createDraftSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: mockPayPalInvoiceId,
          status: "DRAFT",
          detail: { currency_code: "USD" },
        },
      });

      // First call -> creates draft
      const res1 = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      expect(res1.status).toBe(201);
      expect(createDraftSpy).toHaveBeenCalledTimes(1);

      // Second call -> returns existing draft idempotently
      const res2 = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      const json2 = await res2.json();
      expect(res2.status).toBe(200);
      expect(json2.data.paypalInvoiceId).toBe(mockPayPalInvoiceId);
      expect(json2.data.isExistingDraft).toBe(true);

      // Verify PayPal adapter was NOT called a second time
      expect(createDraftSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Approval Safeguards (Missing, Stale, Expired, Wrong Action)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Approval Safeguards", () => {
    it("rejects draft creation if invoice has no active approval with 400", async () => {
      // Create draft without approving it
      const draftPayload = {
        workspaceId: workspaceA,
        clientId: clientA,
        title: "Unapproved Project",
        currency: "USD",
        taxRateBasisPoints: 0,
        invoiceDate: "2026-10-18",
        dueDate: "2026-11-01",
        lineItems: [
          {
            description: "Work",
            quantity: 1,
            unitPriceMinorUnits: 10000,
          },
        ],
      };

      const draftRes = await draftRoute(
        new NextRequest("http://localhost:3000/api/invoices/draft", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
          body: JSON.stringify(draftPayload),
        })
      );
      const draftJson = await draftRes.json();
      const invoiceId = draftJson.data.id;
      createdInvoiceIds.push(invoiceId);

      const res = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe("APPROVAL_REQUIRED");
      expect(createDraftSpy).not.toHaveBeenCalled();
    });

    it("rejects draft creation if approval is for CANCEL_INVOICE or SEND_REMINDER with 400", async () => {
      const { invoiceId, materialPayloadHash } = await createApprovedTestInvoice();

      // Create a subsequent approval with wrong action type
      await db.approval.create({
        data: {
          workspaceId: workspaceA,
          invoiceId,
          actorId: ownerA,
          actionType: ApprovalAction.CANCEL_INVOICE,
          payloadHash: materialPayloadHash,
          payloadSnapshot: {},
          status: ApprovalStatus.APPROVED,
          expiresAt: new Date(Date.now() + 60000),
        },
      });

      // Mark the original SEND_INVOICE approval as INVALIDATED to isolate
      await db.approval.updateMany({
        where: { invoiceId, actionType: ApprovalAction.SEND_INVOICE },
        data: { status: ApprovalStatus.INVALIDATED },
      });

      const res = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe("APPROVAL_REQUIRED");
      expect(createDraftSpy).not.toHaveBeenCalled();
    });

    it("rejects draft creation if approval has expired with 400", async () => {
      const { invoiceId } = await createApprovedTestInvoice();

      // Expire the approval in DB
      await db.approval.updateMany({
        where: { invoiceId },
        data: { expiresAt: new Date(Date.now() - 60000) },
      });

      const res = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe("APPROVAL_EXPIRED");
      expect(createDraftSpy).not.toHaveBeenCalled();
    });

    it("invalidates approval and rejects with 409 Conflict if material field changed after approval", async () => {
      const { invoiceId, approvalId } = await createApprovedTestInvoice();

      // Tamper with invoice material field in DB after approval
      await db.invoice.update({
        where: { id: invoiceId },
        data: { totalMinorUnits: 999999 },
      });

      const res = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(409);
      expect(json.code).toBe("APPROVAL_STALE");
      expect(createDraftSpy).not.toHaveBeenCalled();

      // Verify approval record was marked INVALIDATED in DB
      const dbApproval = await db.approval.findUniqueOrThrow({
        where: { id: approvalId },
      });
      expect(dbApproval.status).toBe(ApprovalStatus.INVALIDATED);
      expect(dbApproval.invalidationReason).toContain("changed after approval");

      // Verify APPROVAL_INVALIDATED audit event was recorded
      const invalidEvent = await db.activityEvent.findFirst({
        where: {
          invoiceId,
          eventType: ActivityEventType.APPROVAL_INVALIDATED,
        },
      });
      expect(invalidEvent).not.toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Authorization & Workspace Boundaries
  // ───────────────────────────────────────────────────────────────────────────
  describe("Authorization & Boundaries", () => {
    it("rejects cross-workspace draft creation with 403 Forbidden", async () => {
      const { invoiceId } = await createApprovedTestInvoice();

      const res = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionB.cookieHeader, // Belongs to workspace B, not A!
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(403);
      expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
      expect(createDraftSpy).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated request with 401 Unauthorized", async () => {
      const { invoiceId } = await createApprovedTestInvoice();

      const res = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // No session cookie provided
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(401);
      expect(json.code).toBe("UNAUTHORIZED");
      expect(createDraftSpy).not.toHaveBeenCalled();
    });

    it("returns 404 for nonexistent invoice", async () => {
      const res = await paypalDraftRoute(
        new NextRequest("http://localhost:3000/api/invoices/nonexistent-id-000/paypal-draft", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: "nonexistent-id-000" }) }
      );

      const json = await res.json();
      expect(res.status).toBe(404);
      expect(json.code).toBe("NOT_FOUND");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Uncertain Outcomes & Timeout Handling
  // ───────────────────────────────────────────────────────────────────────────
  describe("Timeout & Uncertain Outcomes", () => {
    it("handles timeout as unknown outcome without blind retries", async () => {
      const { invoiceId } = await createApprovedTestInvoice();

      createDraftSpy.mockResolvedValueOnce({
        success: false,
        isOutcomeUnknown: true,
        error: {
          code: "TIMEOUT",
          message: "PayPal draft creation timed out",
        },
        correlationId: "debug-timeout-1",
      });

      const res = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(504);
      expect(json.code).toBe("OPERATION_UNKNOWN_OUTCOME");

      // Verify operation state in DB
      const op = await db.externalOperation.findFirst({
        where: { invoiceId, operationType: OperationType.CREATE_DRAFT },
      });
      expect(op?.attemptState).toBe(OperationAttemptState.UNKNOWN);
      expect(op?.isOutcomeUnknown).toBe(true);

      // Verify audit event
      const timedOutEvent = await db.activityEvent.findFirst({
        where: { invoiceId, eventType: ActivityEventType.OPERATION_TIMED_OUT },
      });
      expect(timedOutEvent).not.toBeNull();

      // Immediate subsequent call MUST be blocked until reconciled (no blind retries)
      const resRetry = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      const jsonRetry = await resRetry.json();
      expect(resRetry.status).toBe(409);
      expect(jsonRetry.code).toBe("PENDING_UNKNOWN_OPERATION");
      expect(jsonRetry.error).toContain("Reconcile before retrying");

      // Verify PayPal adapter was not called on the retry
      expect(createDraftSpy).toHaveBeenCalledTimes(1);
    });

    it("records operation failure when provider returns API error", async () => {
      const { invoiceId } = await createApprovedTestInvoice();

      createDraftSpy.mockResolvedValueOnce({
        success: false,
        error: {
          code: "MALFORMED_REQUEST",
          message: "Currency not supported",
        },
        correlationId: "debug-err-999",
      });

      const res = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionA.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(502);
      expect(json.code).toBe("MALFORMED_REQUEST");

      const op = await db.externalOperation.findFirst({
        where: { invoiceId, operationType: OperationType.CREATE_DRAFT },
      });
      expect(op?.attemptState).toBe(OperationAttemptState.FAILED);
      expect(op?.errorCode).toBe("MALFORMED_REQUEST");
    });
  });
});
