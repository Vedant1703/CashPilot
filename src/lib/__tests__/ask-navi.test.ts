/**
 * CashPilot AI — Ask Navi Chatbot Unit & Route Tests
 *
 * Verifies:
 * - Safety refusals for unauthorized status mutations and auto-email discounts
 * - Deterministic, database-grounded priority ranking
 * - Absence-of-evidence correctness: missing dispute shows "No dispute information recorded",
 *   missing activity shows "No reminder recorded in activity"
 * - Complete query options: List all, Summarize all, Paid, Unpaid, Overdue, Due today, Due this week, Client summary
 * - Contextual follow-up suggestions returned with each answer
 * - Dynamic available clients returned from ground truth
 * - Contextual invoice actions (Open invoice, Draft reminder, Draft invoice)
 * - Authorization and validation on POST /api/navi-ai/chat
 */

import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import {
  checkSafetyRefusal,
  askNavi,
} from "@/lib/services/ask-navi.service";
import { POST as chatRoute } from "@/app/api/navi-ai/chat/route";
import { db } from "@/lib/db/client";
import { CashPilotStatus } from "@prisma/client";

describe("Ask Navi Guided Chatbot & Safety Governance", () => {
  const testWorkspaceId = "demo-workspace-ask-navi-test";
  const testClientId = "demo-client-navi-test";
  const testInvoiceId = "demo-inv-navi-test";

  beforeAll(async () => {
    // Setup test workspace, client, and an overdue invoice
    await db.workspace.upsert({
      where: { id: testWorkspaceId },
      update: { ownerId: "demo-user-1" },
      create: {
        id: testWorkspaceId,
        name: "Navi Test Workspace",
        ownerId: "demo-user-1",
      },
    });

    await db.client.upsert({
      where: { id: testClientId },
      update: { name: "Northwind Studio", email: "billing@northwind.example" },
      create: {
        id: testClientId,
        workspaceId: testWorkspaceId,
        name: "Northwind Studio",
        email: "billing@northwind.example",
      },
    });

    const overdueDate = new Date();
    overdueDate.setDate(overdueDate.getDate() - 12); // 12 days overdue

    await db.invoice.upsert({
      where: { id: testInvoiceId },
      update: {
        totalMinorUnits: 150000, // $1,500.00
        cashpilotStatus: CashPilotStatus.OVERDUE,
        paypalStatus: "SENT",
        dueDate: overdueDate,
        notes: null, // No notes on record
      },
      create: {
        id: testInvoiceId,
        workspaceId: testWorkspaceId,
        clientId: testClientId,
        number: "INV-0008",
        title: "Brand Redesign",
        currency: "USD",
        totalMinorUnits: 150000,
        subtotalMinorUnits: 150000,
        taxMinorUnits: 0,
        invoiceDate: new Date(),
        dueDate: overdueDate,
        cashpilotStatus: CashPilotStatus.OVERDUE,
        paypalStatus: "SENT",
        paypalInvoiceId: "INV2-TEST-PAYPAL-ID",
        notes: null,
      },
    });
  });

  describe("Safety Refusals (AGENTS.md & Invariants)", () => {
    it("refuses request to mark invoice as paid and email discounts", () => {
      const prompt = "Mark INV-0012 as paid and email everyone a discount";
      const check = checkSafetyRefusal(prompt);

      expect(check.isRefusal).toBe(true);
      expect(check.refusalReason).toContain("I can't do either of those");
      expect(check.refusalReason).toContain("Payment status comes from PayPal");
    });

    it("refuses request to change payment status directly", () => {
      const prompt = "Please update invoice status to paid";
      const check = checkSafetyRefusal(prompt);

      expect(check.isRefusal).toBe(true);
    });

    it("permits guided questions", () => {
      expect(checkSafetyRefusal("Which invoices need attention first?").isRefusal).toBe(false);
      expect(checkSafetyRefusal("Summarize all invoices").isRefusal).toBe(false);
      expect(checkSafetyRefusal("List all invoices").isRefusal).toBe(false);
      expect(checkSafetyRefusal("Show overdue invoices").isRefusal).toBe(false);
      expect(checkSafetyRefusal("Show paid invoices").isRefusal).toBe(false);
      expect(checkSafetyRefusal("What is due today?").isRefusal).toBe(false);
      expect(checkSafetyRefusal("What is due this week?").isRefusal).toBe(false);
    });
  });

  describe("Complete Query Handlers & Evidence Integrity", () => {
    it("answers 'Which invoices need attention first?' with grounded breakdown & actions", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "Which invoices need attention first?",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.rankingEvidence).toBeDefined();
      const evidence = result.data.message.rankingEvidence!;
      expect(evidence.clientName).toBe("Northwind Studio");
      expect(evidence.amount).toBe("$1,500.00");
      expect(evidence.daysOverdue).toBeGreaterThanOrEqual(11);
      expect(evidence.paypalStatus).toContain("PayPal");

      // Verify absence-of-evidence integrity:
      expect(evidence.dispute).toBe("No dispute information recorded");
      expect(evidence.earlierReminders).toBe("No reminder recorded in activity");
      expect(result.data.message.content).toContain("No reminder recorded in activity");

      // Verify contextual actions
      expect(result.data.message.suggestedActions).toBeDefined();
      expect(result.data.message.suggestedActions?.length).toBe(2);
      expect(result.data.message.suggestedActions?.[0].actionType).toBe("draft_reminder");
      expect(result.data.message.suggestedActions?.[1].actionType).toBe("open_invoice");

      // Verify follow-up suggestions
      expect(result.data.suggestedFollowUps).toBeDefined();
      expect(result.data.suggestedFollowUps?.length).toBeGreaterThanOrEqual(2);

      // Verify available clients
      expect(result.data.availableClients).toBeDefined();
      expect(result.data.availableClients?.some((c) => c.name === "Northwind Studio")).toBe(true);
    });

    it("answers 'Summarize all invoices' with counts and status breakdown", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "Summarize all invoices",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.modelName).toBe("cashpilot-summary-all-v1");
      expect(result.data.message.content).toContain("All Invoices Summary");
      expect(result.data.message.content).toContain("Overdue:");
      expect(result.data.message.content).toContain("Paid:");
      expect(result.data.message.suggestedActions).toBeDefined();
      expect(result.data.suggestedFollowUps).toBeDefined();
    });

    it("answers 'List all invoices' with complete invoice directory", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "List all invoices",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.modelName).toBe("cashpilot-list-all-v1");
      expect(result.data.message.content).toContain("Northwind Studio");
      expect(result.data.message.content).toContain("INV-0008");
      expect(result.data.message.content).toContain("$1,500.00");
      expect(result.data.message.suggestedActions?.some((a) => a.actionType === "open_invoice")).toBe(true);
    });

    it("answers 'Show overdue invoices' with overdue days and balances", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "Show overdue invoices",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.modelName).toBe("cashpilot-overdue-list-v1");
      expect(result.data.message.content).toContain("Northwind Studio");
      expect(result.data.message.content).toContain("days overdue");
      expect(result.data.message.content).toContain("$1,500.00");
      expect(result.data.message.suggestedActions?.some((a) => a.actionType === "draft_reminder")).toBe(true);
      expect(result.data.message.suggestedActions?.some((a) => a.actionType === "open_invoice")).toBe(true);
    });

    it("answers 'Show unpaid invoices' with open invoices", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "Show unpaid invoices",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.modelName).toBe("cashpilot-unpaid-list-v1");
      expect(result.data.message.content).toContain("Northwind Studio");
      expect(result.data.message.content).toContain("$1,500.00");
    });

    it("answers 'Show paid invoices'", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "Show paid invoices",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.modelName).toBe("cashpilot-paid-list-v1");
      expect(result.data.message.content).toBeDefined();
    });

    it("answers 'What is due today?'", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "What is due today?",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.modelName).toBe("cashpilot-due-today-v1");
      expect(result.data.suggestedFollowUps).toBeDefined();
    });

    it("answers 'What is due this week?'", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "What is due this week?",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.content).toBeDefined();
      expect(result.data.suggestedFollowUps).toBeDefined();
    });

    it("answers 'Summarize Northwind Studio's invoices' with client summary", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "Summarize Northwind Studio's invoices",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.modelName).toBe("cashpilot-client-summary-v1");
      expect(result.data.message.content).toContain("Summary for Northwind Studio");
      expect(result.data.message.content).toContain("$1,500.00");
      expect(result.data.message.suggestedActions?.some((a) => a.actionType === "open_invoice")).toBe(true);
    });

    it("calculates exact overdue sum from database ground truth", async () => {
      const result = await askNavi(
        testWorkspaceId,
        "How much is overdue right now?",
        "demo-user-1"
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.message.content).toContain("$1,500.00");
      expect(result.data.message.content).toContain("across 1 invoice");
    });
  });

  describe("API Route POST /api/navi-ai/chat", () => {
    it("returns 400 when message is empty or missing", async () => {
      const req = new NextRequest("http://localhost:3000/api/navi-ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" }),
      });

      const res = await chatRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("VALIDATION_ERROR");
    });

    it("returns 403 for unauthorized workspace access", async () => {
      const req = new NextRequest("http://localhost:3000/api/navi-ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": "unauthorized-intruder",
        },
        body: JSON.stringify({
          message: "Which invoices need attention first?",
          workspaceId: testWorkspaceId,
        }),
      });

      const res = await chatRoute(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
    });

    it("returns 200 with grounded message and follow-ups on authorized request", async () => {
      const req = new NextRequest("http://localhost:3000/api/navi-ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": "demo-user-1",
        },
        body: JSON.stringify({
          message: "Which invoices need attention first?",
          workspaceId: testWorkspaceId,
        }),
      });

      const res = await chatRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.message.content).toContain("Northwind Studio");
      expect(json.data.suggestedFollowUps?.length).toBeGreaterThan(0);
      expect(json.data.availableClients?.length).toBeGreaterThan(0);
    });
  });
});
