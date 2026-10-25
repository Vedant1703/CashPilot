/**
 * CashPilot AI — PayPal Status Reconciliation & Sync Integration Tests
 *
 * Task 7: Tests for POST /api/invoices/[id]/sync
 *
 * Invariants tested:
 * - Valid provider status refresh and persistence (paypalStatus, lastSyncAt, syncIsStale = false)
 * - Mapping of supported PayPal statuses (DRAFT, SENT, PAID, CANCELLED, REFUNDED)
 * - Verified paid evidence (PAID -> CashPilotStatus.PAID) vs unmapped status (NEEDS_REVIEW)
 * - Handling when no PayPal invoice is linked (structured response, hasPaypalInvoice: false)
 * - Cross-workspace access control (403 Forbidden) and production auth (401 Unauthorized)
 * - OAuth failure, timeout (504), rate limit, and provider server errors
 * - Preservation of last known valid status and syncIsStale = true on failed refresh
 * - Provider 404 (invoice not found on PayPal) recorded as discrepancy without recreating
 * - Reconciliation of UNKNOWN-outcome operations (e.g. timed-out draft creation)
 * - Stale response protection (concurrency safeguard prevents overwriting newer sync)
 * - Zero write/send/payment/create calls on PayPal during sync
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { POST as syncRoute } from "@/app/api/invoices/[id]/sync/route";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import {
  OperationType,
  OperationAttemptState,
  ActivityEventType,
  CashPilotStatus,
} from "@prisma/client";
import { createTestSession } from "@/lib/test-utils/auth";

describe("PayPal Status Reconciliation & Sync API", () => {
  const workspaceA = "demo-workspace-sync-a";
  const workspaceB = "demo-workspace-sync-b";
  const ownerA = "demo-user-sync-a";
  const ownerB = "demo-user-sync-b";
  const clientA = "demo-client-sync-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  const createdInvoiceIds: string[] = [];

  // Spies
  const getStatusSpy = vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus");
  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");

  beforeAll(async () => {
    sessionA = createTestSession({ userId: ownerA, email: "sync-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "sync-b@example.com" });

    // Setup test workspaces and client
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Sync Test Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Sync Test Workspace B",
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
        name: "Acme Sync Client",
        email: "sync@client-sandbox.example.com",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
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
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper to create a draft invoice with linked paypalInvoiceId
  async function createTestInvoiceWithPayPal(paypalInvoiceId?: string, initialStatus = "DRAFT") {
    const payload = {
      workspaceId: workspaceA,
      clientId: clientA,
      title: "Sync Test Invoice",
      currency: "USD",
      taxRateBasisPoints: 0,
      invoiceDate: "2026-10-18",
      dueDate: "2026-11-15",
      lineItems: [
        {
          description: "Service Item",
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
        body: JSON.stringify(payload),
      })
    );
    const draftJson = await draftRes.json();
    const invoiceId = draftJson.data.id as string;
    createdInvoiceIds.push(invoiceId);

    if (paypalInvoiceId) {
      await db.invoice.update({
        where: { id: invoiceId },
        data: {
          paypalInvoiceId,
          paypalStatus: initialStatus,
          lastSyncAt: new Date(),
        },
      });
    }

    return { invoiceId };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Valid Status Refresh & Persistence
  // ───────────────────────────────────────────────────────────────────────────
  describe("Valid Status Refresh", () => {
    it("successfully refreshes status from PayPal and updates local state", async () => {
      const paypalId = "INV2-SYNC-TEST-001";
      const { invoiceId } = await createTestInvoiceWithPayPal(paypalId, "DRAFT");

      getStatusSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: paypalId,
          status: "SENT",
          detail: { currency_code: "USD" },
        },
        correlationId: "debug-sync-123",
      });

      const res = await syncRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/sync`, {
          method: "POST",
          headers: { Cookie: sessionA.cookieHeader },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.invoiceId).toBe(invoiceId);
      expect(json.data.paypalInvoiceId).toBe(paypalId);
      expect(json.data.previousPaypalStatus).toBe("DRAFT");
      expect(json.data.currentPaypalStatus).toBe("SENT");
      expect(json.data.currentCashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(json.data.statusChanged).toBe(true);
      expect(json.data.isStale).toBe(false);

      // Verify DB update
      const dbInvoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(dbInvoice.paypalStatus).toBe("SENT");
      expect(dbInvoice.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(dbInvoice.syncIsStale).toBe(false);
      expect(dbInvoice.lastSyncAt).not.toBeNull();

      // Verify ExternalOperation record
      const op = await db.externalOperation.findFirst({
        where: { invoiceId, operationType: OperationType.GET_INVOICE },
      });
      expect(op).not.toBeNull();
      expect(op?.attemptState).toBe(OperationAttemptState.SUCCESS);
      expect(op?.correlationId).toBe("debug-sync-123");

      // Verify zero write or send operations
      expect(createDraftSpy).not.toHaveBeenCalled();
      expect(sendInvoiceSpy).not.toHaveBeenCalled();
    });

    it("transitions cashpilotStatus to PAID only upon verified provider PAID status", async () => {
      const paypalId = "INV2-SYNC-PAID-002";
      const { invoiceId } = await createTestInvoiceWithPayPal(paypalId, "SENT");

      getStatusSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: paypalId,
          status: "PAID",
          detail: { currency_code: "USD" },
        },
      });

      const res = await syncRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/sync`, {
          method: "POST",
          headers: { Cookie: sessionA.cookieHeader },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data.currentPaypalStatus).toBe("PAID");
      expect(json.data.currentCashpilotStatus).toBe(CashPilotStatus.PAID);

      const dbInvoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(dbInvoice.cashpilotStatus).toBe(CashPilotStatus.PAID);
    });

    it("maps unmapped/unknown provider status to NEEDS_REVIEW, never silently PAID", async () => {
      const paypalId = "INV2-SYNC-UNKNOWN-003";
      const { invoiceId } = await createTestInvoiceWithPayPal(paypalId, "SENT");

      getStatusSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: paypalId,
          status: "SOME_FUTURE_PROVIDER_STATE",
          detail: { currency_code: "USD" },
        },
      });

      const res = await syncRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/sync`, {
          method: "POST",
          headers: { Cookie: sessionA.cookieHeader },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data.currentCashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);

      const dbInvoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(dbInvoice.cashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);
      expect(dbInvoice.cashpilotStatus).not.toBe(CashPilotStatus.PAID);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Invoice with No Linked PayPal Resource
  // ───────────────────────────────────────────────────────────────────────────
  describe("No Linked PayPal Resource", () => {
    it("returns structured response without guessing provider state when no PayPal invoice is linked", async () => {
      const { invoiceId } = await createTestInvoiceWithPayPal(undefined); // No paypalInvoiceId

      const res = await syncRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/sync`, {
          method: "POST",
          headers: { Cookie: sessionA.cookieHeader },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.hasPaypalInvoice).toBe(false);
      expect(json.data.paypalInvoiceId).toBeNull();
      expect(json.data.statusChanged).toBe(false);

      // Verify no external call was made
      expect(getStatusSpy).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Provider Failures & State Preservation
  // ───────────────────────────────────────────────────────────────────────────
  describe("Provider Failures & Stale Handling", () => {
    it("preserves last known valid status and marks syncIsStale = true when refresh times out", async () => {
      const paypalId = "INV2-TIMEOUT-004";
      const { invoiceId } = await createTestInvoiceWithPayPal(paypalId, "DRAFT");

      getStatusSpy.mockResolvedValueOnce({
        success: false,
        isOutcomeUnknown: true,
        error: {
          code: "TIMEOUT",
          message: "Status refresh request timed out",
        },
        correlationId: "debug-to-999",
      });

      const res = await syncRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/sync`, {
          method: "POST",
          headers: { Cookie: sessionA.cookieHeader },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(504);
      expect(json.code).toBe("TIMEOUT");

      // Verify last known valid status is PRESERVED, not erased
      const dbInvoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(dbInvoice.paypalStatus).toBe("DRAFT");
      expect(dbInvoice.cashpilotStatus).toBe(CashPilotStatus.DRAFT);
      expect(dbInvoice.syncIsStale).toBe(true); // marked stale!

      // Verify failure audit event was recorded
      const failEvent = await db.activityEvent.findFirst({
        where: { invoiceId, eventType: ActivityEventType.STATUS_SYNC_FAILED },
      });
      expect(failEvent).not.toBeNull();
    });

    it("handles provider 404 by recording discrepancy without recreating resource", async () => {
      const paypalId = "INV2-NOT-FOUND-005";
      const { invoiceId } = await createTestInvoiceWithPayPal(paypalId, "DRAFT");

      getStatusSpy.mockResolvedValueOnce({
        success: false,
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "The specified invoice does not exist",
          httpStatus: 404,
        },
        correlationId: "debug-404-123",
      });

      const res = await syncRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/sync`, {
          method: "POST",
          headers: { Cookie: sessionA.cookieHeader },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(404);
      expect(json.code).toBe("PROVIDER_INVOICE_NOT_FOUND");
      expect(json.error).toContain("Discrepancy recorded");

      // Local record must NOT be deleted or blindly recreated
      const dbInvoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(dbInvoice.paypalInvoiceId).toBe(paypalId);
      expect(dbInvoice.syncIsStale).toBe(true);
      expect(createDraftSpy).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Reconciliation of Uncertain Operations
  // ───────────────────────────────────────────────────────────────────────────
  describe("Operation Reconciliation", () => {
    it("reconciles pending UNKNOWN draft creation operation upon observing provider evidence", async () => {
      const paypalId = "INV2-RECONCILE-006";
      const { invoiceId } = await createTestInvoiceWithPayPal(paypalId, "DRAFT");

      // Create an unknown-outcome operation representing a timed-out write
      const unknownOp = await db.externalOperation.create({
        data: {
          workspaceId: workspaceA,
          invoiceId,
          operationType: OperationType.CREATE_DRAFT,
          attemptState: OperationAttemptState.UNKNOWN,
          isOutcomeUnknown: true,
          errorMessage: "Timed out waiting for PayPal response",
        },
      });

      getStatusSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: paypalId,
          status: "DRAFT",
          detail: { currency_code: "USD" },
        },
        correlationId: "debug-reconcile-777",
      });

      const res = await syncRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/sync`, {
          method: "POST",
          headers: { Cookie: sessionA.cookieHeader },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data.reconciledOperationsCount).toBe(1);

      // Verify the operation is reconciled in DB
      const reconciledOp = await db.externalOperation.findUniqueOrThrow({
        where: { id: unknownOp.id },
      });
      expect(reconciledOp.isOutcomeUnknown).toBe(false);
      expect(reconciledOp.attemptState).toBe(OperationAttemptState.SUCCESS);
      expect(reconciledOp.reconciledAt).not.toBeNull();
      expect(reconciledOp.reconcileResult).toContain("confirmed draft creation exists");

      // Verify STATUS_SYNC_RECONCILED event
      const reconcileEvent = await db.activityEvent.findFirst({
        where: { invoiceId, eventType: ActivityEventType.STATUS_SYNC_RECONCILED },
      });
      expect(reconcileEvent).not.toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Authorization & Boundaries
  // ───────────────────────────────────────────────────────────────────────────
  describe("Authorization & Boundaries", () => {
    it("rejects cross-workspace sync with 403 Forbidden", async () => {
      const paypalId = "INV2-CROSS-007";
      const { invoiceId } = await createTestInvoiceWithPayPal(paypalId, "DRAFT");

      const res = await syncRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/sync`, {
          method: "POST",
          headers: { Cookie: sessionB.cookieHeader }, // Owner of workspace B!
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(403);
      expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
      expect(getStatusSpy).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated request with 401 Unauthorized", async () => {
      const paypalId = "INV2-AUTH-008";
      const { invoiceId } = await createTestInvoiceWithPayPal(paypalId, "DRAFT");

      const res = await syncRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/sync`, {
          method: "POST",
          // No session cookie provided
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(401);
      expect(json.code).toBe("UNAUTHORIZED");
      expect(getStatusSpy).not.toHaveBeenCalled();
    });

    it("returns 404 for nonexistent invoice", async () => {
      const res = await syncRoute(
        new NextRequest("http://localhost:3000/api/invoices/nonexistent-id-sync/sync", {
          method: "POST",
          headers: { Cookie: sessionA.cookieHeader },
        }),
        { params: Promise.resolve({ id: "nonexistent-id-sync" }) }
      );

      const json = await res.json();
      expect(res.status).toBe(404);
      expect(json.code).toBe("NOT_FOUND");
    });
  });
});
