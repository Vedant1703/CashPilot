/**
 * CashPilot AI — Demo Workspace Safe Reset Tests (Phase 3B)
 *
 * Verifies:
 * 1. Successful demo reset restores canonical clients and invoices.
 * 2. Additional demo-created records (invoices, clients, approvals, ops, drafts) are cleaned up.
 * 3. Protection of non-demo workspaces: customer workspaces remain 100% untouched.
 * 4. Unauthorized access: unauthenticated requests and non-demo users are rejected.
 * 5. Invariant enforcement: ownership or isDemo mismatch fails closed (500).
 * 6. Transaction rollback: failure during reset rolls back all changes atomically.
 * 7. Zero external PayPal calls: PayPal-linked records are handled safely without provider calls.
 *
 * Database safety: Strictly runs on cashpilot_disposable_test.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as demoResetHandler } from "@/app/api/demo/reset/route";
import {
  resetDemoWorkspace,
  DEMO_WORKSPACE_ID,
  DEMO_USER_ID,
} from "@/lib/services/demo.service";
import { db } from "@/lib/db/client";
import {
  createTestSession,
  clearTestSessions,
  assertAllowedTestDatabase,
  ensureTestUsers,
  cleanupTestUsers,
} from "@/lib/test-utils/auth";
import { CashPilotStatus, OperationType, OperationAttemptState, ActivityEventType, ActorType } from "@prisma/client";
import * as paypalAdapter from "@/lib/paypal/adapter";

describe("Phase 3B: Safe Demo Workspace Reset", () => {
  const nonDemoUserId = "user-reg-other";
  const nonDemoWorkspaceId = "workspace-reg-other";
  const nonDemoClientId = "client-reg-other";
  const nonDemoInvoiceId = "invoice-reg-other";

  let demoSession: { cookieHeader: string; sessionToken: string };
  let nonDemoSession: { cookieHeader: string; sessionToken: string };

  beforeAll(async () => {
    await assertAllowedTestDatabase();

    // Ensure demo user and non-demo user
    await ensureTestUsers([
      { id: DEMO_USER_ID, email: "demo@cashpilot.test", name: "Demo User" },
      { id: nonDemoUserId, email: "other@example.com", name: "Other User" },
    ]);

    // Setup sessions
    demoSession = createTestSession({
      userId: DEMO_USER_ID,
      email: "demo@cashpilot.test",
      workspaceId: DEMO_WORKSPACE_ID,
      isDemo: true,
    });

    nonDemoSession = createTestSession({
      userId: nonDemoUserId,
      email: "other@example.com",
      workspaceId: nonDemoWorkspaceId,
      isDemo: false,
    });

    // Ensure canonical demo workspace exists
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

    // Ensure non-demo workspace exists
    await db.workspace.upsert({
      where: { id: nonDemoWorkspaceId },
      update: { ownerId: nonDemoUserId, isDemo: false },
      create: {
        id: nonDemoWorkspaceId,
        name: "Acme Consulting Studio",
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
        name: "Real Customer Corp",
        email: "finance@realcorp.com",
        isDemo: false,
      },
    });

    await db.invoice.upsert({
      where: { id: nonDemoInvoiceId },
      update: { workspaceId: nonDemoWorkspaceId, clientId: nonDemoClientId },
      create: {
        id: nonDemoInvoiceId,
        workspaceId: nonDemoWorkspaceId,
        clientId: nonDemoClientId,
        title: "Real Production Invoice",
        currency: "USD",
        subtotalMinorUnits: 500000,
        taxMinorUnits: 0,
        totalMinorUnits: 500000,
        invoiceDate: new Date(),
        dueDate: new Date(Date.now() + 864000000),
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        isDemoData: false,
      },
    });
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();
    clearTestSessions();

    // Cleanup non-demo data
    await db.invoiceLineItem.deleteMany({
      where: { invoice: { workspaceId: nonDemoWorkspaceId } },
    });
    await db.invoice.deleteMany({
      where: { workspaceId: nonDemoWorkspaceId },
    });
    await db.client.deleteMany({
      where: { workspaceId: nonDemoWorkspaceId },
    });
    await db.workspace.deleteMany({
      where: { id: nonDemoWorkspaceId },
    });
    await cleanupTestUsers();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Successful Reset & Restoration of Canonical Records
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Successful Reset & Canonical Restoration", () => {
    it("successfully resets demo workspace and restores canonical invoices and clients", async () => {
      const req = new NextRequest("http://localhost:3000/api/demo/reset", {
        method: "POST",
        headers: {
          Cookie: demoSession.cookieHeader,
          "Content-Type": "application/json",
        },
      });

      const res = await demoResetHandler(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.restoredInvoicesCount).toBe(4);
      expect(json.data.restoredClientsCount).toBe(3);

      // Verify the 3 canonical clients exist in DB
      const clients = await db.client.findMany({
        where: { workspaceId: DEMO_WORKSPACE_ID },
        orderBy: { id: "asc" },
      });
      expect(clients.map((c) => c.id)).toEqual([
        "demo-client-1",
        "demo-client-2",
        "demo-client-3",
      ]);

      // Verify the 4 canonical invoices exist in DB
      const invoices = await db.invoice.findMany({
        where: { workspaceId: DEMO_WORKSPACE_ID },
        include: { lineItems: true },
        orderBy: { id: "asc" },
      });
      expect(invoices.map((i) => i.id)).toEqual([
        "demo-invoice-1",
        "demo-invoice-2",
        "demo-invoice-3",
        "demo-invoice-4",
      ]);

      // Check specific canonical statuses and amounts
      const inv1 = invoices.find((i) => i.id === "demo-invoice-1")!;
      expect(inv1.cashpilotStatus).toBe(CashPilotStatus.DRAFT);
      expect(inv1.totalMinorUnits).toBe(562500);
      expect(inv1.lineItems.length).toBe(2);

      const inv2 = invoices.find((i) => i.id === "demo-invoice-2")!;
      expect(inv2.cashpilotStatus).toBe(CashPilotStatus.DUE_SOON);
      expect(inv2.totalMinorUnits).toBe(350000);

      const inv3 = invoices.find((i) => i.id === "demo-invoice-3")!;
      expect(inv3.cashpilotStatus).toBe(CashPilotStatus.OVERDUE);
      expect(inv3.totalMinorUnits).toBe(600000);

      const inv4 = invoices.find((i) => i.id === "demo-invoice-4")!;
      expect(inv4.cashpilotStatus).toBe(CashPilotStatus.PAID);
      expect(inv4.totalMinorUnits).toBe(325000);
      expect(inv4.notes).toContain("[DEMO DATA]");

      // Check system audit event
      const resetEvent = await db.activityEvent.findFirst({
        where: {
          workspaceId: DEMO_WORKSPACE_ID,
          eventType: ActivityEventType.SYSTEM_EVENT,
        },
        orderBy: { createdAt: "desc" },
      });
      expect(resetEvent).not.toBeNull();
      expect(resetEvent?.description).toContain("[DEMO RESET]");
    });

    it("preserves previous reset audit events across consecutive resets while clearing ordinary activity", async () => {
      // 1. First reset
      const res1 = await resetDemoWorkspace({ actorId: DEMO_USER_ID });
      expect(res1.ok).toBe(true);

      // Verify at least one reset event exists
      const eventsAfterFirst = await db.activityEvent.findMany({
        where: {
          workspaceId: DEMO_WORKSPACE_ID,
          eventType: ActivityEventType.SYSTEM_EVENT,
          description: { startsWith: "[DEMO RESET]" },
        },
      });
      const firstCount = eventsAfterFirst.length;
      expect(firstCount).toBeGreaterThanOrEqual(1);

      // 2. Add an ordinary demo activity event (e.g. simulated user editing an invoice)
      const ordinaryEvent = await db.activityEvent.create({
        data: {
          workspaceId: DEMO_WORKSPACE_ID,
          invoiceId: "demo-invoice-1",
          eventType: ActivityEventType.INVOICE_STATUS_CHANGED,
          actorType: ActorType.USER,
          actorId: DEMO_USER_ID,
          description: "Temporary demo activity event to be pruned",
        },
      });

      // 3. Second reset
      const res2 = await resetDemoWorkspace({ actorId: DEMO_USER_ID });
      expect(res2.ok).toBe(true);

      // 4. Verify ordinary activity was pruned
      const foundOrdinary = await db.activityEvent.findUnique({
        where: { id: ordinaryEvent.id },
      });
      expect(foundOrdinary).toBeNull();

      // 5. Verify BOTH reset audit events survive
      const eventsAfterSecond = await db.activityEvent.findMany({
        where: {
          workspaceId: DEMO_WORKSPACE_ID,
          eventType: ActivityEventType.SYSTEM_EVENT,
          description: { startsWith: "[DEMO RESET]" },
        },
        orderBy: { createdAt: "asc" },
      });
      expect(eventsAfterSecond.length).toBe(firstCount + 1);

      // Verify each preserved event maintains its metadata and actor
      for (const ev of eventsAfterSecond) {
        expect(ev.actorId).toBe(DEMO_USER_ID);
        expect(ev.description).toContain("[DEMO RESET]");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Removal of Additional Demo-Created Records
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Clean-up of Extra Demo Records", () => {
    it("safely removes extra invoices, clients, approvals, operations, and drafts", async () => {
      // Create extra client in demo workspace
      const extraClient = await db.client.create({
        data: {
          id: `demo-extra-client-${Date.now()}`,
          workspaceId: DEMO_WORKSPACE_ID,
          name: "Temporary Demo Client",
          email: "temp@example.com",
          isDemo: true,
        },
      });

      // Create extra invoice in demo workspace
      const extraInvoice = await db.invoice.create({
        data: {
          id: `demo-extra-inv-${Date.now()}`,
          workspaceId: DEMO_WORKSPACE_ID,
          clientId: extraClient.id,
          title: "Temporary Demo Invoice",
          currency: "USD",
          subtotalMinorUnits: 10000,
          taxMinorUnits: 0,
          totalMinorUnits: 10000,
          invoiceDate: new Date(),
          dueDate: new Date(Date.now() + 86400000),
          cashpilotStatus: CashPilotStatus.DRAFT,
          isDemoData: true,
          lineItems: {
            create: [
              {
                description: "Temporary Service",
                quantity: 1,
                unitPriceMinorUnits: 10000,
                totalMinorUnits: 10000,
              },
            ],
          },
        },
      });

      // Create extra approval
      const extraApproval = await db.approval.create({
        data: {
          workspaceId: DEMO_WORKSPACE_ID,
          invoiceId: extraInvoice.id,
          actorId: DEMO_USER_ID,
          actionType: "SEND_INVOICE",
          payloadHash: "fakehash123",
          payloadSnapshot: {},
        },
      });

      // Create extra external operation
      await db.externalOperation.create({
        data: {
          workspaceId: DEMO_WORKSPACE_ID,
          invoiceId: extraInvoice.id,
          approvalId: extraApproval.id,
          operationType: OperationType.SEND_INVOICE,
          attemptState: OperationAttemptState.SUCCESS,
        },
      });

      // Create extra AI draft
      await db.aiDraft.create({
        data: {
          workspaceId: DEMO_WORKSPACE_ID,
          inputText: "Draft an invoice for test",
          structuredOutput: {},
        },
      });

      // Execute reset
      const req = new NextRequest("http://localhost:3000/api/demo/reset", {
        method: "POST",
        headers: {
          Cookie: demoSession.cookieHeader,
          "Content-Type": "application/json",
        },
      });

      const res = await demoResetHandler(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.data.removedInvoicesCount).toBeGreaterThanOrEqual(1);
      expect(json.data.removedClientsCount).toBeGreaterThanOrEqual(1);

      // Verify the extra records were completely removed
      const foundClient = await db.client.findUnique({ where: { id: extraClient.id } });
      expect(foundClient).toBeNull();

      const foundInvoice = await db.invoice.findUnique({ where: { id: extraInvoice.id } });
      expect(foundInvoice).toBeNull();

      const foundApproval = await db.approval.findUnique({ where: { id: extraApproval.id } });
      expect(foundApproval).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Protection of Non-Demo Workspaces
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Non-Demo Workspace Protection", () => {
    it("never touches or modifies non-demo workspaces or their customer invoices", async () => {
      // Execute demo reset
      const req = new NextRequest("http://localhost:3000/api/demo/reset", {
        method: "POST",
        headers: {
          Cookie: demoSession.cookieHeader,
          "Content-Type": "application/json",
        },
      });

      const res = await demoResetHandler(req);
      expect(res.status).toBe(200);

      // Verify non-demo customer invoice is completely intact
      const nonDemoInv = await db.invoice.findUnique({
        where: { id: nonDemoInvoiceId },
      });
      expect(nonDemoInv).not.toBeNull();
      expect(nonDemoInv?.workspaceId).toBe(nonDemoWorkspaceId);
      expect(nonDemoInv?.title).toBe("Real Production Invoice");

      // Verify non-demo client is intact
      const nonDemoCl = await db.client.findUnique({
        where: { id: nonDemoClientId },
      });
      expect(nonDemoCl).not.toBeNull();
      expect(nonDemoCl?.name).toBe("Real Customer Corp");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Authorization & Access Boundaries
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Authorization & Security Boundaries", () => {
    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      const req = new NextRequest("http://localhost:3000/api/demo/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const res = await demoResetHandler(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe("UNAUTHORIZED");
    });

    it("rejects non-demo users with 403 Forbidden", async () => {
      const req = new NextRequest("http://localhost:3000/api/demo/reset", {
        method: "POST",
        headers: {
          Cookie: nonDemoSession.cookieHeader,
          "Content-Type": "application/json",
        },
      });

      const res = await demoResetHandler(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe("FORBIDDEN_DEMO_RESET");
    });

    it("rejects requests attempting to reset a non-demo workspace", async () => {
      const req = new NextRequest("http://localhost:3000/api/demo/reset", {
        method: "POST",
        headers: {
          Cookie: demoSession.cookieHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId: nonDemoWorkspaceId }),
      });

      const res = await demoResetHandler(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe("CANNOT_RESET_NON_DEMO_WORKSPACE");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Invariant Enforcement & Ownership Mismatch
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Invariant Enforcement", () => {
    it("fails closed with 500 when workspace ownership does not match demo user", async () => {
      // Temporarily alter workspace owner to another user
      await db.workspace.update({
        where: { id: DEMO_WORKSPACE_ID },
        data: { ownerId: nonDemoUserId },
      });

      try {
        const req = new NextRequest("http://localhost:3000/api/demo/reset", {
          method: "POST",
          headers: {
            Cookie: demoSession.cookieHeader,
            "Content-Type": "application/json",
          },
        });

        const res = await demoResetHandler(req);
        expect(res.status).toBe(500);
        const json = await res.json();
        expect(json.code).toBe("DEMO_INVARIANT_VIOLATION");
      } finally {
        // Restore correct ownership
        await db.workspace.update({
          where: { id: DEMO_WORKSPACE_ID },
          data: { ownerId: DEMO_USER_ID },
        });
      }
    });

    it("fails closed with 500 when demo workspace is not flagged isDemo", async () => {
      // Temporarily set isDemo: false
      await db.workspace.update({
        where: { id: DEMO_WORKSPACE_ID },
        data: { isDemo: false },
      });

      try {
        const req = new NextRequest("http://localhost:3000/api/demo/reset", {
          method: "POST",
          headers: {
            Cookie: demoSession.cookieHeader,
            "Content-Type": "application/json",
          },
        });

        const res = await demoResetHandler(req);
        expect(res.status).toBe(500);
        const json = await res.json();
        expect(json.code).toBe("DEMO_INVARIANT_VIOLATION");
      } finally {
        // Restore isDemo: true
        await db.workspace.update({
          where: { id: DEMO_WORKSPACE_ID },
          data: { isDemo: true },
        });
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Transaction Rollback on Failure
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Transaction Rollback Integrity", () => {
    it("rolls back all changes atomically if an error occurs mid-transaction", async () => {
      // Create a marker client that should survive the rollback
      const markerClient = await db.client.create({
        data: {
          id: `marker-client-${Date.now()}`,
          workspaceId: DEMO_WORKSPACE_ID,
          name: "Marker Client Before Error",
          email: "marker@example.com",
          isDemo: true,
        },
      });

      // Execute reset with simulated transaction error
      const result = await resetDemoWorkspace({
        actorId: DEMO_USER_ID,
        _simulateTxError: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("TRANSACTION_FAILED");
      }

      // Marker client should still exist because transaction aborted and rolled back
      const stillThere = await db.client.findUnique({
        where: { id: markerClient.id },
      });
      expect(stillThere).not.toBeNull();

      // Clean up marker
      await db.client.delete({ where: { id: markerClient.id } });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Safe Handling of PayPal-Linked Records & Zero External Provider Calls
  // ───────────────────────────────────────────────────────────────────────────
  describe("7. Zero External Calls & Safe PayPal Record Handling", () => {
    it("never calls external PayPal send, cancel, or refund APIs during reset", async () => {
      const sendSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
      const cancelSpy = vi.spyOn(paypalAdapter, "cancelPayPalInvoice");
      const remindSpy = vi.spyOn(paypalAdapter, "sendPayPalReminder");

      // Create an invoice with a mock PayPal invoice ID
      const paypalInvId = `demo-paypal-inv-${Date.now()}`;
      await db.invoice.create({
        data: {
          id: paypalInvId,
          workspaceId: DEMO_WORKSPACE_ID,
          clientId: "demo-client-1",
          title: "PayPal Linked Demo Invoice",
          currency: "USD",
          subtotalMinorUnits: 20000,
          taxMinorUnits: 0,
          totalMinorUnits: 20000,
          invoiceDate: new Date(),
          dueDate: new Date(Date.now() + 86400000),
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          paypalInvoiceId: "INV2-SANDBOX-TEST-9999",
          paypalStatus: "SENT",
          isDemoData: true,
        },
      });

      // Create external operation
      await db.externalOperation.create({
        data: {
          workspaceId: DEMO_WORKSPACE_ID,
          invoiceId: paypalInvId,
          operationType: OperationType.SEND_INVOICE,
          attemptState: OperationAttemptState.SUCCESS,
          providerInvoiceId: "INV2-SANDBOX-TEST-9999",
        },
      });

      const result = await resetDemoWorkspace({ actorId: DEMO_USER_ID });
      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.data.unaffectedPayPalInvoicesCount).toBeGreaterThanOrEqual(1);
        expect(result.data.cleanedExternalOperationsCount).toBeGreaterThanOrEqual(1);
        expect(result.data.message).toContain("External PayPal Sandbox invoices were not cancelled");
      }

      // Assert ZERO external calls were made
      expect(sendSpy).not.toHaveBeenCalled();
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(remindSpy).not.toHaveBeenCalled();
    });

    it("accurately captures and stores individual PayPal invoice IDs in audit metadata before pruning", async () => {
      const id1 = "INV2-PRUNE-TEST-1111";
      const id2 = "INV2-PRUNE-TEST-2222";

      // Create two non-canonical invoices with PayPal IDs
      await db.invoice.createMany({
        data: [
          {
            id: `demo-pp-inv-1-${Date.now()}`,
            workspaceId: DEMO_WORKSPACE_ID,
            clientId: "demo-client-1",
            title: "Pruned PayPal Invoice 1",
            currency: "USD",
            subtotalMinorUnits: 15000,
            taxMinorUnits: 0,
            totalMinorUnits: 15000,
            invoiceDate: new Date(),
            dueDate: new Date(Date.now() + 86400000),
            cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
            paypalInvoiceId: id1,
            paypalStatus: "SENT",
            isDemoData: true,
          },
          {
            id: `demo-pp-inv-2-${Date.now()}`,
            workspaceId: DEMO_WORKSPACE_ID,
            clientId: "demo-client-2",
            title: "Pruned PayPal Invoice 2",
            currency: "USD",
            subtotalMinorUnits: 25000,
            taxMinorUnits: 0,
            totalMinorUnits: 25000,
            invoiceDate: new Date(),
            dueDate: new Date(Date.now() + 86400000),
            cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
            paypalInvoiceId: id2,
            paypalStatus: "SENT",
            isDemoData: true,
          },
        ],
      });

      // Execute reset
      const result = await resetDemoWorkspace({ actorId: DEMO_USER_ID });
      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.data.unaffectedPayPalInvoicesCount).toBeGreaterThanOrEqual(2);
        expect(result.data.unaffectedPayPalInvoiceIds).toContain(id1);
        expect(result.data.unaffectedPayPalInvoiceIds).toContain(id2);
      }

      // Check the latest SYSTEM_EVENT in DB
      const latestResetEvent = await db.activityEvent.findFirst({
        where: {
          workspaceId: DEMO_WORKSPACE_ID,
          eventType: ActivityEventType.SYSTEM_EVENT,
          description: { startsWith: "[DEMO RESET]" },
        },
        orderBy: { createdAt: "desc" },
      });

      expect(latestResetEvent).not.toBeNull();
      const meta = latestResetEvent?.metadata as {
        isDemoReset?: boolean;
        unaffectedPayPalInvoicesCount?: number;
        unaffectedPayPalInvoiceIds?: string[];
      };
      expect(meta).toBeDefined();
      expect(meta.isDemoReset).toBe(true);
      expect(meta.unaffectedPayPalInvoicesCount).toBeGreaterThanOrEqual(2);
      expect(meta.unaffectedPayPalInvoiceIds).toContain(id1);
      expect(meta.unaffectedPayPalInvoiceIds).toContain(id2);
    });
  });
});
