/**
 * CashPilot AI — PayPal Recipient & Account Flow Tests (GEN-06, USER-02)
 *
 * Verifies:
 * 1. CashPilot recipient email matches the exact trimmed email submitted to PayPal Invoicing v2.
 * 2. Surfaces rich PayPal provider errors, correlation IDs (paypal-debug-id), and actionable self-billing guidance.
 * 3. Failed calls never transition invoice to SENT/PAID or create false success audit records.
 * 4. User Workspace (isDemo = false) operates with full authorization isolation and cannot access demo simulation.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as sendRoute } from "@/app/api/invoices/[id]/send/route";
import { POST as paypalDraftRoute } from "@/app/api/invoices/[id]/paypal-draft/route";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";
import { formatPayPalErrorMessage } from "@/lib/paypal/adapter";
import { buildPayPalInvoicePayload } from "@/lib/services/invoice.service";
import {
  ApprovalAction,
  OperationType,
  OperationAttemptState,
  CashPilotStatus,
} from "@prisma/client";
import {
  createTestSession,
  ensureTestUsers,
  cleanupTestUsers,
  assertAllowedTestDatabase,
} from "@/lib/test-utils/auth";

describe("PayPal Sandbox Recipient & Account Behavior (GEN-06, USER-02)", () => {
  const userWorkspaceId = "user-workspace-recipient-1";
  const userOwnerId = "user-recipient-owner-1";
  const clientRecipientId = "client-recipient-1";

  const demoWorkspaceId = "demo-workspace-recipient-1";
  const demoOwnerId = "demo-recipient-owner-1";
  const demoClientId = "client-recipient-demo-1";

  let userSession: { cookieHeader: string; sessionToken: string };
  let demoSession: { cookieHeader: string; sessionToken: string };

  const createdInvoiceIds: string[] = [];

  const createDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const sendInvoiceSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");

  beforeAll(async () => {
    await assertAllowedTestDatabase();

    await ensureTestUsers([
      { id: userOwnerId, email: "user.freelancer@example.com", name: "User Freelancer" },
      { id: demoOwnerId, email: "demo.freelancer@example.com", name: "Demo Freelancer" },
    ]);

    await db.workspace.upsert({
      where: { id: userWorkspaceId },
      update: { ownerId: userOwnerId, isDemo: false },
      create: {
        id: userWorkspaceId,
        name: "User Client Workspace",
        ownerId: userOwnerId,
        isDemo: false,
      },
    });

    await db.workspace.upsert({
      where: { id: demoWorkspaceId },
      update: { ownerId: demoOwnerId, isDemo: true },
      create: {
        id: demoWorkspaceId,
        name: "Demo Client Workspace",
        ownerId: demoOwnerId,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientRecipientId },
      update: {
        workspaceId: userWorkspaceId,
        name: "Alice Recipient",
        email: "alice.buyer@personal.example.com",
        isDemo: false,
      },
      create: {
        id: clientRecipientId,
        workspaceId: userWorkspaceId,
        name: "Alice Recipient",
        email: "alice.buyer@personal.example.com",
        isDemo: false,
      },
    });

    await db.client.upsert({
      where: { id: demoClientId },
      update: {
        workspaceId: demoWorkspaceId,
        name: "Demo Recipient",
        email: "demo.buyer@personal.example.com",
        isDemo: true,
      },
      create: {
        id: demoClientId,
        workspaceId: demoWorkspaceId,
        name: "Demo Recipient",
        email: "demo.buyer@personal.example.com",
        isDemo: true,
      },
    });

    userSession = createTestSession({
      userId: userOwnerId,
      workspaceId: userWorkspaceId,
      isDemo: false,
    });
    demoSession = createTestSession({
      userId: demoOwnerId,
      workspaceId: demoWorkspaceId,
      isDemo: true,
    });
  });

  afterAll(async () => {
    if (createdInvoiceIds.length > 0) {
      await db.activityEvent.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
      await db.externalOperation.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
      await db.approval.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
      await db.invoiceLineItem.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
      await db.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
    }

    await db.client.deleteMany({ where: { id: { in: [clientRecipientId, demoClientId] } } });
    await db.workspace.deleteMany({ where: { id: { in: [userWorkspaceId, demoWorkspaceId] } } });
    await cleanupTestUsers([userOwnerId, demoOwnerId]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatPayPalErrorMessage diagnostics", () => {
    it("surfaces CANNOT_PAY_OWN_INVOICE with actionable self-billing explanation", () => {
      const errorBody = {
        name: "UNPROCESSABLE_ENTITY",
        message: "Invalid request - see details",
        debug_id: "debug-12345",
        details: [
          {
            field: "/primary_recipients/0/billing_info/email_address",
            issue: "CANNOT_PAY_OWN_INVOICE",
            description: "Invoice recipient email address cannot be the same as the merchant email address.",
          },
        ],
      };

      const formatted = formatPayPalErrorMessage(errorBody, 422);
      expect(formatted).toContain("Cannot bill your own PayPal account");
      expect(formatted).toContain("recipient email must differ from the merchant account");
      expect(formatted).toContain("/primary_recipients/0/billing_info/email_address");
    });

    it("surfaces other validation errors with field details", () => {
      const errorBody = {
        name: "VALIDATION_ERROR",
        message: "Validation Error",
        details: [
          {
            field: "/detail/payment_term/due_date",
            issue: "INVALID_DATE_FORMAT",
            description: "The date format is invalid.",
          },
        ],
      };

      const formatted = formatPayPalErrorMessage(errorBody, 400);
      expect(formatted).toContain("Validation Error: The date format is invalid.");
      expect(formatted).toContain("[field: /detail/payment_term/due_date]");
    });

    it("falls back gracefully when error body has no details", () => {
      const formatted = formatPayPalErrorMessage({}, 500, "Provider down");
      expect(formatted).toBe("Provider down (HTTP 500)");
    });
  });

  describe("Recipient Data Sanitization and PayPal Payload Building", () => {
    it("trims whitespace from recipient email and name in buildPayPalInvoicePayload", () => {
      const dummyInvoice = {
        id: "inv-test-1",
        workspaceId: userWorkspaceId,
        clientId: clientRecipientId,
        number: "INV-001",
        title: "Services",
        notes: null,
        terms: null,
        currency: "USD",
        subtotalMinorUnits: 10000,
        taxRateBasisPoints: 0,
        taxMinorUnits: 0,
        totalMinorUnits: 10000,
        invoiceDate: new Date("2026-11-01"),
        dueDate: new Date("2026-11-20"),
        cashpilotStatus: CashPilotStatus.DRAFT,
        paypalInvoiceId: null,
        paypalStatus: null,
        paypalStatusRaw: null,
        lastSyncAt: null,
        syncIsStale: false,
        isDemoData: false,
        aiDraftId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        client: {
          id: clientRecipientId,
          workspaceId: userWorkspaceId,
          name: "  Jane Doe  ",
          email: "   sb-agk6m53482767@personal.example.com   ",
          company: null,
          phone: null,
          notes: null,
          isDemo: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        lineItems: [
          {
            id: "li-1",
            invoiceId: "inv-test-1",
            description: "Consulting",
            quantity: 1,
            unitPriceMinorUnits: 10000,
            totalMinorUnits: 10000,
          },
        ],
      };

      const payload = buildPayPalInvoicePayload(dummyInvoice as any);
      expect(payload.primary_recipients[0].billing_info.email_address).toBe(
        "sb-agk6m53482767@personal.example.com"
      );
      expect(payload.primary_recipients[0].billing_info.name?.given_name).toBe("Jane");
      expect(payload.primary_recipients[0].billing_info.name?.surname).toBe("Doe");
    });
  });

  describe("User Workspace Recipient Flow (USER-02 & GEN-06)", () => {
    it("executes create draft and reports rich PayPal error details with correlation ID if rejected", async () => {
      // 1. Create invoice in User Workspace
      const draftRes = await draftRoute(
        new NextRequest("http://localhost:3000/api/invoices/draft", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: userSession.cookieHeader,
          },
          body: JSON.stringify({
            clientId: clientRecipientId,
            currency: "USD",
            taxRateBasisPoints: 0,
            invoiceDate: "2026-11-06",
            dueDate: "2026-11-20",
            lineItems: [{ description: "Design System", quantity: 1, unitPriceMinorUnits: 25000 }],
          }),
        })
      );
      const draftJson = await draftRes.json();
      expect(draftRes.status).toBe(201);
      const invoiceId = draftJson.data.id;
      const materialPayloadHash = draftJson.data.materialPayloadHash as string;
      createdInvoiceIds.push(invoiceId);

      // 2. Approve invoice for sending
      const approveRes = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: userSession.cookieHeader,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: materialPayloadHash,
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      expect(approveRes.status).toBe(200);

      // 3. Mock PayPal draft creation failure with CANNOT_PAY_OWN_INVOICE details and correlation ID
      createDraftSpy.mockResolvedValueOnce({
        success: false,
        correlationId: "debug-paypal-recipient-err-999",
        error: {
          code: "CANNOT_PAY_OWN_INVOICE",
          message:
            "PayPal API error: 422: Cannot bill your own PayPal account. In PayPal Sandbox, the recipient email must differ from the merchant account. (correlation-id: debug-paypal-recipient-err-999)",
          httpStatus: 422,
          details: [
            {
              field: "/primary_recipients/0/billing_info/email_address",
              issue: "CANNOT_PAY_OWN_INVOICE",
            },
          ],
        },
      });

      // 4. Call paypal-draft route
      const paypalDraftRes = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: userSession.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const paypalDraftJson = await paypalDraftRes.json();
      expect(paypalDraftRes.status).toBe(502);
      expect(paypalDraftJson.error).toContain("Cannot bill your own PayPal account");
      expect(paypalDraftJson.error).toContain("debug-paypal-recipient-err-999");

      // 5. Verify external operation record was logged as FAILED with correlationId
      const op = await db.externalOperation.findFirst({
        where: { invoiceId, operationType: OperationType.CREATE_DRAFT },
      });
      expect(op).not.toBeNull();
      expect(op?.attemptState).toBe(OperationAttemptState.FAILED);
      expect(op?.correlationId).toBe("debug-paypal-recipient-err-999");

      // 6. Verify invoice status was NOT modified to SENT or PAID
      const invoiceAfter = await db.invoice.findUnique({ where: { id: invoiceId } });
      expect(invoiceAfter?.cashpilotStatus).toBe(CashPilotStatus.DRAFT);
      expect(invoiceAfter?.paypalStatus).toBeNull();
    });

    it("verifies User Workspace cannot access Demo Workspace data (Strict Isolation)", async () => {
      // Create draft in Demo Workspace
      const demoDraftRes = await draftRoute(
        new NextRequest("http://localhost:3000/api/invoices/draft", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: demoSession.cookieHeader,
          },
          body: JSON.stringify({
            clientId: demoClientId,
            currency: "USD",
            taxRateBasisPoints: 0,
            invoiceDate: "2026-11-06",
            dueDate: "2026-11-25",
            lineItems: [{ description: "Demo Consulting", quantity: 2, unitPriceMinorUnits: 5000 }],
          }),
        })
      );
      const demoDraftJson = await demoDraftRes.json();
      expect(demoDraftRes.status).toBe(201);
      const demoInvoiceId = demoDraftJson.data.id;
      createdInvoiceIds.push(demoInvoiceId);

      // User session attempts to access Demo invoice
      const crossRes = await paypalDraftRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${demoInvoiceId}/paypal-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: userSession.cookieHeader,
          },
        }),
        { params: Promise.resolve({ id: demoInvoiceId }) }
      );
      expect(crossRes.status).toBe(403);
    });
  });
});
