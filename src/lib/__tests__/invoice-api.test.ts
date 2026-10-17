/**
 * CashPilot AI — Invoice Draft and Review API Integration Tests
 *
 * Task 4: Tests for POST /api/invoices/draft and GET /api/invoices/[id]
 *
 * Coverage:
 * - Valid draft creation, deterministic server totals, and persistence
 * - Missing and invalid required fields
 * - Client-supplied total rejection / financial integrity enforcement
 * - Float and negative money input rejection
 * - Missing invoice retrieval and invalid ID handling
 * - Clean safe fields (no secrets or credentials exposed)
 * - Material payload hash calculation
 * - Verification that external writes (PayPal/AI) are NOT called
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { GET as getInvoiceRoute } from "@/app/api/invoices/[id]/route";
import { db } from "@/lib/db/client";
import * as paypalAdapter from "@/lib/paypal/adapter";

describe("Invoice Draft and Review APIs", () => {
  const workspaceId = "demo-workspace-1";
  const clientId = "demo-client-1";
  const createdInvoiceIds: string[] = [];

  // Spy on PayPal adapter to verify zero external calls
  const createPayPalDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const sendPayPalSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");

  beforeAll(async () => {
    // Ensure demo workspace and client exist in local PostgreSQL
    await db.workspace.upsert({
      where: { id: workspaceId },
      update: {},
      create: {
        id: workspaceId,
        name: "Test Workspace",
        ownerId: "demo-user-1",
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientId },
      update: {},
      create: {
        id: clientId,
        workspaceId,
        name: "Acme Corporation",
        email: "accounts@acme-sandbox.example.com",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    // Clean up invoices created during tests
    if (createdInvoiceIds.length > 0) {
      await db.activityEvent.deleteMany({
        where: { invoiceId: { in: createdInvoiceIds } },
      });
      await db.invoiceLineItem.deleteMany({
        where: { invoiceId: { in: createdInvoiceIds } },
      });
      await db.invoice.deleteMany({
        where: { id: { in: createdInvoiceIds } },
      });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Valid Draft Creation
  // ───────────────────────────────────────────────────────────────────────────
  it("creates a draft invoice with deterministic server-side totals and material hash", async () => {
    const payload = {
      workspaceId,
      clientId,
      title: "Fullstack Architecture Consulting",
      currency: "USD",
      taxRateBasisPoints: 1000, // 10.00%
      invoiceDate: "2026-10-18",
      dueDate: "2026-11-01",
      notes: "Net 14 payment terms",
      terms: "Standard freelance consulting terms",
      lineItems: [
        {
          description: "System Design & Review",
          quantity: 10,
          unitPriceMinorUnits: 15000, // $150.00 -> $1,500.00
        },
        {
          description: "Technical Documentation",
          quantity: 5,
          unitPriceMinorUnits: 10000, // $100.00 -> $500.00
        },
      ],
    };

    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBeDefined();

    createdInvoiceIds.push(json.data.id);

    // Verify server-side arithmetic (never floating point)
    // Subtotal: 10*15000 + 5*10000 = 150000 + 50000 = 200000 ($2,000.00)
    // Tax: round(200000 * 1000 / 10000) = 20000 ($200.00)
    // Total: 220000 ($2,200.00)
    expect(json.data.subtotalMinorUnits).toBe(200000);
    expect(json.data.taxMinorUnits).toBe(20000);
    expect(json.data.totalMinorUnits).toBe(220000);
    expect(json.data.currency).toBe("USD");
    expect(json.data.cashpilotStatus).toBe("DRAFT");
    expect(json.data.isDemoData).toBe(true);
    expect(json.data.materialPayloadHash).toMatch(/^[a-f0-9]{64}$/);

    // Verify line items
    expect(json.data.lineItems).toHaveLength(2);
    expect(json.data.lineItems[0].totalMinorUnits).toBe(150000);
    expect(json.data.lineItems[1].totalMinorUnits).toBe(50000);

    // Verify database record directly
    const persisted = await db.invoice.findUnique({
      where: { id: json.data.id },
      include: { lineItems: true },
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.totalMinorUnits).toBe(220000);
    expect(persisted?.lineItems).toHaveLength(2);

    // Zero PayPal calls executed
    expect(createPayPalDraftSpy).not.toHaveBeenCalled();
    expect(sendPayPalSpy).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Financial Integrity & Client-Supplied Total Rejection
  // ───────────────────────────────────────────────────────────────────────────
  it("rejects forged or mismatching client-supplied totalMinorUnits", async () => {
    const payload = {
      workspaceId,
      clientId,
      title: "Tampered Invoice",
      currency: "USD",
      taxRateBasisPoints: 0,
      dueDate: "2026-11-01",
      totalMinorUnits: 9999, // FORGED total: $99.99 instead of $150.00
      lineItems: [
        {
          description: "Consulting",
          quantity: 1,
          unitPriceMinorUnits: 15000,
        },
      ],
    };

    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe("TOTAL_MISMATCH");
    expect(json.error).toContain("Client-supplied total (9999) does not match");
  });

  it("rejects forged or mismatching client-supplied subtotalMinorUnits", async () => {
    const payload = {
      workspaceId,
      clientId,
      title: "Tampered Subtotal",
      currency: "USD",
      taxRateBasisPoints: 0,
      dueDate: "2026-11-01",
      subtotalMinorUnits: 5555, // FORGED subtotal
      lineItems: [
        {
          description: "Consulting",
          quantity: 1,
          unitPriceMinorUnits: 15000,
        },
      ],
    };

    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe("SUBTOTAL_MISMATCH");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Validation Rules (Missing fields, floats, negative values)
  // ───────────────────────────────────────────────────────────────────────────
  it("rejects missing required fields", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Missing clientId, currency, dueDate, lineItems
        title: "Incomplete Invoice",
      }),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe("VALIDATION_ERROR");
  });

  it("rejects empty line items array", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        clientId,
        currency: "USD",
        taxRateBasisPoints: 0,
        dueDate: "2026-11-01",
        lineItems: [], // EMPTY
      }),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("At least one line item is required");
  });

  it("rejects floating-point monetary input", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        clientId,
        currency: "USD",
        taxRateBasisPoints: 0,
        dueDate: "2026-11-01",
        lineItems: [
          {
            description: "Invalid Float Item",
            quantity: 1,
            unitPriceMinorUnits: 15.5, // Float not allowed
          },
        ],
      }),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("must be in integer minor units (cents)");
  });

  it("rejects negative unit price", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        clientId,
        currency: "USD",
        taxRateBasisPoints: 0,
        dueDate: "2026-11-01",
        lineItems: [
          {
            description: "Negative Price",
            quantity: 1,
            unitPriceMinorUnits: -500,
          },
        ],
      }),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("cannot be negative");
  });

  it("rejects unsupported currencies", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        clientId,
        currency: "EUR", // Unsupported
        taxRateBasisPoints: 0,
        dueDate: "2026-11-01",
        lineItems: [
          {
            description: "EUR item",
            quantity: 1,
            unitPriceMinorUnits: 1000,
          },
        ],
      }),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Currency must be one of: USD");
  });

  it("rejects due date earlier than invoice date", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        clientId,
        currency: "USD",
        taxRateBasisPoints: 0,
        invoiceDate: "2026-10-20",
        dueDate: "2026-10-10", // 10 days BEFORE invoice date
        lineItems: [
          {
            description: "Past Due Item",
            quantity: 1,
            unitPriceMinorUnits: 1000,
          },
        ],
      }),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Due date must be on or after the invoice date");
  });

  it("rejects client not in workspace", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        clientId: "nonexistent-client-id",
        currency: "USD",
        taxRateBasisPoints: 0,
        dueDate: "2026-11-01",
        lineItems: [
          {
            description: "Valid item",
            quantity: 1,
            unitPriceMinorUnits: 1000,
          },
        ],
      }),
    });

    const res = await draftRoute(req);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Client not found in this workspace");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. GET /api/invoices/[id] Retrieval
  // ───────────────────────────────────────────────────────────────────────────
  it("retrieves an existing invoice with safe public fields and material hash", async () => {
    // Seeded invoice demo-invoice-1
    const req = new NextRequest("http://localhost:3000/api/invoices/demo-invoice-1?workspaceId=demo-workspace-1");
    const res = await getInvoiceRoute(req, {
      params: Promise.resolve({ id: "demo-invoice-1" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("demo-invoice-1");
    expect(json.data.currency).toBe("USD");
    expect(json.data.subtotalMinorUnits).toBeGreaterThan(0);
    expect(json.data.totalMinorUnits).toBe(json.data.subtotalMinorUnits + json.data.taxMinorUnits);
    expect(json.data.client.email).toBeDefined();
    expect(json.data.lineItems.length).toBeGreaterThan(0);
    expect(json.data.materialPayloadHash).toMatch(/^[a-f0-9]{64}$/);

    // Verify secrets are NOT exposed
    expect(json.data.PAYPAL_CLIENT_SECRET).toBeUndefined();
    expect(json.data.client.password).toBeUndefined();
    expect(json.data.token).toBeUndefined();
  });

  it("returns 404 for nonexistent invoice ID", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/nonexistent-id?workspaceId=demo-workspace-1");
    const res = await getInvoiceRoute(req, {
      params: Promise.resolve({ id: "nonexistent-id" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Invoice not found");
  });

  it("returns 400 for empty or whitespace invoice ID", async () => {
    const req = new NextRequest("http://localhost:3000/api/invoices/   ?workspaceId=demo-workspace-1");
    const res = await getInvoiceRoute(req, {
      params: Promise.resolve({ id: "   " }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Invoice ID is required");
  });
});
