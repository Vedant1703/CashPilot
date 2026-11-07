/**
 * CashPilot AI — Demo Payment Simulation Tests (Phase 3C)
 *
 * Verifies:
 * 1. Successful demo simulation (updates provenance, status, activity event, ref, amount derived from DB).
 * 2. Non-demo workspace rejection (403).
 * 3. Non-demo invoice rejection (403).
 * 4. Unauthenticated / unauthorized requests (401 / 403).
 * 5. Duplicate simulation rejection (409 ALREADY_SIMULATED).
 * 6. Already PayPal-paid, cancelled, and refunded invoice rejections.
 * 7. Amount strictly derived from persisted invoice totals in DB.
 * 8. paypalStatus and paypalStatusRaw remain untouched.
 * 9. Zero PayPal API calls executed.
 * 10. Concurrent simulation requests handled safely.
 * 11. Collections Board presentation (metrics & grouping).
 * 12. Activity History & Journey Step 5 presentation.
 * 13. Ask Navi presentation and autonomous simulation refusal.
 * 14. Existing PayPal sync safety (preserves simulation on SENT, verifies on true PAID).
 *
 * Database safety: Strictly runs on cashpilot_disposable_test.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as simulatePaymentHandler } from "@/app/api/invoices/[id]/simulate-payment/route";
import {
  simulateDemoPayment,
  DEMO_WORKSPACE_ID,
  DEMO_USER_ID,
} from "@/lib/services/demo.service";
import { syncInvoiceWithPayPal } from "@/lib/services/invoice.service";
import { getInvoiceEndToEndTrace } from "@/lib/services/activity.service";
import { askNavi } from "@/lib/services/ask-navi.service";
import {
  calculateDashboardMetrics,
  groupInvoicesForCollections,
  getInvoiceProvenance,
  type InvoiceRecord,
} from "@/lib/dashboard/metrics";
import { db } from "@/lib/db/client";
import {
  createTestSession,
  clearTestSessions,
  assertAllowedTestDatabase,
  ensureTestUsers,
  cleanupTestUsers,
} from "@/lib/test-utils/auth";
import {
  CashPilotStatus,
  PaymentProvenance,
  ActivityEventType,
  ActorType,
} from "@prisma/client";
import * as paypalAdapter from "@/lib/paypal/adapter";

describe("Phase 3C: Safe Demo-Only Payment Simulation", () => {
  const nonDemoUserId = "user-reg-phase3c";
  const nonDemoWorkspaceId = "workspace-reg-phase3c";
  const nonDemoClientId = "client-reg-phase3c";
  const nonDemoInvoiceId = "invoice-reg-phase3c";

  const demoClientId = "demo-client-test-3c";
  const demoInvoiceId = "demo-inv-test-3c";

  let demoSession: { cookieHeader: string; sessionToken: string };
  let nonDemoSession: { cookieHeader: string; sessionToken: string };

  beforeAll(async () => {
    await assertAllowedTestDatabase();

    await ensureTestUsers([
      { id: DEMO_USER_ID, email: "demo@cashpilot.test", name: "Demo User" },
      { id: nonDemoUserId, email: "nondemo@cashpilot.test", name: "Regular User" },
    ]);

    demoSession = createTestSession({
      userId: DEMO_USER_ID,
      email: "demo@cashpilot.test",
      workspaceId: DEMO_WORKSPACE_ID,
      isDemo: true,
    });

    nonDemoSession = createTestSession({
      userId: nonDemoUserId,
      email: "nondemo@cashpilot.test",
      workspaceId: nonDemoWorkspaceId,
      isDemo: false,
    });

    // Ensure demo workspace
    await db.workspace.upsert({
      where: { id: DEMO_WORKSPACE_ID },
      update: { ownerId: DEMO_USER_ID, isDemo: true },
      create: {
        id: DEMO_WORKSPACE_ID,
        name: "My Freelance Studio",
        ownerId: DEMO_USER_ID,
        isDemo: true,
      },
    });

    // Ensure non-demo workspace
    await db.workspace.upsert({
      where: { id: nonDemoWorkspaceId },
      update: { ownerId: nonDemoUserId, isDemo: false },
      create: {
        id: nonDemoWorkspaceId,
        name: "Acme Regular Studio",
        ownerId: nonDemoUserId,
        isDemo: false,
      },
    });

    // Ensure non-demo client and invoice
    await db.client.upsert({
      where: { id: nonDemoClientId },
      update: { workspaceId: nonDemoWorkspaceId },
      create: {
        id: nonDemoClientId,
        workspaceId: nonDemoWorkspaceId,
        name: "Acme Customer",
        email: "billing@acme.test",
        isDemo: false,
      },
    });

    await db.invoice.upsert({
      where: { id: nonDemoInvoiceId },
      update: {
        workspaceId: nonDemoWorkspaceId,
        isDemoData: false,
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paymentProvenance: PaymentProvenance.NONE,
      },
      create: {
        id: nonDemoInvoiceId,
        workspaceId: nonDemoWorkspaceId,
        clientId: nonDemoClientId,
        number: "INV-REAL-100",
        currency: "USD",
        subtotalMinorUnits: 250000,
        taxRateBasisPoints: 0,
        taxMinorUnits: 0,
        totalMinorUnits: 250000,
        invoiceDate: new Date("2026-03-01"),
        dueDate: new Date("2026-03-15"),
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paypalInvoiceId: "INV2-REAL-TEST-1234",
        paypalStatus: "SENT",
        isDemoData: false,
      },
    });

    // Ensure demo client
    await db.client.upsert({
      where: { id: demoClientId },
      update: { workspaceId: DEMO_WORKSPACE_ID },
      create: {
        id: demoClientId,
        workspaceId: DEMO_WORKSPACE_ID,
        name: "Demo Horizon Studio",
        email: "demo-client@horizon.test",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();
    clearTestSessions();
    try {
      await db.activityEvent.deleteMany({ where: { workspaceId: nonDemoWorkspaceId } });
      await db.invoice.deleteMany({ where: { workspaceId: nonDemoWorkspaceId } });
      await db.client.deleteMany({ where: { workspaceId: nonDemoWorkspaceId } });
      await db.workspace.deleteMany({ where: { id: nonDemoWorkspaceId } });
    } catch {
      // ignore
    }
    await cleanupTestUsers([DEMO_USER_ID, nonDemoUserId]);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Reset demo invoice to fresh awaiting payment state
    await db.activityEvent.deleteMany({
      where: { invoiceId: demoInvoiceId },
    });

    await db.invoice.upsert({
      where: { id: demoInvoiceId },
      update: {
        workspaceId: DEMO_WORKSPACE_ID,
        clientId: demoClientId,
        number: "INV-DEMO-TEST-1",
        currency: "USD",
        subtotalMinorUnits: 150000,
        taxRateBasisPoints: 0,
        taxMinorUnits: 0,
        totalMinorUnits: 150000,
        invoiceDate: new Date("2026-03-01"),
        dueDate: new Date("2026-03-15"),
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paypalInvoiceId: "INV2-DEMO-SANDBOX-TEST",
        paypalStatus: "SENT",
        paypalStatusRaw: { status: "SENT", invoice: { id: "INV2-DEMO-SANDBOX-TEST" } },
        isDemoData: true,
        paymentProvenance: PaymentProvenance.NONE,
        simulatedPaymentAt: null,
        simulatedAmountMinorUnits: null,
        simulatedActorId: null,
        simulatedRef: null,
      },
      create: {
        id: demoInvoiceId,
        workspaceId: DEMO_WORKSPACE_ID,
        clientId: demoClientId,
        number: "INV-DEMO-TEST-1",
        currency: "USD",
        subtotalMinorUnits: 150000,
        taxRateBasisPoints: 0,
        taxMinorUnits: 0,
        totalMinorUnits: 150000,
        invoiceDate: new Date("2026-03-01"),
        dueDate: new Date("2026-03-15"),
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paypalInvoiceId: "INV2-DEMO-SANDBOX-TEST",
        paypalStatus: "SENT",
        paypalStatusRaw: { status: "SENT", invoice: { id: "INV2-DEMO-SANDBOX-TEST" } },
        isDemoData: true,
        paymentProvenance: PaymentProvenance.NONE,
      },
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Successful Simulation via Service & API
  // ─────────────────────────────────────────────────────────────────────────────

  it("successfully simulates payment on eligible demo invoice with strict audit and fields", async () => {
    const paypalSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
    const getDetailsSpy = vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus");

    const req = new NextRequest(`http://localhost:3000/api/invoices/${demoInvoiceId}/simulate-payment`, {
      method: "POST",
      headers: {
        cookie: demoSession.cookieHeader,
        "x-workspace-id": DEMO_WORKSPACE_ID,
      },
    });

    const res = await simulatePaymentHandler(req, {
      params: Promise.resolve({ id: demoInvoiceId }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.invoiceId).toBe(demoInvoiceId);
    expect(json.data.paymentProvenance).toBe("SIMULATED_DEMO_PAYMENT");
    expect(json.data.cashpilotStatus).toBe("SIMULATED_PAID");
    expect(json.data.simulatedAmountMinorUnits).toBe(150000);
    expect(json.data.currency).toBe("USD");
    expect(json.data.simulatedActorId).toBe(DEMO_USER_ID);
    expect(json.data.simulatedRef).toMatch(/^SIM-DEMO-/);

    // Verify database state
    const updated = await db.invoice.findUniqueOrThrow({
      where: { id: demoInvoiceId },
    });
    expect(updated.paymentProvenance).toBe(PaymentProvenance.SIMULATED_DEMO_PAYMENT);
    expect(updated.cashpilotStatus).toBe(CashPilotStatus.SIMULATED_PAID);
    expect(updated.simulatedAmountMinorUnits).toBe(150000);
    expect(updated.simulatedActorId).toBe(DEMO_USER_ID);
    expect(updated.simulatedRef).toMatch(/^SIM-DEMO-/);
    expect(updated.simulatedPaymentAt).toBeInstanceOf(Date);

    // INVARIANT 3: paypalStatus and paypalStatusRaw MUST remain untouched
    expect(updated.paypalStatus).toBe("SENT");
    expect((updated.paypalStatusRaw as { status: string })?.status).toBe("SENT");

    // INVARIANT 3: Zero PayPal API calls executed
    expect(paypalSpy).not.toHaveBeenCalled();
    expect(getDetailsSpy).not.toHaveBeenCalled();

    // Verify Activity History entry
    const activities = await db.activityEvent.findMany({
      where: { invoiceId: demoInvoiceId },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0].eventType).toBe(ActivityEventType.SYSTEM_EVENT);
    expect(activities[0].actorType).toBe(ActorType.USER);
    expect(activities[0].description).toContain("[SIMULATED PAYMENT]");
    expect(activities[0].description).toContain("no real money moved");
    expect(activities[0].metadata).toMatchObject({
      isDemoSimulation: true,
      simulatedAmountMinorUnits: 150000,
      currency: "USD",
      note: "Simulated payment — no real money moved. No PayPal Sandbox API calls executed.",
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Security Boundaries: Workspace, Invoice, and User Isolation
  // ─────────────────────────────────────────────────────────────────────────────

  it("strictly rejects simulation requests from non-demo workspace (403)", async () => {
    const req = new NextRequest(`http://localhost:3000/api/invoices/${demoInvoiceId}/simulate-payment`, {
      method: "POST",
      headers: {
        cookie: nonDemoSession.cookieHeader,
        "x-workspace-id": nonDemoWorkspaceId,
      },
    });

    const res = await simulatePaymentHandler(req, {
      params: Promise.resolve({ id: demoInvoiceId }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe("FORBIDDEN_DEMO_SIMULATION");
  });

  it("strictly rejects simulation of non-demo customer invoice (403)", async () => {
    const req = new NextRequest(`http://localhost:3000/api/invoices/${nonDemoInvoiceId}/simulate-payment`, {
      method: "POST",
      headers: {
        cookie: demoSession.cookieHeader,
        "x-workspace-id": DEMO_WORKSPACE_ID,
      },
    });

    const res = await simulatePaymentHandler(req, {
      params: Promise.resolve({ id: nonDemoInvoiceId }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe("NON_DEMO_INVOICE_REJECTED");

    // Verify non-demo invoice was completely untouched
    const untouched = await db.invoice.findUniqueOrThrow({
      where: { id: nonDemoInvoiceId },
    });
    expect(untouched.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
    expect(untouched.paymentProvenance).toBe(PaymentProvenance.NONE);
    expect(untouched.simulatedPaymentAt).toBeNull();
  });

  it("rejects unauthenticated requests (401)", async () => {
    const req = new NextRequest(`http://localhost:3000/api/invoices/${demoInvoiceId}/simulate-payment`, {
      method: "POST",
      headers: {},
    });

    const res = await simulatePaymentHandler(req, {
      params: Promise.resolve({ id: demoInvoiceId }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("UNAUTHORIZED");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. State Invariants: Duplicate, Already Paid, Cancelled, Refunded
  // ─────────────────────────────────────────────────────────────────────────────

  it("rejects duplicate simulation attempts (409 ALREADY_SIMULATED)", async () => {
    // First simulation
    const firstResult = await simulateDemoPayment({
      invoiceId: demoInvoiceId,
      actorId: DEMO_USER_ID,
    });
    expect(firstResult.ok).toBe(true);

    // Second simulation attempt
    const secondResult = await simulateDemoPayment({
      invoiceId: demoInvoiceId,
      actorId: DEMO_USER_ID,
    });
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect(secondResult.code).toBe("ALREADY_SIMULATED");
      expect(secondResult.status).toBe(409);
    }
  });

  it("rejects simulation of an invoice already verified as paid by PayPal (409 ALREADY_PAID)", async () => {
    await db.invoice.update({
      where: { id: demoInvoiceId },
      data: {
        cashpilotStatus: CashPilotStatus.PAID,
        paypalStatus: "PAID",
      },
    });

    const result = await simulateDemoPayment({
      invoiceId: demoInvoiceId,
      actorId: DEMO_USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ALREADY_PAID");
      expect(result.status).toBe(409);
    }
  });

  it("rejects simulation of a cancelled invoice (409 INVOICE_CANCELLED)", async () => {
    await db.invoice.update({
      where: { id: demoInvoiceId },
      data: {
        cashpilotStatus: CashPilotStatus.CANCELLED,
        paypalStatus: "CANCELLED",
      },
    });

    const result = await simulateDemoPayment({
      invoiceId: demoInvoiceId,
      actorId: DEMO_USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVOICE_CANCELLED");
      expect(result.status).toBe(409);
    }
  });

  it("rejects simulation of a refunded invoice (409 INVOICE_REFUNDED)", async () => {
    await db.invoice.update({
      where: { id: demoInvoiceId },
      data: {
        paypalStatus: "REFUNDED",
      },
    });

    const result = await simulateDemoPayment({
      invoiceId: demoInvoiceId,
      actorId: DEMO_USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVOICE_REFUNDED");
      expect(result.status).toBe(409);
    }
  });

  it("rejects simulation of a partially paid invoice (409 INVOICE_PARTIALLY_PAID)", async () => {
    await db.invoice.update({
      where: { id: demoInvoiceId },
      data: {
        paypalStatus: "PARTIALLY_PAID",
      },
    });

    const result = await simulateDemoPayment({
      invoiceId: demoInvoiceId,
      actorId: DEMO_USER_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVOICE_PARTIALLY_PAID");
      expect(result.status).toBe(409);
      expect(result.error).toContain("partially paid");
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Amount Integrity & Concurrency
  // ─────────────────────────────────────────────────────────────────────────────

  it("derives simulated amount strictly from persisted totalMinorUnits in DB", async () => {
    await db.invoice.update({
      where: { id: demoInvoiceId },
      data: {
        totalMinorUnits: 499999, // $4,999.99
      },
    });

    const result = await simulateDemoPayment({
      invoiceId: demoInvoiceId,
      actorId: DEMO_USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.simulatedAmountMinorUnits).toBe(499999);
    }

    const updated = await db.invoice.findUniqueOrThrow({
      where: { id: demoInvoiceId },
    });
    expect(updated.simulatedAmountMinorUnits).toBe(499999);
  });

  it("handles concurrent simulation requests safely", async () => {
    const results = await Promise.all([
      simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID }),
      simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID }),
    ]);

    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    // Exactly one succeeds; the second receives 409
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe("ALREADY_SIMULATED");

    // Only one activity event created
    const activityCount = await db.activityEvent.count({
      where: { invoiceId: demoInvoiceId },
    });
    expect(activityCount).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. PayPal Synchronization Safety
  // ─────────────────────────────────────────────────────────────────────────────

  it("preserves simulated provenance and status when PayPal sync returns non-PAID status (SENT) with accurate audit and API reporting", async () => {
    // First simulate payment
    await simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID });

    // Mock PayPal returning SENT (since PayPal was never touched)
    vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus").mockResolvedValueOnce({
      success: true,
      data: {
        status: "SENT",
        id: "INV2-DEMO-SANDBOX-TEST",
        detail: { invoice_number: "INV-DEMO-TEST-1" },
        amount: { currency_code: "USD", value: "1500.00" },
        due_date: "2026-03-15",
        payments: { paid_amount: { currency_code: "USD", value: "0.00" } },
      } as unknown as paypalAdapter.PayPalInvoiceResponse,
    });

    const syncResult = await syncInvoiceWithPayPal(DEMO_WORKSPACE_ID, DEMO_USER_ID, demoInvoiceId);
    expect(syncResult.ok).toBe(true);
    if (syncResult.ok) {
      // API return must report effective SIMULATED_PAID, not raw mapped status
      expect(syncResult.data.currentCashpilotStatus).toBe(CashPilotStatus.SIMULATED_PAID);
      expect(syncResult.data.currentPaypalStatus).toBe("SENT");
    }

    const afterSync = await db.invoice.findUniqueOrThrow({
      where: { id: demoInvoiceId },
    });

    // Provenance and CashPilot status remain simulated
    expect(afterSync.paymentProvenance).toBe(PaymentProvenance.SIMULATED_DEMO_PAYMENT);
    expect(afterSync.cashpilotStatus).toBe(CashPilotStatus.SIMULATED_PAID);
    expect(afterSync.simulatedAmountMinorUnits).toBe(150000);
    // Provider status is faithfully recorded as SENT
    expect(afterSync.paypalStatus).toBe("SENT");

    // Activity event description and metadata must reflect SIMULATED_PAID
    const latestEvent = await db.activityEvent.findFirst({
      where: { invoiceId: demoInvoiceId, eventType: ActivityEventType.STATUS_SYNC_SUCCESS },
      orderBy: { createdAt: "desc" },
    });
    expect(latestEvent).toBeDefined();
    expect(latestEvent?.description).toContain("Provider status: SENT → CashPilot: SIMULATED_PAID");
    const meta = latestEvent?.metadata as Record<string, unknown>;
    expect(meta?.cashpilotStatus).toBe(CashPilotStatus.SIMULATED_PAID);
  });

  it("preserves simulated provenance and status when PayPal sync returns UNPAID status", async () => {
    // First simulate payment
    await simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID });

    // Mock PayPal returning UNPAID
    vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus").mockResolvedValueOnce({
      success: true,
      data: {
        status: "UNPAID",
        id: "INV2-DEMO-SANDBOX-TEST",
        detail: { invoice_number: "INV-DEMO-TEST-1" },
        amount: { currency_code: "USD", value: "1500.00" },
        due_date: "2026-03-15",
        payments: { paid_amount: { currency_code: "USD", value: "0.00" } },
      } as unknown as paypalAdapter.PayPalInvoiceResponse,
    });

    const syncResult = await syncInvoiceWithPayPal(DEMO_WORKSPACE_ID, DEMO_USER_ID, demoInvoiceId);
    expect(syncResult.ok).toBe(true);
    if (syncResult.ok) {
      expect(syncResult.data.currentCashpilotStatus).toBe(CashPilotStatus.SIMULATED_PAID);
      expect(syncResult.data.currentPaypalStatus).toBe("UNPAID");
    }

    const afterSync = await db.invoice.findUniqueOrThrow({
      where: { id: demoInvoiceId },
    });
    expect(afterSync.paymentProvenance).toBe(PaymentProvenance.SIMULATED_DEMO_PAYMENT);
    expect(afterSync.cashpilotStatus).toBe(CashPilotStatus.SIMULATED_PAID);
  });

  it("handles failed PayPal sync safely without corrupting simulated payment status", async () => {
    // First simulate payment
    await simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID });

    // Mock PayPal API failure
    vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus").mockResolvedValueOnce({
      success: false,
      error: {
        message: "PayPal Sandbox API rate limit or network timeout",
        code: "RATE_LIMIT",
      },
    });

    const syncResult = await syncInvoiceWithPayPal(DEMO_WORKSPACE_ID, DEMO_USER_ID, demoInvoiceId);
    expect(syncResult.ok).toBe(false);

    const afterSync = await db.invoice.findUniqueOrThrow({
      where: { id: demoInvoiceId },
    });

    // Simulated status and provenance are strictly preserved, sync marked stale
    expect(afterSync.paymentProvenance).toBe(PaymentProvenance.SIMULATED_DEMO_PAYMENT);
    expect(afterSync.cashpilotStatus).toBe(CashPilotStatus.SIMULATED_PAID);
    expect(afterSync.syncIsStale).toBe(true);
  });

  it("rejects PayPal sync response when provider invoice ID does not match persisted ID", async () => {
    // Mock PayPal returning status for a different invoice ID
    vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus").mockResolvedValueOnce({
      success: true,
      data: {
        status: "PAID",
        id: "INV2-DIFFERENT-MISMATCHED-ID",
        detail: { invoice_number: "INV-OTHER" },
        amount: { currency_code: "USD", value: "9999.00" },
      } as unknown as paypalAdapter.PayPalInvoiceResponse,
    });

    const syncResult = await syncInvoiceWithPayPal(DEMO_WORKSPACE_ID, DEMO_USER_ID, demoInvoiceId);
    expect(syncResult.ok).toBe(false);
    if (!syncResult.ok) {
      expect(syncResult.code).toBe("PROVIDER_ID_MISMATCH");
      expect(syncResult.error).toContain("mismatch");
    }

    // Persisted invoice remains untouched
    const afterSync = await db.invoice.findUniqueOrThrow({
      where: { id: demoInvoiceId },
    });
    expect(afterSync.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
    expect(afterSync.paymentProvenance).toBe(PaymentProvenance.NONE);
  });

  it("transitions safely to PAYPAL_VERIFIED if true PayPal payment evidence arrives later", async () => {
    // First simulate payment
    await simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID });

    // Now PayPal genuinely returns PAID
    vi.spyOn(paypalAdapter, "getPayPalInvoiceStatus").mockResolvedValueOnce({
      success: true,
      data: {
        status: "PAID",
        id: "INV2-DEMO-SANDBOX-TEST",
        detail: { invoice_number: "INV-DEMO-TEST-1" },
        amount: { currency_code: "USD", value: "1500.00" },
        due_date: "2026-03-15",
        payments: {
          paid_amount: { currency_code: "USD", value: "1500.00" },
          transactions: [{ payment_id: "CAPTURE-REAL-123", amount: { value: "1500.00", currency_code: "USD" } }],
        },
      } as unknown as paypalAdapter.PayPalInvoiceResponse,
    });

    const syncResult = await syncInvoiceWithPayPal(DEMO_WORKSPACE_ID, DEMO_USER_ID, demoInvoiceId);
    expect(syncResult.ok).toBe(true);
    if (syncResult.ok) {
      expect(syncResult.data.currentCashpilotStatus).toBe(CashPilotStatus.PAID);
      expect(syncResult.data.currentPaypalStatus).toBe("PAID");
    }

    const afterSync = await db.invoice.findUniqueOrThrow({
      where: { id: demoInvoiceId },
    });

    // Verified PayPal evidence upgrades it to true PAID and PAYPAL_VERIFIED
    expect(afterSync.cashpilotStatus).toBe(CashPilotStatus.PAID);
    expect(afterSync.paymentProvenance).toBe(PaymentProvenance.PAYPAL_VERIFIED);
    expect(afterSync.paypalStatus).toBe("PAID");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Presentation: Collections Board, Journey Steps, Provenance, & Ask Navi
  // ─────────────────────────────────────────────────────────────────────────────

  it("groups simulated invoices in the paid collections column with distinct provenance badge", () => {
    const records: InvoiceRecord[] = [
      {
        id: demoInvoiceId,
        number: "INV-DEMO-TEST-1",
        title: "Demo Brand Identity",
        cashpilotStatus: CashPilotStatus.SIMULATED_PAID,
        paymentProvenance: "SIMULATED_DEMO_PAYMENT",
        paypalStatus: "SENT",
        paypalInvoiceId: "INV2-DEMO-TEST",
        isDemoData: true,
        aiDraftId: null,
        totalMinorUnits: 150000,
        currency: "USD",
        invoiceDate: new Date("2026-03-01"),
        dueDate: new Date("2026-03-15"),
        syncIsStale: false,
        client: { id: demoClientId, name: "Demo Horizon Studio", email: "demo-client@horizon.test" },
      },
    ];

    const collections = groupInvoicesForCollections(records);
    expect(collections.columns.paid).toHaveLength(1);
    expect(collections.columns.paid[0].id).toBe(demoInvoiceId);

    const provenance = getInvoiceProvenance(records[0]);
    expect(provenance.type).toBe("SIMULATED_DEMO_PAYMENT");
    expect(provenance.label).toBe("Simulated Payment · No real money moved");

    const metrics = calculateDashboardMetrics(records);
    // Excluded from unpaid receivables
    expect(metrics.outstanding.amountMinorUnits).toBe(0);
    expect(metrics.overdue.amountMinorUnits).toBe(0);
    expect(metrics.dueSoon.amountMinorUnits).toBe(0);
    expect(metrics.outstanding.count).toBe(0);
  });

  it("renders Journey Step 5 explicitly labeled as simulated payment (no real money moved)", async () => {
    await simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID });

    const trace = await getInvoiceEndToEndTrace(DEMO_WORKSPACE_ID, demoInvoiceId);
    expect(trace).toBeDefined();
    expect(trace?.steps).toHaveLength(5);

    const step5 = trace?.steps[4];
    expect(step5?.stepNumber).toBe(5);
    expect(step5?.status).toBe("completed");
    expect(step5?.title).toBe("Payment simulation (Demo)");
    expect(step5?.badgeLabel).toBe("Simulated");
    expect(step5?.summary).toContain("payment simulated (no real money moved)");
    expect(step5?.details).toContain("No PayPal API calls executed");
    expect(step5?.details).toContain("SIM-DEMO-");
  });

  it("Ask Navi refuses autonomous payment simulation and describes simulated payments accurately", async () => {
    // 1. Refusal test
    const refusalRes = await askNavi(
      DEMO_WORKSPACE_ID,
      "Simulate payment for invoice INV-DEMO-TEST-1 now please",
      DEMO_USER_ID
    );

    expect(refusalRes.ok).toBe(true);
    if (refusalRes.ok) {
      expect(refusalRes.data.message.content).toContain("Simulate Payment");
      expect(refusalRes.data.message.content).toContain("explicit human confirmation");
    }

    // 2. Query test after simulation
    await simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID });

    const paidQueryRes = await askNavi(
      DEMO_WORKSPACE_ID,
      "Which invoices have been paid?",
      DEMO_USER_ID
    );

    expect(paidQueryRes.ok).toBe(true);
    if (paidQueryRes.ok) {
      expect(paidQueryRes.data.message.content).toContain("SIMULATED DEMO PAYMENT");
      expect(paidQueryRes.data.message.content).toContain("No real money moved");
      expect(paidQueryRes.data.message.content).toContain("local demonstrations");
      expect(paidQueryRes.data.message.content).toContain("never PayPal-verified");
    }
  });

  it("Ask Navi excludes simulated payments from Open/Unpaid in client-specific queries and labels them explicitly", async () => {
    // Simulate payment on demo invoice for Demo Horizon Studio
    await simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID });

    const clientSummaryRes = await askNavi(
      DEMO_WORKSPACE_ID,
      "Summary for Demo Horizon Studio",
      DEMO_USER_ID
    );

    expect(clientSummaryRes.ok).toBe(true);
    if (clientSummaryRes.ok) {
      const content = clientSummaryRes.data.message.content;
      // Excluded from Open / Unpaid
      expect(content).toContain("• Open / Unpaid: 0 ($0.00)");
      // Explicitly listed in dedicated simulated bullet
      expect(content).toContain("• Simulated Paid (Demo — no real money moved): 1 ($1,500.00)");
      // Invoice detail line labeled explicitly as simulated demo payment
      expect(content).toContain("SIMULATED_PAID [Demo Simulation — No real money moved]");
    }
  });

  it("Ask Navi excludes simulated payments from due-today queries even if due date is today", async () => {
    // Set due date to today
    const today = new Date();
    await db.invoice.update({
      where: { id: demoInvoiceId },
      data: { dueDate: today },
    });

    await simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID });

    const dueTodayRes = await askNavi(
      DEMO_WORKSPACE_ID,
      "What is due today?",
      DEMO_USER_ID
    );

    expect(dueTodayRes.ok).toBe(true);
    if (dueTodayRes.ok) {
      const content = dueTodayRes.data.message.content;
      expect(content).toContain("No open invoices are due today");
      expect(content).not.toContain(demoInvoiceId);
    }
  });

  it("Ask Navi summarize-all and list-all queries report simulated payments separately and explicitly labeled", async () => {
    await simulateDemoPayment({ invoiceId: demoInvoiceId, actorId: DEMO_USER_ID });

    // 1. Summarize all
    const summarizeRes = await askNavi(
      DEMO_WORKSPACE_ID,
      "Summarize all invoices",
      DEMO_USER_ID
    );

    expect(summarizeRes.ok).toBe(true);
    if (summarizeRes.ok) {
      const content = summarizeRes.data.message.content;
      // Reports simulated paid separately
      expect(content).toContain("• Simulated Paid (Demo — no real money moved): 1 ($1,500.00)");
      // Paid remains PayPal confirmed and separate from simulated payments
      expect(content).toContain("— PayPal confirmed");
      expect(content).toContain("All Invoices Summary");
    }

    // 2. List all
    const listRes = await askNavi(
      DEMO_WORKSPACE_ID,
      "List all invoices",
      DEMO_USER_ID
    );

    expect(listRes.ok).toBe(true);
    if (listRes.ok) {
      const content = listRes.data.message.content;
      expect(content).toContain("SIMULATED_PAID [Demo Simulation — No real money moved]");
      expect(content).toContain("Demo Horizon Studio");
    }
  });
});
