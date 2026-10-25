/**
 * CashPilot AI — AI Invoice Extraction Service Unit & Route Tests
 *
 * Tests:
 * - Natural language structured invoice extraction
 * - Extraction flags missing fields (never guesses email, dates, or prices)
 * - Deterministic fallback when AI credentials are unconfigured
 * - Zod schema verification and rejection of malformed data
 * - Rejection of invalid currencies, negative quantities, negative prices
 * - Client matching against existing workspace clients
 * - AiDraft audit trail persistence in database
 * - POST /api/invoices/extract route validation and error handling
 */

import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import {
  extractInvoiceDeterministically,
  extractInvoiceFromPrompt,
} from "@/lib/services/ai-extraction.service";
import { aiInvoiceDraftSchema } from "@/lib/validations/invoice";
import { POST as extractRoute } from "@/app/api/invoices/extract/route";
import { db } from "@/lib/db/client";

describe("AI Invoice Extraction & Governance", () => {
  const testWorkspaceId = "demo-workspace-extract-test";
  const testClientId = "demo-client-extract-test";

  beforeAll(async () => {
    await db.workspace.upsert({
      where: { id: testWorkspaceId },
      update: { ownerId: "demo-user-1" },
      create: {
        id: testWorkspaceId,
        name: "Extract Test Workspace",
        ownerId: "demo-user-1",
      },
    });

    await db.client.upsert({
      where: { id: testClientId },
      update: { name: "Acme Corp", email: "billing@acmecorp.com" },
      create: {
        id: testClientId,
        workspaceId: testWorkspaceId,
        name: "Acme Corp",
        email: "billing@acmecorp.com",
      },
    });
  });

  describe("Deterministic Pattern Extraction Engine", () => {
    it("extracts structured fields from a comprehensive invoice prompt", () => {
      const prompt =
        "Create an invoice for Acme Corp for 10 hours of system design consulting at $150 per hour, with a 10% tax rate, dated October 21, 2026, due November 4, 2026";

      const result = extractInvoiceDeterministically(prompt);

      expect(result.draft.clientName).toBe("Acme Corp");
      expect(result.draft.lineItems).toBeDefined();
      expect(result.draft.lineItems?.length).toBeGreaterThan(0);
      expect(result.draft.lineItems?.[0].quantity).toBe(10);
      expect(result.draft.lineItems?.[0].unitPriceDecimal).toBe("150.00");
      expect(result.draft.taxRatePercent).toBe(10);
      expect(result.draft.dueDate).toBe("2026-11-04");
    });

    it("flags missing fields when information is omitted, without fabricating data", () => {
      const prompt = "Bill Jane for consulting at $500";

      const result = extractInvoiceDeterministically(prompt);

      // Jane has no email specified in the prompt
      expect(result.draft.recipientEmail).toBeUndefined();
      expect(result.draft.dueDate).toBeUndefined();
      expect(result.missingFields).toContain("recipientEmail");
    });

    it("extracts Net terms into a due date if specified", () => {
      const prompt = "Invoice Wayne Enterprises $1,200 for security audit, net 30";
      const result = extractInvoiceDeterministically(prompt);

      expect(result.draft.clientName).toBe("Wayne Enterprises");
      expect(result.draft.terms).toContain("Net 30");
      expect(result.draft.dueDate).toBeDefined();
    });
  });

  describe("Zod Schema Validation & Boundary Rejection", () => {
    it("validates a well-formed extracted invoice draft", () => {
      const validDraft = {
        clientName: "Acme Corp",
        recipientEmail: "acme@example.com",
        title: "Engineering Services",
        currency: "USD",
        dueDate: "2026-11-15",
        lineItems: [
          {
            description: "Software Architecture",
            quantity: 5,
            unitPriceDecimal: "200.00",
          },
        ],
        taxRatePercent: 8.5,
        notes: "Thank you for your business.",
      };

      const parsed = aiInvoiceDraftSchema.safeParse(validDraft);
      expect(parsed.success).toBe(true);
    });

    it("rejects non-ISO currency codes", () => {
      const invalidDraft = {
        clientName: "Acme Corp",
        currency: "BITCOIN",
        lineItems: [{ description: "Service", quantity: 1, unitPriceDecimal: "100.00" }],
      };

      const parsed = aiInvoiceDraftSchema.safeParse(invalidDraft);
      expect(parsed.success).toBe(false);
    });

    it("rejects negative quantities", () => {
      const invalidDraft = {
        clientName: "Acme Corp",
        currency: "USD",
        lineItems: [{ description: "Service", quantity: -2, unitPriceDecimal: "100.00" }],
      };

      const parsed = aiInvoiceDraftSchema.safeParse(invalidDraft);
      expect(parsed.success).toBe(false);
    });

    it("rejects invalid prices", () => {
      const invalidDraft = {
        clientName: "Acme Corp",
        currency: "USD",
        lineItems: [{ description: "Service", quantity: 1, unitPriceDecimal: "free" }],
      };

      const parsed = aiInvoiceDraftSchema.safeParse(invalidDraft);
      expect(parsed.success).toBe(false);
    });
  });

  describe("End-to-End Extraction Service & DB Audit Persistence", () => {
    it("persists an AiDraft audit record and resolves known client", async () => {
      const prompt = "Bill Acme Corp for 8 hours of cloud consulting at $175 per hour, net 14";

      const result = await extractInvoiceFromPrompt(
        testWorkspaceId,
        prompt,
        "demo-user-1"
      );

      expect(result.source).toBe("deterministic_rule_based");
      expect(result.aiDraftId).toBeDefined();
      expect(result.extractedDraft.clientName).toBe("Acme Corp");
      expect(result.matchedClient).toBeDefined();
      expect(result.matchedClient?.email).toBe("billing@acmecorp.com");

      // Verify DB persistence
      const persistedRecord = await db.aiDraft.findUnique({
        where: { id: result.aiDraftId },
      });

      expect(persistedRecord).not.toBeNull();
      expect(persistedRecord?.workspaceId).toBe(testWorkspaceId);
      expect(persistedRecord?.reviewStatus).toBe("PENDING");
      expect(persistedRecord?.inputText).toBe(prompt);
    });

    it("identifies missing required fields explicitly", async () => {
      const prompt = "Quick charge of $300 for design review";

      const result = await extractInvoiceFromPrompt(
        testWorkspaceId,
        prompt,
        "demo-user-1"
      );

      expect(result.missingFields).toContain("recipientEmail");
      expect(result.missingFields).toContain("client");
      expect(result.clarificationMessage).toBeDefined();
    });
  });

  describe("API Route POST /api/invoices/extract", () => {
    it("returns 400 if prompt is too short", async () => {
      const req = new NextRequest("http://localhost:3000/api/invoices/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      });

      const res = await extractRoute(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for malformed JSON body", async () => {
      const req = new NextRequest("http://localhost:3000/api/invoices/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid-json",
      });

      const res = await extractRoute(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe("INVALID_JSON");
    });

    it("returns 200 with extracted proposal on valid prompt", async () => {
      const req = new NextRequest("http://localhost:3000/api/invoices/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": testWorkspaceId,
        },
        body: JSON.stringify({
          prompt: "Bill Acme Corp for 10 hours at $150 per hour",
        }),
      });

      const res = await extractRoute(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.extractedDraft).toBeDefined();
      expect(json.data.aiDraftId).toBeDefined();
    });
  });

  describe("Regression Suite: Flexible NLP Extraction & Safe Matching", () => {
    const clients = [
      { id: "c-1", name: "TechStart Inc", email: "billing@techstart.io", company: "TechStart Inc" },
      { id: "c-2", name: "Acme Corporation", email: "finance@acme.com", company: "Acme Corp" },
      { id: "c-3", name: "Global Media LLC", email: "ap@globalmedia.com", company: "Global Media" },
    ];

    it("parses comma-formatted amounts correctly without truncation ($1,250, $2,500.50)", () => {
      const prompt1 = "Bill TechStart $1,250 for frontend overhaul";
      const res1 = extractInvoiceDeterministically(prompt1, clients);
      expect(res1.draft.lineItems?.[0].unitPriceDecimal).toBe("1250.00");
      expect(res1.draft.lineItems?.[0].description).toBe("Frontend overhaul");

      const prompt2 = "Invoice Acme Corp $2,500.50 for Q3 security review";
      const res2 = extractInvoiceDeterministically(prompt2, clients);
      expect(res2.draft.lineItems?.[0].unitPriceDecimal).toBe("2500.50");
      expect(res2.draft.lineItems?.[0].description).toBe("Q3 security review");
    });

    it("matches client with company suffix variations (TechStart -> TechStart Inc)", () => {
      const prompt = "Bill TechStart $500 for api design";
      const res = extractInvoiceDeterministically(prompt, clients);

      expect(res.matchedClient).toBeDefined();
      expect(res.matchedClient?.id).toBe("c-1");
      expect(res.matchedClient?.name).toBe("TechStart Inc");
      expect(res.draft.recipientEmail).toBe("billing@techstart.io");
    });

    it("does not select a client when multiple clients match ambiguously", () => {
      const ambiguousClients = [
        { id: "ts-1", name: "TechStart Inc", email: "billing@techstart.io" },
        { id: "ts-2", name: "TechStart Labs", email: "billing@techstartlabs.io" },
      ];

      const prompt = "Bill TechStart $1,250 for sprint 3 frontend development";
      const res = extractInvoiceDeterministically(prompt, ambiguousClients);

      // Must NOT guess or default to the first client
      expect(res.matchedClient).toBeNull();
      expect(res.isAmbiguousClient).toBe(true);
      expect(res.missingFields).toContain("client");
    });

    it("extracts acceptance scenario prompt accurately", () => {
      const prompt =
        "Bill TechStart $1,250 for sprint 3 frontend development, 10% tax, due Nov 4, 2026";
      const res = extractInvoiceDeterministically(prompt, clients);

      expect(res.matchedClient).toBeDefined();
      expect(res.matchedClient?.name).toBe("TechStart Inc");
      expect(res.matchedClient?.email).toBe("billing@techstart.io");
      expect(res.draft.lineItems?.[0].description).toBe("Sprint 3 frontend development");
      expect(res.draft.lineItems?.[0].quantity).toBe(1);
      expect(res.draft.lineItems?.[0].unitPriceDecimal).toBe("1250.00");
      expect(res.draft.taxRatePercent).toBe(10);
      expect(res.draft.dueDate).toBe("2026-11-04");
      expect(res.missingFields).not.toContain("client");
      expect(res.missingFields).not.toContain("dueDate");
    });

    it("extracts hourly rate and quantity with varied phrasing", () => {
      const prompt = "Invoice Global Media for 15 hours of cloud migration consulting at $175/hr";
      const res = extractInvoiceDeterministically(prompt, clients);

      expect(res.matchedClient?.id).toBe("c-3");
      expect(res.draft.lineItems?.[0].quantity).toBe(15);
      expect(res.draft.lineItems?.[0].unitPriceDecimal).toBe("175.00");
      expect(res.draft.lineItems?.[0].description).toBe("Cloud migration consulting");
    });

    it("flags missing fields without inventing defaults when prompt lacks info", () => {
      const prompt = "Please prepare an invoice for $400";
      const res = extractInvoiceDeterministically(prompt, clients);

      expect(res.matchedClient).toBeNull();
      expect(res.draft.recipientEmail).toBeUndefined();
      expect(res.draft.dueDate).toBeUndefined();
      expect(res.missingFields).toContain("client");
      expect(res.missingFields).toContain("recipientEmail");
      expect(res.missingFields).toContain("dueDate");
    });
  });
});
