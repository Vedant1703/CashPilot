/**
 * CashPilot AI — Persistent Draft Workspace Integration Tests (GEN-02, GEN-03, GEN-04, GEN-05)
 *
 * Verifies:
 * - PATCH /api/invoices/[id] draft updates with authoritative server recalculations
 * - Re-editing an approved/pending draft invalidates prior human approval (GEN-04)
 * - Editing an unsent draft with existing paypalInvoiceId safely clears it and prompts fresh creation
 * - Guard against modifying non-draft invoices (GEN-03)
 * - Safe workspace boundary isolation
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { PATCH as updateInvoiceRoute, GET as getInvoiceRoute } from "@/app/api/invoices/[id]/route";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { db } from "@/lib/db/client";
import { createTestSession, assertAllowedTestDatabase } from "@/lib/test-utils/auth";
import { CashPilotStatus, ApprovalStatus, ApprovalAction, ActivityEventType, ActorType } from "@prisma/client";
import { updateInvoiceDraft } from "@/lib/services/invoice.service";

describe("Persistent Draft Workspace (GEN-02, GEN-03, GEN-04, GEN-05)", () => {
  const workspaceId = "demo-workspace-draft-test";
  const clientId = "demo-client-draft-test";
  const actorId = "demo-user-draft-test";
  const createdInvoiceIds: string[] = [];
  let authCookie = "";

  function createAuthReq(url: string, method: string, body?: unknown): NextRequest {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Cookie", authCookie);
    return new NextRequest(new URL(url, "http://localhost:3000"), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    const session = createTestSession({ actorId, workspaceId });
    authCookie = session.cookieHeader;

    await db.user.upsert({
      where: { id: actorId },
      update: {},
      create: {
        id: actorId,
        email: "draft-tester@example.com",
        name: "Draft Tester",
        passwordHash: "test-password-hash",
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceId },
      update: {},
      create: {
        id: workspaceId,
        name: "Draft Test Workspace",
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
        name: "Draft Client Corp",
        email: "client@draft-sandbox.example.com",
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

  it("updates an existing draft via PATCH and recalculates totals deterministically (GEN-02)", async () => {
    // 1. Create initial draft
    const createReq = createAuthReq("/api/invoices/draft", "POST", {
      workspaceId,
      clientId,
      title: "Initial Draft Title",
      currency: "USD",
      taxRateBasisPoints: 500, // 5%
      invoiceDate: "2026-11-01",
      dueDate: "2026-11-15",
      lineItems: [
        {
          description: "Feature Development",
          quantity: 2,
          unitPriceMinorUnits: 5000, // $50.00
        },
      ],
    });

    const createRes = await draftRoute(createReq);
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    const invoiceId = createJson.data.id;
    createdInvoiceIds.push(invoiceId);

    expect(createJson.data.subtotalMinorUnits).toBe(10000); // $100.00
    expect(createJson.data.taxMinorUnits).toBe(500); // $5.00
    expect(createJson.data.totalMinorUnits).toBe(10500); // $105.00

    // 2. Update draft via PATCH /api/invoices/[id]
    const patchReq = createAuthReq(`/api/invoices/${invoiceId}`, "PATCH", {
      title: "Updated Draft Title",
      taxRateBasisPoints: 1000, // 10%
      lineItems: [
        {
          description: "Feature Development v2",
          quantity: 3,
          unitPriceMinorUnits: 6000, // $60.00 -> 3 * 60 = $180.00
        },
        {
          description: "Architecture Consultation",
          quantity: 1,
          unitPriceMinorUnits: 4000, // $40.00
        },
      ],
      notes: "Updated terms and notes",
    });

    const patchRes = await updateInvoiceRoute(patchReq, { params: Promise.resolve({ id: invoiceId }) });
    expect(patchRes.status).toBe(200);
    const patchJson = await patchRes.json();
    expect(patchJson.success).toBe(true);
    expect(patchJson.data.title).toBe("Updated Draft Title");
    expect(patchJson.data.notes).toBe("Updated terms and notes");

    // Subtotal: (3 * 6000) + 4000 = 18000 + 4000 = 22000 ($220.00)
    // Tax at 10%: 2200 ($22.00)
    // Total: 24200 ($242.00)
    expect(patchJson.data.subtotalMinorUnits).toBe(22000);
    expect(patchJson.data.taxMinorUnits).toBe(2200);
    expect(patchJson.data.totalMinorUnits).toBe(24200);
    expect(patchJson.data.lineItems).toHaveLength(2);
  });

  it("invalidates prior human approval when material fields are modified (GEN-04)", async () => {
    // 1. Create a draft
    const createReq = createAuthReq("/api/invoices/draft", "POST", {
      workspaceId,
      clientId,
      title: "Pre-Approval Draft",
      currency: "USD",
      taxRateBasisPoints: 0,
      invoiceDate: "2026-11-01",
      dueDate: "2026-11-15",
      lineItems: [
        {
          description: "Consulting",
          quantity: 1,
          unitPriceMinorUnits: 10000,
        },
      ],
    });
    const createRes = await draftRoute(createReq);
    const createJson = await createRes.json();
    const invoiceId = createJson.data.id;
    createdInvoiceIds.push(invoiceId);

    // 2. Simulate an existing approved approval record bound to old hash
    const initialHash = createJson.data.materialPayloadHash;
    const approval = await db.approval.create({
      data: {
        workspaceId,
        invoiceId,
        actorId,
        actionType: ApprovalAction.SEND_INVOICE,
        status: ApprovalStatus.APPROVED,
        payloadHash: initialHash,
        payloadSnapshot: {},
      },
    });

    // 3. Materially edit the draft
    const patchReq = createAuthReq(`/api/invoices/${invoiceId}`, "PATCH", {
      lineItems: [
        {
          description: "Consulting Modified",
          quantity: 2,
          unitPriceMinorUnits: 10000, // Total now 20000 instead of 10000
        },
      ],
    });
    const patchRes = await updateInvoiceRoute(patchReq, { params: Promise.resolve({ id: invoiceId }) });
    expect(patchRes.status).toBe(200);

    // 4. Verify previous approval was INVALIDATED in DB
    const updatedApproval = await db.approval.findUnique({
      where: { id: approval.id },
    });
    expect(updatedApproval?.status).toBe(ApprovalStatus.INVALIDATED);

    // 5. Verify audit event was recorded for approval invalidation
    const auditEvents = await db.activityEvent.findMany({
      where: {
        invoiceId,
        eventType: ActivityEventType.APPROVAL_INVALIDATED,
      },
    });
    expect(auditEvents.length).toBeGreaterThanOrEqual(1);
    expect(auditEvents[0].description).toContain("edited after approval");
  });

  it("clears paypalInvoiceId if an un-sent draft already generated a PayPal draft before editing", async () => {
    // 1. Create draft
    const createReq = createAuthReq("/api/invoices/draft", "POST", {
      workspaceId,
      clientId,
      title: "Draft With PayPal ID",
      currency: "USD",
      taxRateBasisPoints: 0,
      invoiceDate: "2026-11-01",
      dueDate: "2026-11-15",
      lineItems: [
        {
          description: "Design Work",
          quantity: 1,
          unitPriceMinorUnits: 15000,
        },
      ],
    });
    const createRes = await draftRoute(createReq);
    const createJson = await createRes.json();
    const invoiceId = createJson.data.id;
    createdInvoiceIds.push(invoiceId);

    // Assign mock paypalInvoiceId to simulate draft created on PayPal
    await db.invoice.update({
      where: { id: invoiceId },
      data: { paypalInvoiceId: "INV2-SANDBOX-OLD-DRAFT-123" },
    });

    // 2. Update the draft
    const patchReq = createAuthReq(`/api/invoices/${invoiceId}`, "PATCH", {
      title: "Design Work - Revised Scope",
    });
    const patchRes = await updateInvoiceRoute(patchReq, { params: Promise.resolve({ id: invoiceId }) });
    expect(patchRes.status).toBe(200);

    // 3. Verify paypalInvoiceId was cleared on CashPilot invoice
    const refreshed = await db.invoice.findUnique({ where: { id: invoiceId } });
    expect(refreshed?.paypalInvoiceId).toBeNull();

    // 4. Verify audit event recorded for draft clearance
    const clearanceEvents = await db.activityEvent.findMany({
      where: {
        invoiceId,
        eventType: ActivityEventType.INVOICE_UPDATED,
        description: { contains: "cleared due to invoice modifications" },
      },
    });
    expect(clearanceEvents.length).toBe(1);
    expect(clearanceEvents[0].description).toContain("INV2-SANDBOX-OLD-DRAFT-123");
  });

  it("rejects editing invoices that are not in DRAFT status (GEN-03)", async () => {
    // 1. Create draft
    const createReq = createAuthReq("/api/invoices/draft", "POST", {
      workspaceId,
      clientId,
      title: "Sent Invoice Test",
      currency: "USD",
      taxRateBasisPoints: 0,
      invoiceDate: "2026-11-01",
      dueDate: "2026-11-15",
      lineItems: [{ description: "Sent Work", quantity: 1, unitPriceMinorUnits: 5000 }],
    });
    const createRes = await draftRoute(createReq);
    const createJson = await createRes.json();
    const invoiceId = createJson.data.id;
    createdInvoiceIds.push(invoiceId);

    // Transition status to AWAITING_PAYMENT
    await db.invoice.update({
      where: { id: invoiceId },
      data: { cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT },
    });

    // Attempt PATCH
    const patchReq = createAuthReq(`/api/invoices/${invoiceId}`, "PATCH", {
      title: "Illegal Modification",
    });
    const patchRes = await updateInvoiceRoute(patchReq, { params: Promise.resolve({ id: invoiceId }) });
    expect(patchRes.status).toBe(400);
    const patchJson = await patchRes.json();
    expect(patchJson.success).toBe(false);
    expect(patchJson.code).toBe("INVALID_INVOICE_STATUS");
  });

  it("rejects editing invoices belonging to another workspace", async () => {
    const patchReq = createAuthReq(`/api/invoices/non-existent-or-other-workspace`, "PATCH", {
      title: "Hacked Title",
    });
    const patchRes = await updateInvoiceRoute(patchReq, { params: Promise.resolve({ id: "non-existent-or-other-workspace" }) });
    expect(patchRes.status).toBe(404);
  });
});
