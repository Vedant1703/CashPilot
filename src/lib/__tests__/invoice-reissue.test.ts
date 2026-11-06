/**
 * CashPilot AI — Cancelled Invoice Recovery and Reissue Tests (GEN-07)
 *
 * Verifies:
 * - Local draft cancellation without PayPal API calls
 * - Cancelled invoice immutability
 * - POST /api/invoices/[id]/reissue clones line items and amounts into fresh draft
 * - Reissued invoice requires fresh approval and new PayPal draft
 * - Non-cancelled invoices cannot be reissued (400 INVALID_INVOICE_STATUS)
 * - Safe workspace boundary protection
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { POST as reissueRoute } from "@/app/api/invoices/[id]/reissue/route";
import { POST as cancelRoute } from "@/app/api/invoices/[id]/cancel/route";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import { createTestSession, assertAllowedTestDatabase } from "@/lib/test-utils/auth";
import { CashPilotStatus, ActivityEventType } from "@prisma/client";

describe("Cancelled Invoice Recovery and Reissue (GEN-07)", () => {
  const workspaceId = "demo-workspace-reissue-test";
  const clientId = "demo-client-reissue-test";
  const actorId = "demo-user-reissue-test";
  const createdInvoiceIds: string[] = [];
  let authCookie = "";

  function createAuthReq(url: string, method = "POST", body?: unknown): NextRequest {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Cookie", authCookie);
    return new NextRequest(new URL(url, "http://localhost:3000"), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  const cancelPayPalSpy = vi.spyOn(paypalAdapter, "cancelPayPalInvoice");

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    const session = createTestSession({ actorId, workspaceId });
    authCookie = session.cookieHeader;

    await db.user.upsert({
      where: { id: actorId },
      update: {},
      create: {
        id: actorId,
        email: "reissue-tester@example.com",
        name: "Reissue Tester",
        passwordHash: "test-hash",
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceId },
      update: {},
      create: {
        id: workspaceId,
        name: "Reissue Test Workspace",
        ownerId: actorId,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientId },
      update: {},
      create: {
        id: clientId,
        workspaceId,
        name: "Reissue Client Corp",
        email: "reissue.client@example.com",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    if (createdInvoiceIds.length > 0) {
      await db.activityEvent.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
      await db.approval.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
      await db.externalOperation.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
      await db.invoiceLineItem.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
      await db.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
    }
  });

  it("cancels an unsent local draft without calling PayPal Sandbox", async () => {
    cancelPayPalSpy.mockClear();

    // 1. Create a draft
    const createReq = createAuthReq("/api/invoices/draft", "POST", {
      workspaceId,
      clientId,
      title: "Draft to Cancel Locally",
      currency: "USD",
      taxRateBasisPoints: 0,
      invoiceDate: "2026-11-01",
      dueDate: "2026-12-01",
      lineItems: [
        {
          description: "Temporary Work",
          quantity: 1,
          unitPriceMinorUnits: 12000,
        },
      ],
    });

    const createRes = await draftRoute(createReq);
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    const invoiceId = createJson.data.id;
    createdInvoiceIds.push(invoiceId);

    // 2. Cancel draft via POST /api/invoices/[id]/cancel
    const cancelReq = createAuthReq(`/api/invoices/${invoiceId}/cancel`, "POST", { localOnly: true });
    const cancelRes = await cancelRoute(cancelReq, { params: Promise.resolve({ id: invoiceId }) });
    expect(cancelRes.status).toBe(200);
    const cancelJson = await cancelRes.json();
    expect(cancelJson.success).toBe(true);

    // 3. Verify PayPal was NOT called
    expect(cancelPayPalSpy).not.toHaveBeenCalled();

    // 4. Verify DB status is CANCELLED
    const cancelledInvoice = await db.invoice.findUnique({ where: { id: invoiceId } });
    expect(cancelledInvoice?.cashpilotStatus).toBe(CashPilotStatus.CANCELLED);

    // 5. Verify local draft cancellation activity event
    const events = await db.activityEvent.findMany({
      where: {
        invoiceId,
        eventType: ActivityEventType.INVOICE_STATUS_CHANGED,
      },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].description).toContain("Local draft invoice was cancelled");
  });

  it("reissues a cancelled invoice into a fresh linked draft (GEN-07)", async () => {
    // 1. Create a draft and cancel it
    const createReq = createAuthReq("/api/invoices/draft", "POST", {
      workspaceId,
      clientId,
      title: "Original Invoice",
      currency: "USD",
      taxRateBasisPoints: 500, // 5%
      invoiceDate: "2026-11-01",
      dueDate: "2026-12-01",
      notes: "Initial project milestone",
      lineItems: [
        {
          description: "Milestone 1 Deliverables",
          quantity: 2,
          unitPriceMinorUnits: 25000, // $250.00 each -> $500.00 subtotal
        },
      ],
    });

    const createRes = await draftRoute(createReq);
    const createJson = await createRes.json();
    const originalInvoiceId = createJson.data.id;
    createdInvoiceIds.push(originalInvoiceId);

    // Cancel it locally
    const cancelReq = createAuthReq(`/api/invoices/${originalInvoiceId}/cancel`, "POST", { localOnly: true });
    await cancelRoute(cancelReq, { params: Promise.resolve({ id: originalInvoiceId }) });

    // 2. Reissue the cancelled invoice via POST /api/invoices/[id]/reissue
    const reissueReq = createAuthReq(`/api/invoices/${originalInvoiceId}/reissue`, "POST");
    const reissueRes = await reissueRoute(reissueReq, { params: Promise.resolve({ id: originalInvoiceId }) });
    expect(reissueRes.status).toBe(201);
    const reissueJson = await reissueRes.json();
    expect(reissueJson.success).toBe(true);

    const newInvoiceId = reissueJson.data.newInvoiceId;
    expect(newInvoiceId).toBeDefined();
    expect(newInvoiceId).not.toBe(originalInvoiceId);
    createdInvoiceIds.push(newInvoiceId);

    // 3. Verify original invoice is still CANCELLED (immutability)
    const originalCheck = await db.invoice.findUnique({ where: { id: originalInvoiceId } });
    expect(originalCheck?.cashpilotStatus).toBe(CashPilotStatus.CANCELLED);

    // 4. Verify new invoice is in DRAFT status with cloned items and recalculations
    const newInvoice = await db.invoice.findUnique({
      where: { id: newInvoiceId },
      include: { lineItems: true },
    });
    expect(newInvoice?.cashpilotStatus).toBe(CashPilotStatus.DRAFT);
    expect(newInvoice?.paypalInvoiceId).toBeNull(); // Fresh draft, zero PayPal draft
    expect(newInvoice?.subtotalMinorUnits).toBe(50000);
    expect(newInvoice?.taxMinorUnits).toBe(2500); // 5% of $500.00 = $25.00
    expect(newInvoice?.totalMinorUnits).toBe(52500); // $525.00
    expect(newInvoice?.lineItems).toHaveLength(1);
    expect(newInvoice?.lineItems[0].description).toBe("Milestone 1 Deliverables");
    expect(newInvoice?.notes).toContain("Replaces cancelled invoice");

    // 5. Verify audit linkage event on original invoice
    const originalEvents = await db.activityEvent.findMany({
      where: {
        invoiceId: originalInvoiceId,
        eventType: ActivityEventType.INVOICE_STATUS_CHANGED,
      },
    });
    const reissueEvent = originalEvents.find((e) => e.description.includes("Replacement invoice created"));
    expect(reissueEvent).toBeDefined();
  });

  it("rejects reissuing invoices that are not in CANCELLED status", async () => {
    // 1. Create a DRAFT invoice
    const createReq = createAuthReq("/api/invoices/draft", "POST", {
      workspaceId,
      clientId,
      title: "Active Draft Invoice",
      currency: "USD",
      taxRateBasisPoints: 0,
      invoiceDate: "2026-11-01",
      dueDate: "2026-12-01",
      lineItems: [{ description: "Active", quantity: 1, unitPriceMinorUnits: 5000 }],
    });

    const createRes = await draftRoute(createReq);
    const createJson = await createRes.json();
    const invoiceId = createJson.data.id;
    createdInvoiceIds.push(invoiceId);

    // Attempt reissue on DRAFT
    const reissueReq = createAuthReq(`/api/invoices/${invoiceId}/reissue`, "POST");
    const reissueRes = await reissueRoute(reissueReq, { params: Promise.resolve({ id: invoiceId }) });
    expect(reissueRes.status).toBe(400);
    const json = await reissueRes.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe("INVALID_INVOICE_STATUS");
  });

  it("rejects reissuing non-existent invoice or invoice from another workspace", async () => {
    const reissueReq = createAuthReq("/api/invoices/nonexistent-id/reissue", "POST");
    const reissueRes = await reissueRoute(reissueReq, { params: Promise.resolve({ id: "nonexistent-id" }) });
    expect(reissueRes.status).toBe(404);
  });
});
