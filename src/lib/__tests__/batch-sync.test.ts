/**
 * CashPilot AI — Workspace Batch Status Reconciliation Tests
 *
 * SRS §4, §5 & UI Design Reference Page 14:
 * Integration tests for POST /api/invoices/sync and batchSyncWorkspaceInvoicesWithPayPal.
 *
 * Invariants tested:
 * - Multi-invoice reconciliation updates active invoices in the workspace.
 * - Verified payment evidence: PAID status is granted only when provider explicitly confirms PAID.
 * - Stale preservation: Invoices where PayPal call fails retain their previous status and mark syncIsStale = true.
 * - Never mark Paid on error, timeout, or unknown provider status.
 * - Local drafts without paypalInvoiceId are reported without querying PayPal.
 * - Before-and-after stage counts and metric calculations are strictly computed on the server.
 * - Unauthenticated requests are rejected with 401 Unauthorized.
 * - Cross-workspace access attempts are strictly rejected with 403 Forbidden.
 * - Workspace-level audit event is recorded in the append-only activity log.
 * - Empty workspace returns zero-delta summary without error.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as batchSyncRoute } from "@/app/api/invoices/sync/route";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import type { ReconciliationItemResult } from "@/lib/services/invoice.service";
import {
  CashPilotStatus,
  ActivityEventType,
} from "@prisma/client";
import {
  createTestSession,
  ensureTestUsers,
  cleanupTestUsers,
  assertAllowedTestDatabase,
} from "@/lib/test-utils/auth";

describe("Workspace Batch Status Reconciliation API (POST /api/invoices/sync)", () => {
  const workspaceA = "test-ws-batch-sync-a";
  const workspaceB = "test-ws-batch-sync-b";
  const ownerA = "test-user-batch-sync-a";
  const ownerB = "test-user-batch-sync-b";
  const clientA = "test-client-batch-sync-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  const getStatusSpy = vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus");

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([
      { id: ownerA, email: "batch-sync-a@example.com", name: "Batch Owner A" },
      { id: ownerB, email: "batch-sync-b@example.com", name: "Batch Owner B" },
    ]);

    sessionA = createTestSession({ userId: ownerA, email: "batch-sync-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "batch-sync-b@example.com" });

    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Batch Sync Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Batch Sync Workspace B",
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
        name: "Acme Batch Client",
        email: "batch-client@example.com",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();
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

  it("rejects unauthenticated requests with 401 Unauthorized", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspaceA }),
    });

    const res = await batchSyncRoute(req);
    expect(res.status).toBe(401);

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe("UNAUTHORIZED");
  });

  it("rejects cross-workspace reconciliation requests with 403 Forbidden", async () => {
    // Owner B attempts to sync Owner A's workspace
    const req = new NextRequest("http://localhost:3000/api/invoices/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionB.cookieHeader,
      },
      body: JSON.stringify({ workspaceId: workspaceA }),
    });

    const res = await batchSyncRoute(req);
    expect(res.status).toBe(403);

    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it("handles empty workspace gracefully returning zero deltas", async () => {
    // Workspace B is empty
    const req = new NextRequest("http://localhost:3000/api/invoices/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionB.cookieHeader,
      },
      body: JSON.stringify({ workspaceId: workspaceB }),
    });

    const res = await batchSyncRoute(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.totalInvoicesScanned).toBe(0);
    expect(json.data.totalPaypalInvoicesQueried).toBe(0);
    expect(json.data.changedCount).toBe(0);
    expect(json.data.beforeOutstandingMinorUnits).toBe(0);
    expect(json.data.afterOutstandingMinorUnits).toBe(0);
    expect(json.data.items).toEqual([]);
  });

  it("reconciles multiple invoices: updates PAID on provider proof, preserves stale on error, and reports local drafts", async () => {
    const pastDueDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    const futureDueDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days future

    // Seed 3 invoices in workspace A:
    // 1. Inv 1: SENT, past due -> PayPal reports PAID -> CashPilot updates to PAID
    const inv1 = await db.invoice.create({
      data: {
        workspaceId: workspaceA,
        clientId: clientA,
        number: "INV-BS-001",
        title: "Web Consulting",
        currency: "USD",
        totalMinorUnits: 150000, // $1,500.00
        subtotalMinorUnits: 150000,
        invoiceDate: new Date(),
        dueDate: pastDueDate,
        cashpilotStatus: CashPilotStatus.OVERDUE,
        paypalStatus: "SENT",
        paypalInvoiceId: "PAYPAL-INV-BS-1",
        lineItems: {
          create: [{ description: "Consulting", quantity: 1, unitPriceMinorUnits: 150000, totalMinorUnits: 150000 }],
        },
      },
    });

    // 2. Inv 2: SENT -> PayPal is UNREACHABLE (500) -> CashPilot preserves last known status, marks syncIsStale = true
    const inv2 = await db.invoice.create({
      data: {
        workspaceId: workspaceA,
        clientId: clientA,
        number: "INV-BS-002",
        title: "Design System",
        currency: "USD",
        totalMinorUnits: 200000, // $2,000.00
        subtotalMinorUnits: 200000,
        invoiceDate: new Date(),
        dueDate: futureDueDate,
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paypalStatus: "SENT",
        paypalInvoiceId: "PAYPAL-INV-BS-2",
        lineItems: {
          create: [{ description: "Design", quantity: 1, unitPriceMinorUnits: 200000, totalMinorUnits: 200000 }],
        },
      },
    });

    // 3. Inv 3: Pure local draft without paypalInvoiceId -> Not queried on PayPal
    const inv3 = await db.invoice.create({
      data: {
        workspaceId: workspaceA,
        clientId: clientA,
        number: "INV-BS-003",
        title: "Draft Retainer",
        currency: "USD",
        totalMinorUnits: 50000, // $500.00
        subtotalMinorUnits: 50000,
        invoiceDate: new Date(),
        dueDate: futureDueDate,
        cashpilotStatus: CashPilotStatus.DRAFT,
        paypalStatus: null,
        paypalInvoiceId: null,
        lineItems: {
          create: [{ description: "Retainer", quantity: 1, unitPriceMinorUnits: 50000, totalMinorUnits: 50000 }],
        },
      },
    });

    // Mock PayPal Responses:
    getStatusSpy.mockImplementation(async (paypalInvoiceId: string) => {
      if (paypalInvoiceId === "PAYPAL-INV-BS-1") {
        return {
          success: true,
          data: {
            id: paypalInvoiceId,
            status: "PAID",
            detail: { currency_code: "USD" },
          },
        };
      }
      if (paypalInvoiceId === "PAYPAL-INV-BS-2") {
        return {
          success: false,
          error: {
            code: "PROVIDER_ERROR",
            message: "Simulated PayPal API failure",
            httpStatus: 500,
          },
        };
      }
      return {
        success: false,
        error: { code: "NOT_FOUND", message: "Not found", httpStatus: 404 },
      };
    });

    // Execute batch reconciliation
    const req = new NextRequest("http://localhost:3000/api/invoices/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionA.cookieHeader,
      },
      body: JSON.stringify({ workspaceId: workspaceA }),
    });

    const res = await batchSyncRoute(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);

    const data = json.data;
    expect(data.totalInvoicesScanned).toBe(3);
    expect(data.totalPaypalInvoicesQueried).toBe(2); // Only inv1 and inv2 have paypalInvoiceId
    expect(data.changedCount).toBe(1); // Inv 1 changed OVERDUE -> PAID
    expect(data.staleCount).toBe(1); // Inv 2 failed -> stale

    // Verify Board Stage counts before and after
    expect(data.beforeStages.overdue).toBe(1);
    expect(data.beforeStages.paid).toBe(0);
    expect(data.afterStages.overdue).toBe(0);
    expect(data.afterStages.paid).toBe(1);

    // Outstanding total dropped by $1,500.00 (from 350,000 to 200,000 minor units)
    expect(data.beforeOutstandingMinorUnits).toBe(350000);
    expect(data.afterOutstandingMinorUnits).toBe(200000);

    // Verify itemized details
    const item1 = data.items.find((i: ReconciliationItemResult) => i.invoiceId === inv1.id);
    expect(item1).toBeDefined();
    expect(item1.currentPaypalStatus).toBe("PAID");
    expect(item1.currentCashpilotStatus).toBe(CashPilotStatus.PAID);
    expect(item1.statusChanged).toBe(true);
    expect(item1.isStale).toBe(false);

    const item2 = data.items.find((i: ReconciliationItemResult) => i.invoiceId === inv2.id);
    expect(item2).toBeDefined();
    expect(item2.currentCashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT); // Preserved
    expect(item2.isStale).toBe(true); // Stale preserved

    const item3 = data.items.find((i: ReconciliationItemResult) => i.invoiceId === inv3.id);
    expect(item3).toBeDefined();
    expect(item3.hasPaypalInvoice).toBe(false);
    expect(item3.currentCashpilotStatus).toBe(CashPilotStatus.DRAFT);

    // Verify database state
    const dbInv1 = await db.invoice.findUnique({ where: { id: inv1.id } });
    expect(dbInv1?.cashpilotStatus).toBe(CashPilotStatus.PAID);
    expect(dbInv1?.paypalStatus).toBe("PAID");

    const dbInv2 = await db.invoice.findUnique({ where: { id: inv2.id } });
    expect(dbInv2?.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT); // NOT marked Paid!
    expect(dbInv2?.syncIsStale).toBe(true);

    // Verify append-only workspace activity event
    const activity = await db.activityEvent.findFirst({
      where: {
        workspaceId: workspaceA,
        eventType: ActivityEventType.STATUS_SYNC_SUCCESS,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(activity).not.toBeNull();
    expect(activity?.description).toContain("Batch PayPal status reconciliation completed");
  });
});
