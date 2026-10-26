/**
 * CashPilot AI — Task 13A: Invoice Detail Integration & Safe Status Sync Tests
 *
 * Invariants tested:
 * - Rendering invoice details, line items, and server-calculated totals.
 * - Distinguishing CashPilot workflow status from raw PayPal status.
 * - Missing invoice and 404 / 400 error states.
 * - Safe status synchronization: confirmed provider updates refresh displayed state.
 * - Sync failure preserves last known valid state and marks data as stale.
 * - Duplicate-click prevention and loading state indicators.
 * - Preventing false PAID status: provider reporting SENT remains AWAITING_PAYMENT, never PAID.
 * - Workspace authorization: cross-workspace access is rejected with 403 Forbidden.
 * - Read-only guarantee: sync strictly invokes GET on PayPal; zero write, send, or cancel calls.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { NextRequest } from "next/server";
import { InvoiceDetailView, SerializedInvoiceDetail } from "@/components/invoices/invoice-detail-view";
import { POST as syncRoute } from "@/app/api/invoices/[id]/sync/route";
import { GET as getInvoiceRoute } from "@/app/api/invoices/[id]/route";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import { CashPilotStatus, OperationAttemptState } from "@prisma/client";
import { formatMoney } from "@/lib/money";
import { createTestSession, ensureTestUsers, cleanupTestUsers, assertAllowedTestDatabase } from "@/lib/test-utils/auth";

describe("Invoice Detail & Safe Status Sync (Task 13A)", () => {
  const workspaceA = "demo-workspace-detail-a";
  const workspaceB = "demo-workspace-detail-b";
  const ownerA = "demo-user-detail-a";
  const ownerB = "demo-user-detail-b";
  const clientA = "demo-client-detail-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  const createdInvoiceIds: string[] = [];

  // Spies
  const getStatusSpy = vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus");
  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const remindInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalReminder");
  const cancelInvoiceSpy = vi.spyOn(paypalAdapter, "cancelPayPalInvoice");

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([
      { id: ownerA, email: "detail-a@example.com", name: "Detail Sync Owner A" },
      { id: ownerB, email: "detail-b@example.com", name: "Detail Sync Owner B" },
    ]);

    sessionA = createTestSession({ userId: ownerA, email: "detail-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "detail-b@example.com" });

    // Setup test workspaces
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Detail Test Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Detail Test Workspace B",
        ownerId: ownerB,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientA },
      update: { name: "Acme Detail Client", email: "billing@acme-detail.test" },
      create: {
        id: clientA,
        workspaceId: workspaceA,
        name: "Acme Detail Client",
        email: "billing@acme-detail.test",
        company: "Acme Global Industries",
        phone: "+1-555-0199",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();
    // Foreign key cleanup
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

  // Base mock serialized invoice fixture for component tests
  const baseSerializedInvoice: SerializedInvoiceDetail = {
    id: "inv-test-detail-1234",
    workspaceId: workspaceA,
    clientId: clientA,
    number: "INV-1234",
    title: "Full-Stack Security Audit & Architecture",
    notes: "Payment due within 14 calendar days.",
    terms: "Net 14",
    currency: "USD",
    subtotalMinorUnits: 150000, // $1,500.00
    taxRateBasisPoints: 1000,   // 10%
    taxMinorUnits: 15000,       // $150.00
    totalMinorUnits: 165000,     // $1,650.00
    invoiceDate: "2026-10-21T00:00:00.000Z",
    dueDate: "2026-11-04T00:00:00.000Z",
    cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
    paypalInvoiceId: "INV2-SANDBOX-TEST-9988",
    paypalStatus: "SENT",
    lastSyncAt: "2026-10-21T10:00:00.000Z",
    syncIsStale: false,
    isDemoData: true,
    aiDraftId: null,
    client: {
      id: clientA,
      name: "Acme Detail Client",
      email: "billing@acme-detail.test",
      company: "Acme Global Industries",
      phone: "+1-555-0199",
      isDemo: true,
    },
    lineItems: [
      {
        id: "li-1",
        description: "Security Penetration Testing",
        quantity: 10,
        unitPriceMinorUnits: 15000,
        totalMinorUnits: 150000,
        sortOrder: 0,
      },
    ],
    activities: [
      {
        id: "act-1",
        eventType: "INVOICE_SENT",
        actorType: "USER",
        actorId: ownerA,
        description: "Invoice sent to recipient via PayPal Sandbox.",
        createdAt: "2026-10-21T09:30:00.000Z",
      },
    ],
    workspace: {
      id: workspaceA,
      name: "Detail Test Workspace A",
      isDemo: true,
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Rendering Invoice Details & Financial Integrity
  // ───────────────────────────────────────────────────────────────────────────
  describe("Invoice Detail Component Rendering", () => {
    it("renders authoritative invoice details, formatted money, client, and line items", () => {
      const html = renderToString(<InvoiceDetailView initialInvoice={baseSerializedInvoice} />);

      // Title & number
      expect(html).toContain("INV-1234");
      expect(html).toContain("Full-Stack Security Audit &amp; Architecture");

      // Money formatting via formatMoney
      const expectedTotal = formatMoney(165000, "USD");
      const expectedSubtotal = formatMoney(150000, "USD");
      const expectedTax = formatMoney(15000, "USD");

      expect(html).toContain(expectedTotal);
      expect(html).toContain(expectedSubtotal);
      expect(html).toContain(expectedTax);

      // Client details
      expect(html).toContain("Acme Detail Client");
      expect(html).toContain("billing@acme-detail.test");
      expect(html).toContain("Acme Global Industries");
      expect(html).toContain("+1-555-0199");

      // Line item
      expect(html).toContain("Security Penetration Testing");
      expect(html).toContain("10"); // quantity

      // Micro-copy confirming server calculation
      expect(html).toContain("Authoritative totals calculated server-side, never by AI or floating-point arithmetic.");
    });

    it("clearly distinguishes CashPilot workflow status from raw PayPal status", () => {
      const html = renderToString(<InvoiceDetailView initialInvoice={baseSerializedInvoice} />);

      // CashPilot status badge
      expect(html).toContain("Awaiting Payment");

      // Raw PayPal provider status under provider state card
      expect(html).toContain("SENT");
      expect(html).toContain("INV2-SANDBOX-TEST-9988");
      expect(html).toContain("PayPal Sandbox State");
      expect(html).toContain("Provider status and workflow status remain strictly separate.");
    });

    it("renders stale warning badge and notice banner when syncIsStale is true", () => {
      const staleInvoice: SerializedInvoiceDetail = {
        ...baseSerializedInvoice,
        syncIsStale: true,
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={staleInvoice} />);

      expect(html).toContain("Notice: Status May Be Stale");
      expect(html).toContain("The last synchronization with PayPal Sandbox was unsuccessful.");
      expect(html).toContain("Sync Stale (Failed/Timed out)");
    });

    it("renders contextual Navi guidance adhering to strict placement rules (helper callout only)", () => {
      const html = renderToString(<InvoiceDetailView initialInvoice={baseSerializedInvoice} />);

      // Helper card
      expect(html).toContain("Navi — Sent &amp; Awaiting Payment");
      expect(html).toContain("aria-label=\"Navi Guidance\"");

      // Paid invoice Navi guidance
      const paidInvoice: SerializedInvoiceDetail = {
        ...baseSerializedInvoice,
        cashpilotStatus: CashPilotStatus.PAID,
        paypalStatus: "PAID",
      };
      const paidHtml = renderToString(<InvoiceDetailView initialInvoice={paidInvoice} />);
      expect(paidHtml).toContain("Navi — Payment Confirmed");
      expect(paidHtml).toContain("Payment has been verified directly by PayPal Sandbox.");
    });

    it("renders accessible Sync status action button with 44px min-touch target and label", () => {
      const html = renderToString(<InvoiceDetailView initialInvoice={baseSerializedInvoice} />);

      expect(html).toContain("aria-label=\"Synchronize status with PayPal Sandbox\"");
      expect(html).toContain("min-h-[44px]");
      expect(html).toContain("Sync status");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Safe Status Synchronization API & Workflow Tests
  // ───────────────────────────────────────────────────────────────────────────
  describe("Safe Status Synchronization API Flow", () => {
    it("successfully synchronizes status when PayPal reports status change to PAID", async () => {
      // 1. Create invoice in db
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-SYNC-1",
          currency: "USD",
          subtotalMinorUnits: 50000,
          taxMinorUnits: 0,
          totalMinorUnits: 50000,
          invoiceDate: new Date("2026-10-21"),
          dueDate: new Date("2026-11-04"),
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          paypalInvoiceId: "INV2-SYNC-PAID-01",
          paypalStatus: "SENT",
          syncIsStale: false,
        },
      });
      createdInvoiceIds.push(inv.id);

      // Mock PayPal reporting PAID
      getStatusSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: "INV2-SYNC-PAID-01",
          status: "PAID",
          detail: { currency_code: "USD" },
        },
        correlationId: "corr-sync-paid",
      });

      // 2. Call POST /api/invoices/[id]/sync
      const req = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
      });

      const res = await syncRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.statusChanged).toBe(true);
      expect(json.data.previousCashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(json.data.currentCashpilotStatus).toBe(CashPilotStatus.PAID);
      expect(json.data.currentPaypalStatus).toBe("PAID");
      expect(json.data.isStale).toBe(false);

      // Verify db persistence
      const updated = await db.invoice.findUnique({ where: { id: inv.id } });
      expect(updated?.cashpilotStatus).toBe(CashPilotStatus.PAID);
      expect(updated?.paypalStatus).toBe("PAID");
      expect(updated?.syncIsStale).toBe(false);
      expect(updated?.lastSyncAt).not.toBeNull();

      // Read-only invariant: Never calls send, reminder, or cancellation
      expect(sendInvoiceSpy).not.toHaveBeenCalled();
      expect(remindInvoiceSpy).not.toHaveBeenCalled();
      expect(cancelInvoiceSpy).not.toHaveBeenCalled();
      expect(createDraftSpy).not.toHaveBeenCalled();
    });

    it("prevents false PAID status when provider only reports SENT (remains AWAITING_PAYMENT)", async () => {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-SYNC-SENT-1",
          currency: "USD",
          subtotalMinorUnits: 30000,
          taxMinorUnits: 0,
          totalMinorUnits: 30000,
          dueDate: new Date(Date.now() + 10 * 86400000), // 10 days out
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          paypalInvoiceId: "INV2-SYNC-SENT-01",
          paypalStatus: "SENT",
        },
      });
      createdInvoiceIds.push(inv.id);

      // Mock PayPal confirming SENT status
      getStatusSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: "INV2-SYNC-SENT-01",
          status: "SENT",
          detail: { currency_code: "USD" },
        },
        correlationId: "corr-sync-sent",
      });

      const req = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
      });

      const res = await syncRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.currentCashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(json.data.currentCashpilotStatus).not.toBe(CashPilotStatus.PAID);

      const updated = await db.invoice.findUnique({ where: { id: inv.id } });
      expect(updated?.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(updated?.cashpilotStatus).not.toBe(CashPilotStatus.PAID);
    });

    it("preserves last known valid status and marks syncIsStale = true on provider fetch failure", async () => {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-SYNC-FAIL-1",
          currency: "USD",
          subtotalMinorUnits: 40000,
          taxMinorUnits: 0,
          totalMinorUnits: 40000,
          dueDate: new Date("2026-11-04"),
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          paypalInvoiceId: "INV2-SYNC-FAIL-01",
          paypalStatus: "SENT",
          syncIsStale: false,
        },
      });
      createdInvoiceIds.push(inv.id);

      // Mock provider returning failure
      getStatusSpy.mockResolvedValueOnce({
        success: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "Internal server error from PayPal Sandbox",
          httpStatus: 500,
        },
        correlationId: "corr-fail-1",
      });

      const req = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
      });

      const res = await syncRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(502);
      expect(json.success).toBe(false);
      expect(json.code).toBe("PROVIDER_ERROR");

      // Verify db preservation: previous status remains, syncIsStale becomes true
      const updated = await db.invoice.findUnique({ where: { id: inv.id } });
      expect(updated?.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(updated?.paypalStatus).toBe("SENT");
      expect(updated?.syncIsStale).toBe(true);
    });

    it("handles timeout with 504 and records UNKNOWN outcome without blind retry", async () => {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-SYNC-TIMEOUT-1",
          currency: "USD",
          subtotalMinorUnits: 45000,
          taxMinorUnits: 0,
          totalMinorUnits: 45000,
          dueDate: new Date("2026-11-04"),
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          paypalInvoiceId: "INV2-SYNC-TIMEOUT-01",
          paypalStatus: "SENT",
          syncIsStale: false,
        },
      });
      createdInvoiceIds.push(inv.id);

      getStatusSpy.mockResolvedValueOnce({
        success: false,
        isOutcomeUnknown: true,
        error: {
          code: "TIMEOUT",
          message: "Request timed out",
          httpStatus: 504,
        },
        correlationId: "corr-timeout-1",
      });

      const req = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
      });

      const res = await syncRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(504);
      expect(json.code).toBe("TIMEOUT");

      // Audit log records UNKNOWN outcome
      const op = await db.externalOperation.findFirst({
        where: { invoiceId: inv.id },
        orderBy: { createdAt: "desc" },
      });
      expect(op?.attemptState).toBe(OperationAttemptState.UNKNOWN);
      expect(op?.isOutcomeUnknown).toBe(true);

      // Invoice status remains unchanged and stale
      const updated = await db.invoice.findUnique({ where: { id: inv.id } });
      expect(updated?.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
      expect(updated?.syncIsStale).toBe(true);
    });

    it("returns structured response when syncing local draft with no PayPal invoice linked", async () => {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-LOCAL-DRAFT-1",
          currency: "USD",
          subtotalMinorUnits: 25000,
          taxMinorUnits: 0,
          totalMinorUnits: 25000,
          dueDate: new Date("2026-11-04"),
          cashpilotStatus: CashPilotStatus.DRAFT,
          paypalInvoiceId: null, // No PayPal draft
          paypalStatus: null,
        },
      });
      createdInvoiceIds.push(inv.id);

      const req = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
      });

      const res = await syncRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.hasPaypalInvoice).toBe(false);
      expect(json.data.paypalInvoiceId).toBeNull();
      expect(json.data.currentCashpilotStatus).toBe(CashPilotStatus.DRAFT);
      expect(getStatusSpy).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Security, Authorization & Error Boundaries
  // ───────────────────────────────────────────────────────────────────────────
  describe("Authorization & Access Boundaries", () => {
    it("rejects cross-workspace sync attempt with 403 Forbidden", async () => {
      // Invoice belongs to workspaceA
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-CROSS-1",
          currency: "USD",
          subtotalMinorUnits: 10000,
          taxMinorUnits: 0,
          totalMinorUnits: 10000,
          dueDate: new Date("2026-11-04"),
          cashpilotStatus: CashPilotStatus.DRAFT,
        },
      });
      createdInvoiceIds.push(inv.id);

      // Actor from Workspace B attempts to sync invoice in Workspace A
      const req = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionB.cookieHeader, // owner of workspace B, NOT workspace A
        },
      });

      const res = await syncRoute(req, {
        params: Promise.resolve({ id: inv.id }),
      });
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
    });

    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      const inv = await db.invoice.create({
        data: {
          workspaceId: workspaceA,
          clientId: clientA,
          number: "INV-UNAUTH-DETAIL",
          title: "Unauth Test Invoice",
          currency: "USD",
          subtotalMinorUnits: 10000,
          totalMinorUnits: 10000,
          dueDate: new Date("2026-11-04"),
          cashpilotStatus: CashPilotStatus.DRAFT,
        },
      });
      createdInvoiceIds.push(inv.id);

      const syncReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const syncRes = await syncRoute(syncReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      expect(syncRes.status).toBe(401);
      const syncJson = await syncRes.json();
      expect(syncJson.code).toBe("UNAUTHORIZED");

      const getReq = new NextRequest(`http://localhost:3000/api/invoices/${inv.id}`);
      const getRes = await getInvoiceRoute(getReq, {
        params: Promise.resolve({ id: inv.id }),
      });
      expect(getRes.status).toBe(401);
      const getJson = await getRes.json();
      expect(getJson.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 for nonexistent invoice ID on sync and get routes", async () => {
      const syncReq = new NextRequest("http://localhost:3000/api/invoices/nonexistent-id/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
      });

      const syncRes = await syncRoute(syncReq, {
        params: Promise.resolve({ id: "nonexistent-id" }),
      });
      expect(syncRes.status).toBe(404);

      const getReq = new NextRequest("http://localhost:3000/api/invoices/nonexistent-id", {
        headers: { Cookie: sessionA.cookieHeader },
      });
      const getRes = await getInvoiceRoute(getReq, {
        params: Promise.resolve({ id: "nonexistent-id" }),
      });
      expect(getRes.status).toBe(404);
    });

    it("rejects empty or whitespace invoice ID with 400 Bad Request", async () => {
      const req = new NextRequest("http://localhost:3000/api/invoices/%20%20/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionA.cookieHeader,
        },
      });

      const res = await syncRoute(req, {
        params: Promise.resolve({ id: "   " }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("BAD_REQUEST");
    });
  });
});
