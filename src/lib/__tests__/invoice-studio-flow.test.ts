/**
 * CashPilot AI — Invoice Studio Complete Journey Tests
 *
 * Primary user journey:
 * Describe invoice in natural language -> Extract structured fields ->
 * Review & edit draft -> Calculate totals deterministically ->
 * Approve exact material payload hash -> Create PayPal Sandbox draft ->
 * Verify provider outcome.
 *
 * Financial Integrity & Safety Invariants:
 * - AI output is untrusted proposal.
 * - Server calculates authoritative totals and hashes.
 * - Approval is bound to the exact SHA-256 material payload hash.
 * - Material field change invalidates prior approval.
 * - PayPal draft creation preserves DRAFT status (NEVER marked PAID or SENT).
 * - Draft creation never calls external send, reminders, cancellation, or payments.
 * - Timeout records UNKNOWN outcome and does not blindly retry.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { POST as extractRoute } from "@/app/api/invoices/extract/route";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as paypalDraftRoute } from "@/app/api/invoices/[id]/paypal-draft/route";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import { CashPilotStatus, OperationAttemptState } from "@prisma/client";
import { createTestSession, ensureTestUsers, cleanupTestUsers, assertAllowedTestDatabase } from "@/lib/test-utils/auth";

describe("Invoice Drafting Studio Full Journey", () => {
  const workspaceId = "demo-workspace-studio-flow";
  const userId = "demo-user-studio-flow";
  const clientId = "demo-client-studio-flow";

  let session: { cookieHeader: string; sessionToken: string };

  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const remindInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalReminder");
  const cancelInvoiceSpy = vi.spyOn(paypalAdapter, "cancelPayPalInvoice");

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([{ id: userId, email: "studio@example.com", name: "Studio Flow Owner" }]);
    session = createTestSession({ userId, workspaceId, email: "studio@example.com" });

    // Setup test workspace and client in PostgreSQL
    await db.workspace.upsert({
      where: { id: workspaceId },
      update: { ownerId: userId },
      create: {
        id: workspaceId,
        name: "Studio Flow Workspace",
        ownerId: userId,
      },
    });

    await db.client.upsert({
      where: { id: clientId },
      update: { name: "Studio Acme", email: "acme@studioflow.com" },
      create: {
        id: clientId,
        workspaceId,
        name: "Studio Acme",
        email: "acme@studioflow.com",
      },
    });
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();
    vi.restoreAllMocks();
    await db.activityEvent.deleteMany({ where: { workspaceId } });
    await db.externalOperation.deleteMany({ where: { workspaceId } });
    await db.approval.deleteMany({ where: { workspaceId } });
    await db.invoiceLineItem.deleteMany({ where: { invoice: { workspaceId } } });
    await db.invoice.deleteMany({ where: { workspaceId } });
    await db.client.deleteMany({ where: { workspaceId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await cleanupTestUsers([userId]);
  });

  it("completes full end-to-end journey from prompt to confirmed PayPal draft", async () => {
    // -------------------------------------------------------------
    // STEP 1: Describe & Extract
    // -------------------------------------------------------------
    const extractReq = new NextRequest("http://localhost:3000/api/invoices/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({
        prompt: "Invoice Studio Acme for 10 hours of backend architecture at $150 per hour, net 14, 10% tax",
      }),
    });

    const extractRes = await extractRoute(extractReq);
    const extractJson = await extractRes.json();

    expect(extractRes.status).toBe(200);
    expect(extractJson.success).toBe(true);
    expect(extractJson.data.extractedDraft.clientName).toBe("Studio Acme");
    expect(extractJson.data.extractedDraft.lineItems?.[0].quantity).toBe(10);
    expect(extractJson.data.extractedDraft.lineItems?.[0].unitPriceDecimal).toBe("150.00");
    expect(extractJson.data.extractedDraft.taxRatePercent).toBe(10);

    // -------------------------------------------------------------
    // STEP 2: Review & Persist Draft with Server-calculated Totals
    // -------------------------------------------------------------
    // 10 qty * $150.00 = $1,500.00 (150,000 cents). Tax 10% = $150.00 (15,000 cents). Total = $1,650.00 (165,000 cents)
    const draftReq = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({
        clientId,
        title: "Backend Architecture Consulting",
        currency: "USD",
        taxRateBasisPoints: 1000, // 10%
        invoiceDate: "2026-10-21",
        dueDate: "2026-11-04",
        lineItems: [
          {
            description: "Backend Architecture",
            quantity: 10,
            unitPriceMinorUnits: 15000,
          },
        ],
      }),
    });

    const draftRes = await draftRoute(draftReq);
    const draftJson = await draftRes.json();

    expect(draftRes.status).toBe(201);
    expect(draftJson.success).toBe(true);
    expect(draftJson.data.cashpilotStatus).toBe(CashPilotStatus.DRAFT);
    expect(draftJson.data.subtotalMinorUnits).toBe(150000);
    expect(draftJson.data.taxMinorUnits).toBe(15000);
    expect(draftJson.data.totalMinorUnits).toBe(165000);
    expect(draftJson.data.materialPayloadHash).toBeDefined();

    const invoiceId = draftJson.data.id;
    const originalHash = draftJson.data.materialPayloadHash;

    // Highest priority check: Ensure materialPayloadHash is a valid 64-char hex SHA-256 and NEVER empty-string SHA-256
    const EMPTY_STRING_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(originalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(originalHash).not.toBe(EMPTY_STRING_SHA256);

    // Negative verification: Submitting empty string SHA-256 hash is rejected with 409 STALE_PAYLOAD_HASH
    const rejectReq = new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({
        actionType: "SEND_INVOICE",
        reviewedPayloadHash: EMPTY_STRING_SHA256,
      }),
    });
    const rejectRes = await approveRoute(rejectReq, {
      params: Promise.resolve({ id: invoiceId }),
    });
    expect(rejectRes.status).toBe(409);
    const rejectJson = await rejectRes.json();
    expect(rejectJson.code).toBe("STALE_PAYLOAD_HASH");

    // -------------------------------------------------------------
    // STEP 3: Human Approval Bound to Exact Material Hash
    // -------------------------------------------------------------
    const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({
        actionType: "SEND_INVOICE",
        reviewedPayloadHash: originalHash,
      }),
    });

    const approveRes = await approveRoute(approveReq, {
      params: Promise.resolve({ id: invoiceId }),
    });
    const approveJson = await approveRes.json();

    expect(approveRes.status).toBe(200);
    expect(approveJson.success).toBe(true);
    expect(approveJson.data.status).toBe("APPROVED");
    expect(approveJson.data.approvedPayloadHash).toBe(originalHash);

    const approvalId = approveJson.data.approvalId;

    // -------------------------------------------------------------
    // STEP 4: PayPal Sandbox Draft Creation
    // -------------------------------------------------------------
    createDraftSpy.mockResolvedValueOnce({
      success: true,
      data: {
        id: "INV2-STUDIO-FLOW-1234",
        status: "DRAFT",
        detail: { currency_code: "USD" },
      },
      correlationId: "debug-studio-flow-1",
    });

    const paypalDraftReq = new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({ approvalId }),
    });

    const paypalDraftRes = await paypalDraftRoute(paypalDraftReq, {
      params: Promise.resolve({ id: invoiceId }),
    });
    const paypalDraftJson = await paypalDraftRes.json();

    expect(paypalDraftRes.status).toBe(201);
    expect(paypalDraftJson.success).toBe(true);
    expect(paypalDraftJson.data.paypalInvoiceId).toBe("INV2-STUDIO-FLOW-1234");
    expect(paypalDraftJson.data.paypalStatus).toBe("DRAFT");

    // Invariant: local workflow status remains DRAFT, NOT SENT, NOT PAID
    const verifiedDbInvoice = await db.invoice.findUnique({ where: { id: invoiceId } });
    expect(verifiedDbInvoice?.cashpilotStatus).toBe(CashPilotStatus.DRAFT);
    expect(verifiedDbInvoice?.paypalInvoiceId).toBe("INV2-STUDIO-FLOW-1234");
    expect(verifiedDbInvoice?.paypalStatus).toBe("DRAFT");

    // Invariant: external sending/reminder/cancellation was NEVER called
    expect(sendInvoiceSpy).not.toHaveBeenCalled();
    expect(remindInvoiceSpy).not.toHaveBeenCalled();
    expect(cancelInvoiceSpy).not.toHaveBeenCalled();
  });

  it("invalidates approval if a material field changes before PayPal draft execution", async () => {
    // 1. Create a draft invoice
    const draftReq = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({
        clientId,
        title: "Advisory Services",
        currency: "USD",
        taxRateBasisPoints: 0,
        invoiceDate: "2026-10-21",
        dueDate: "2026-11-04",
        lineItems: [
          {
            description: "Advisory Session",
            quantity: 1,
            unitPriceMinorUnits: 50000,
          },
        ],
      }),
    });

    const draftRes = await draftRoute(draftReq);
    const draftJson = await draftRes.json();
    const invoiceId = draftJson.data.id;
    const initialHash = draftJson.data.materialPayloadHash;

    // 2. Approve initial payload
    const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({
        actionType: "SEND_INVOICE",
        reviewedPayloadHash: initialHash,
      }),
    });

    const approveRes = await approveRoute(approveReq, {
      params: Promise.resolve({ id: invoiceId }),
    });
    const approveJson = await approveRes.json();
    expect(approveRes.status).toBe(200);

    // 3. Mutate a material field (e.g. increase total in database after approval)
    await db.invoice.update({
      where: { id: invoiceId },
      data: { totalMinorUnits: 999999 },
    });

    // 4. Attempting to create PayPal draft with old approval MUST be rejected (409 Conflict: stale hash)
    const paypalDraftReq = new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({ approvalId: approveJson.data.approvalId }),
    });

    const paypalDraftRes = await paypalDraftRoute(paypalDraftReq, {
      params: Promise.resolve({ id: invoiceId }),
    });
    const paypalDraftJson = await paypalDraftRes.json();

    expect(paypalDraftRes.status).toBe(409);
    expect(paypalDraftJson.success).toBe(false);
    expect(paypalDraftJson.code).toBe("APPROVAL_STALE");
  });

  it("handles PayPal timeout by recording UNKNOWN outcome and returning 504 without blind retry", async () => {
    // 1. Create a draft invoice
    const draftReq = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({
        clientId,
        title: "Timeout Test Service",
        currency: "USD",
        taxRateBasisPoints: 0,
        invoiceDate: "2026-10-21",
        dueDate: "2026-11-04",
        lineItems: [
          {
            description: "Consulting",
            quantity: 1,
            unitPriceMinorUnits: 25000,
          },
        ],
      }),
    });

    const draftRes = await draftRoute(draftReq);
    const draftJson = await draftRes.json();
    const invoiceId = draftJson.data.id;
    const hash = draftJson.data.materialPayloadHash;

    // 2. Approve
    const approveReq = new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({
        actionType: "SEND_INVOICE",
        reviewedPayloadHash: hash,
      }),
    });
    const approveRes = await approveRoute(approveReq, {
      params: Promise.resolve({ id: invoiceId }),
    });
    const approveJson = await approveRes.json();

    // 3. Mock PayPal draft creation timing out
    createDraftSpy.mockResolvedValueOnce({
      success: false,
      isOutcomeUnknown: true,
      error: {
        code: "TIMEOUT",
        message: "PayPal draft creation timed out",
      },
      correlationId: "debug-timeout-flow",
    });

    const paypalDraftReq = new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({ approvalId: approveJson.data.approvalId }),
    });

    const paypalDraftRes = await paypalDraftRoute(paypalDraftReq, {
      params: Promise.resolve({ id: invoiceId }),
    });
    const paypalDraftJson = await paypalDraftRes.json();

    expect(paypalDraftRes.status).toBe(504);
    expect(paypalDraftJson.success).toBe(false);
    expect(paypalDraftJson.code).toBe("OPERATION_UNKNOWN_OUTCOME");

    // Invariant: Recorded as UNKNOWN outcome in ExternalOperation audit log
    const extOp = await db.externalOperation.findFirst({
      where: { invoiceId },
      orderBy: { createdAt: "desc" },
    });

    expect(extOp).not.toBeNull();
    expect(extOp?.attemptState).toBe(OperationAttemptState.UNKNOWN);
    expect(extOp?.isOutcomeUnknown).toBe(true);
  });

  it("rejects unauthenticated requests throughout the flow with 401 Unauthorized", async () => {
    const unauthReq = new NextRequest("http://localhost:3000/api/invoices/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Test unauthenticated extract" }),
    });

    const res = await extractRoute(unauthReq);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("UNAUTHORIZED");
  });
});
