/**
 * CashPilot AI — Tax & PayPal Financial Consistency Tests (GEN-08)
 *
 * Verifies:
 * - Line item tax mapping in PayPal API invoice payloads
 * - Zero tax, 5% tax, and fractional tax percentage formatting
 * - Provider response total reconciliation against CashPilot server-calculated totals
 * - Immediate rejection, operation FAILED state, and transition to NEEDS_REVIEW upon provider total mismatch
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import {
  buildPayPalInvoicePayload,
  createInvoice,
  approveInvoice,
  createPayPalDraft,
} from "@/lib/services/invoice.service";
import {
  ApprovalAction,
  OperationAttemptState,
  CashPilotStatus,
} from "@prisma/client";
import {
  createTestSession,
  ensureTestUsers,
  assertAllowedTestDatabase,
} from "@/lib/test-utils/auth";
import { computeInvoiceTotals } from "@/lib/money";

describe("GEN-08: Tax & Total Consistency between CashPilot and PayPal", () => {
  const workspaceId = "demo-workspace-tax-test";
  const ownerId = "demo-user-tax-test";
  const clientId = "demo-client-tax-test";

  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([
      { id: ownerId, email: "tax-test-owner@example.com", name: "Tax Test Owner" },
    ]);

    await db.workspace.upsert({
      where: { id: workspaceId },
      update: { ownerId },
      create: {
        id: workspaceId,
        name: "Tax Test Workspace",
        ownerId,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientId },
      update: {},
      create: {
        id: clientId,
        workspaceId,
        name: "Acme Tax QA Client",
        email: "accounts@tax-qa.example.com",
        isDemo: true,
      },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildPayPalInvoicePayload tax mapping", () => {
    it("omits tax property on line items when taxRateBasisPoints is 0", async () => {
      const createRes = await createInvoice(workspaceId, ownerId, {
        clientId,
        title: "Zero Tax Invoice",
        currency: "USD",
        taxRateBasisPoints: 0,
        invoiceDate: "2026-11-06",
        dueDate: "2026-11-20",
        lineItems: [
          { description: "Consulting", quantity: 10, unitPriceMinorUnits: 15000 },
        ],
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const invoice = await db.invoice.findUniqueOrThrow({
        where: { id: createRes.data.invoiceId },
        include: { client: true, lineItems: true },
      });

      const payload = buildPayPalInvoicePayload(invoice);
      expect(payload.items[0].tax).toBeUndefined();
      expect(payload.items[0].unit_amount.value).toBe("150.00");
    });

    it("attaches sales tax with 5% when taxRateBasisPoints is 500 (QA reported scenario)", async () => {
      // Subtotal: 10 * $145.00 = $1,450.00
      // 5% tax = $72.50
      // Total = $1,522.50
      const createRes = await createInvoice(workspaceId, ownerId, {
        clientId,
        title: "5 Percent Tax Invoice",
        currency: "USD",
        taxRateBasisPoints: 500,
        invoiceDate: "2026-11-06",
        dueDate: "2026-11-20",
        lineItems: [
          { description: "System Architecture", quantity: 10, unitPriceMinorUnits: 14500 },
        ],
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      expect(createRes.data.invoice.subtotalMinorUnits).toBe(145000);
      expect(createRes.data.invoice.taxMinorUnits).toBe(7250);
      expect(createRes.data.invoice.totalMinorUnits).toBe(152250);

      const invoice = await db.invoice.findUniqueOrThrow({
        where: { id: createRes.data.invoiceId },
        include: { client: true, lineItems: true },
      });

      const payload = buildPayPalInvoicePayload(invoice);
      expect(payload.items[0].tax).toEqual({
        name: "Sales Tax",
        percent: "5",
      });
      expect(payload.items[0].unit_amount.value).toBe("145.00");
    });

    it("formats fractional tax rates correctly (e.g. 7.25% for 725 basis points)", async () => {
      const createRes = await createInvoice(workspaceId, ownerId, {
        clientId,
        title: "Fractional Tax Invoice",
        currency: "USD",
        taxRateBasisPoints: 725,
        invoiceDate: "2026-11-06",
        dueDate: "2026-11-20",
        lineItems: [
          { description: "Design", quantity: 2, unitPriceMinorUnits: 10000 },
        ],
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const invoice = await db.invoice.findUniqueOrThrow({
        where: { id: createRes.data.invoiceId },
        include: { client: true, lineItems: true },
      });

      const payload = buildPayPalInvoicePayload(invoice);
      expect(payload.items[0].tax).toEqual({
        name: "Sales Tax",
        percent: "7.25",
      });
    });
  });

  describe("Provider response total reconciliation (createPayPalDraft)", () => {
    it("successfully creates and links draft when PayPal returned total matches CashPilot total", async () => {
      const createRes = await createInvoice(workspaceId, ownerId, {
        clientId,
        title: "Matching Total Verification",
        currency: "USD",
        taxRateBasisPoints: 500, // 5% tax
        invoiceDate: "2026-11-06",
        dueDate: "2026-11-20",
        lineItems: [
          { description: "Services", quantity: 10, unitPriceMinorUnits: 14500 },
        ],
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const invoiceId = createRes.data.invoiceId;

      // Approve invoice
      const approveRes = await approveInvoice(
        workspaceId,
        ownerId,
        invoiceId,
        ApprovalAction.SEND_INVOICE,
        createRes.data.materialPayloadHash
      );
      expect(approveRes.ok).toBe(true);

      // Mock PayPal returning matching $1,522.50
      createDraftSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: "INV2-MATCHING-001",
          status: "DRAFT",
          detail: { currency_code: "USD" },
          amount: {
            currency_code: "USD",
            value: "1522.50",
            breakdown: {
              item_total: { currency_code: "USD", value: "1450.00" },
              tax_total: { currency_code: "USD", value: "72.50" },
            },
          },
        },
        correlationId: "paypal-corr-match-123",
      });

      const draftResult = await createPayPalDraft(workspaceId, ownerId, invoiceId);
      expect(draftResult.ok).toBe(true);
      if (!draftResult.ok) return;

      expect(draftResult.data.paypalInvoiceId).toBe("INV2-MATCHING-001");
      expect(draftResult.data.paypalStatus).toBe("DRAFT");

      // Verify DB persistence
      const persisted = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(persisted.paypalInvoiceId).toBe("INV2-MATCHING-001");
      expect(persisted.cashpilotStatus).toBe(CashPilotStatus.DRAFT);
    });

    it("rejects draft and transitions invoice to NEEDS_REVIEW when PayPal returned total does not match CashPilot total", async () => {
      const createRes = await createInvoice(workspaceId, ownerId, {
        clientId,
        title: "Mismatched Total Detection",
        currency: "USD",
        taxRateBasisPoints: 500, // 5% tax -> expected $1,522.50 (152250 minor units)
        invoiceDate: "2026-11-06",
        dueDate: "2026-11-20",
        lineItems: [
          { description: "Services", quantity: 10, unitPriceMinorUnits: 14500 },
        ],
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const invoiceId = createRes.data.invoiceId;

      const approveRes = await approveInvoice(
        workspaceId,
        ownerId,
        invoiceId,
        ApprovalAction.SEND_INVOICE,
        createRes.data.materialPayloadHash
      );
      expect(approveRes.ok).toBe(true);

      // Simulate the exact bug from QA: PayPal returns $1,450.00 (tax omitted)
      createDraftSpy.mockResolvedValueOnce({
        success: true,
        data: {
          id: "INV2-MISMATCH-DRAFT-002",
          status: "DRAFT",
          detail: { currency_code: "USD" },
          amount: {
            currency_code: "USD",
            value: "1450.00", // Mismatched! Missing $72.50 tax
          },
        },
        correlationId: "paypal-corr-mismatch-456",
      });

      const draftResult = await createPayPalDraft(workspaceId, ownerId, invoiceId);
      expect(draftResult.ok).toBe(false);
      if (draftResult.ok) return;
      expect(draftResult.code).toBe("TOTAL_MISMATCH");
      expect(draftResult.error).toContain("does not match CashPilot authoritative total");

      // Verify invoice is transitioned to NEEDS_REVIEW and not linked
      const persisted = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(persisted.cashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);
      expect(persisted.syncIsStale).toBe(true);
      expect(persisted.paypalInvoiceId).toBeNull(); // Must NOT store provider ID on mismatch!

      // Verify operation audit
      const op = await db.externalOperation.findFirst({
        where: { invoiceId },
        orderBy: { attemptedAt: "desc" },
      });
      expect(op?.attemptState).toBe(OperationAttemptState.FAILED);
      expect(op?.errorCode).toBe("TOTAL_MISMATCH");
    });
  });
});
