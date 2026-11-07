/**
 * CashPilot AI — Client Demo Provenance Regression Tests (Phase 3F)
 *
 * Verifies that:
 * 1. Quick-added client in Demo Workspace gets isDemo: true.
 * 2. Invoice created for that client gets isDemoData: true.
 * 3. Quick-added client in User Workspace gets isDemo: false.
 * 4. User Workspace invoice cannot become simulation-eligible (fails closed with 403).
 * 5. Cross-workspace client creation remains forbidden and strictly bounded.
 *
 * Runs exclusively against cashpilot_disposable_test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { POST as createClientRoute } from "@/app/api/clients/route";
import { POST as draftInvoiceRoute } from "@/app/api/invoices/draft/route";
import { POST as simulatePaymentRoute } from "@/app/api/invoices/[id]/simulate-payment/route";
import { db } from "@/lib/db/client";
import { DEMO_WORKSPACE_ID, DEMO_USER_ID } from "@/lib/services/demo.service";
import {
  assertAllowedTestDatabase,
  ensureTestUsers,
  cleanupTestUsers,
  createTestSession,
} from "@/lib/test-utils/auth";
import { simulateDemoPayment } from "@/lib/services/demo.service";

describe("Phase 3F: Quick-Add Client Demo Provenance", () => {
  const userWorkspaceOwnerId = "test-prov-user-owner";
  const userWorkspaceId = "test-prov-user-ws";

  let demoSessionCookie = "";
  let userSessionCookie = "";

  const createdClientIds: string[] = [];
  const createdInvoiceIds: string[] = [];

  function makeRequest(
    url: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
    }
  ): NextRequest {
    const headers = new Headers();
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (options.cookie) {
      headers.set("Cookie", options.cookie);
    }
    return new NextRequest(new URL(url, "http://localhost:3000"), {
      method: options.method ?? "GET",
      headers,
      body:
        options.body !== undefined
          ? typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body)
          : undefined,
    });
  }

  beforeAll(async () => {
    // 1. Safety guard: abort immediately if not cashpilot_disposable_test
    await assertAllowedTestDatabase();

    // 2. Ensure test fixture owner exists in User table
    await ensureTestUsers([
      {
        id: userWorkspaceOwnerId,
        email: "prov-owner@test.internal",
        name: "Provenance Test Owner",
      },
    ]);

    // 3. Ensure User Workspace exists (isDemo: false)
    await db.workspace.upsert({
      where: { id: userWorkspaceId },
      update: {},
      create: {
        id: userWorkspaceId,
        name: "User Normal Studio",
        ownerId: userWorkspaceOwnerId,
        isDemo: false,
      },
    });

    // 4. Ensure Demo Workspace exists in test database (isDemo: true)
    await db.workspace.upsert({
      where: { id: DEMO_WORKSPACE_ID },
      update: {},
      create: {
        id: DEMO_WORKSPACE_ID,
        name: "My Freelance Studio",
        ownerId: DEMO_USER_ID,
        isDemo: true,
      },
    });

    // 5. Create test sessions
    const demoSession = createTestSession({
      userId: DEMO_USER_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      isDemo: true,
    });
    demoSessionCookie = demoSession.cookieHeader;

    const userSession = createTestSession({
      userId: userWorkspaceOwnerId,
      workspaceId: userWorkspaceId,
      isDemo: false,
    });
    userSessionCookie = userSession.cookieHeader;
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();

    // Clean up created test invoices
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

    // Clean up created test clients
    if (createdClientIds.length > 0) {
      await db.client.deleteMany({
        where: { id: { in: createdClientIds } },
      });
    }

    // Clean up user workspace
    await db.workspace.deleteMany({
      where: { id: userWorkspaceId },
    });

    await cleanupTestUsers([userWorkspaceOwnerId]);
  });

  it("1. Quick-added client in Demo Workspace gets isDemo: true", async () => {
    const req = makeRequest("/api/clients", {
      method: "POST",
      cookie: demoSessionCookie,
      body: {
        name: "Demo Quick Client Inc",
        email: "billing@demoquick.example.com",
        company: "Demo Quick Client",
        // Client-supplied values that MUST NOT be trusted
        isDemo: false,
        workspaceId: "hacked-workspace-id",
      },
    });

    const res = await createClientRoute(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);

    const client = json.data;
    createdClientIds.push(client.id);

    // Verified: assigned to Demo Workspace and has isDemo: true
    expect(client.workspaceId).toBe(DEMO_WORKSPACE_ID);
    expect(client.isDemo).toBe(true);
    expect(client.name).toBe("Demo Quick Client Inc");
  });

  it("2. Invoice created for Demo Workspace quick-added client inherits isDemoData: true", async () => {
    // First create a quick-added client in Demo Workspace
    const clientReq = makeRequest("/api/clients", {
      method: "POST",
      cookie: demoSessionCookie,
      body: {
        name: "Demo Project Sponsor",
        email: "sponsor@demosponsor.example.com",
      },
    });
    const clientRes = await createClientRoute(clientReq);
    expect(clientRes.status).toBe(201);
    const clientJson = await clientRes.json();
    const clientId = clientJson.data.id;
    createdClientIds.push(clientId);
    expect(clientJson.data.isDemo).toBe(true);

    // Create an invoice draft referencing this new client
    const invoiceReq = makeRequest("/api/invoices/draft", {
      method: "POST",
      cookie: demoSessionCookie,
      body: {
        clientId,
        title: "Demo Workspace Consultation",
        invoiceDate: "2026-11-02",
        dueDate: "2026-11-16",
        currency: "USD",
        taxRateBasisPoints: 0,
        lineItems: [
          {
            description: "Advisory Service",
            quantity: 2,
            unitPriceMinorUnits: 50000, // $500.00
          },
        ],
      },
    });

    const invoiceRes = await draftInvoiceRoute(invoiceReq);
    expect(invoiceRes.status).toBe(201);
    const invoiceJson = await invoiceRes.json();
    expect(invoiceJson.success).toBe(true);

    const invoice = invoiceJson.data;
    createdInvoiceIds.push(invoice.id);

    // Verified: invoice inherits isDemoData: true from client within Demo Workspace
    expect(invoice.workspaceId).toBe(DEMO_WORKSPACE_ID);
    expect(invoice.isDemoData).toBe(true);
    expect(invoice.client.isDemo).toBe(true);

    // Update invoice to SENT (simulating PayPal Sandbox sending)
    await db.invoice.update({
      where: { id: invoice.id },
      data: {
        cashpilotStatus: "AWAITING_PAYMENT",
        paypalStatus: "SENT",
        paypalInvoiceId: "INV2-TEST-PROVENANCE-01",
      },
    });

    // Verified: can be simulated because it has isDemoData: true
    const simResult = await simulateDemoPayment({
      invoiceId: invoice.id,
      actorId: DEMO_USER_ID,
    });
    expect(simResult.ok).toBe(true);
    if (simResult.ok) {
      expect(simResult.data.cashpilotStatus).toBe("SIMULATED_PAID");
      expect(simResult.data.paymentProvenance).toBe("SIMULATED_DEMO_PAYMENT");
    }
  });

  it("3. Quick-added client in User Workspace gets isDemo: false", async () => {
    const req = makeRequest("/api/clients", {
      method: "POST",
      cookie: userSessionCookie,
      body: {
        name: "Real Client Ltd",
        email: "billing@realclient.com",
        company: "Real Client",
        // Client attempting to elevate to demo status must be ignored
        isDemo: true,
        workspaceId: DEMO_WORKSPACE_ID,
      },
    });

    const res = await createClientRoute(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);

    const client = json.data;
    createdClientIds.push(client.id);

    // Verified: assigned to User Workspace and isDemo is strictly false
    expect(client.workspaceId).toBe(userWorkspaceId);
    expect(client.isDemo).toBe(false);
  });

  it("4. User Workspace invoice cannot become simulation-eligible", async () => {
    // Create a client in User Workspace
    const clientReq = makeRequest("/api/clients", {
      method: "POST",
      cookie: userSessionCookie,
      body: {
        name: "User Client Consulting",
        email: "consulting@userclient.com",
      },
    });
    const clientRes = await createClientRoute(clientReq);
    expect(clientRes.status).toBe(201);
    const clientJson = await clientRes.json();
    const clientId = clientJson.data.id;
    createdClientIds.push(clientId);
    expect(clientJson.data.isDemo).toBe(false);

    // Create invoice draft in User Workspace
    const invoiceReq = makeRequest("/api/invoices/draft", {
      method: "POST",
      cookie: userSessionCookie,
      body: {
        clientId,
        title: "Standard Consulting",
        invoiceDate: "2026-11-02",
        dueDate: "2026-11-16",
        currency: "USD",
        taxRateBasisPoints: 0,
        lineItems: [
          {
            description: "Consulting Hours",
            quantity: 5,
            unitPriceMinorUnits: 10000,
          },
        ],
      },
    });

    const invoiceRes = await draftInvoiceRoute(invoiceReq);
    expect(invoiceRes.status).toBe(201);
    const invoiceJson = await invoiceRes.json();
    const invoice = invoiceJson.data;
    createdInvoiceIds.push(invoice.id);

    // Verified: invoice is NOT demo data
    expect(invoice.workspaceId).toBe(userWorkspaceId);
    expect(invoice.isDemoData).toBe(false);

    // Test A: Direct service call rejects simulation
    const simServiceResult = await simulateDemoPayment({
      invoiceId: invoice.id,
      actorId: DEMO_USER_ID,
    });
    expect(simServiceResult.ok).toBe(false);
    if (!simServiceResult.ok) {
      expect(simServiceResult.code).toBe("NON_DEMO_INVOICE_REJECTED");
      expect(simServiceResult.status).toBe(403);
    }

    // Test B: API route rejects simulation from normal user session with 403 Forbidden
    const simReq = makeRequest(`/api/invoices/${invoice.id}/simulate-payment`, {
      method: "POST",
      cookie: userSessionCookie,
    });
    const simRouteRes = await simulatePaymentRoute(simReq, {
      params: Promise.resolve({ id: invoice.id }),
    });
    expect(simRouteRes.status).toBe(403);
    const simRouteJson = await simRouteRes.json();
    expect(simRouteJson.success).toBe(false);
    expect(simRouteJson.code).toBe("FORBIDDEN_DEMO_SIMULATION");

    // Test C: Even if demo user attempts to simulate non-demo invoice, API rejects with 403 NON_DEMO_INVOICE_REJECTED
    const simAsDemoReq = makeRequest(`/api/invoices/${invoice.id}/simulate-payment`, {
      method: "POST",
      cookie: demoSessionCookie,
    });
    const simAsDemoRes = await simulatePaymentRoute(simAsDemoReq, {
      params: Promise.resolve({ id: invoice.id }),
    });
    expect(simAsDemoRes.status).toBe(403);
    const simAsDemoJson = await simAsDemoRes.json();
    expect(simAsDemoJson.success).toBe(false);
    expect(simAsDemoJson.code).toBe("NON_DEMO_INVOICE_REJECTED");
  });

  it("5. Cross-workspace client creation and association remains forbidden", async () => {
    // A: Unauthenticated request is rejected with 401
    const unauthReq = makeRequest("/api/clients", {
      method: "POST",
      body: {
        name: "Unauthenticated Client",
        email: "unauth@example.com",
      },
    });
    const unauthRes = await createClientRoute(unauthReq);
    expect(unauthRes.status).toBe(401);

    // B: User session attempting to create a client cannot inject it into Demo Workspace
    const injectReq = makeRequest("/api/clients", {
      method: "POST",
      cookie: userSessionCookie,
      body: {
        name: "Injected Client",
        email: "injected@example.com",
        workspaceId: DEMO_WORKSPACE_ID, // Malicious override attempt
      },
    });
    const injectRes = await createClientRoute(injectReq);
    expect(injectRes.status).toBe(201);
    const injectJson = await injectRes.json();
    createdClientIds.push(injectJson.data.id);

    // The client was created in User Workspace, NOT Demo Workspace!
    expect(injectJson.data.workspaceId).toBe(userWorkspaceId);
    expect(injectJson.data.isDemo).toBe(false);

    // C: Demo Workspace attempting to create an invoice referencing User Workspace client fails closed (404)
    const crossInvoiceReq = makeRequest("/api/invoices/draft", {
      method: "POST",
      cookie: demoSessionCookie,
      body: {
        clientId: injectJson.data.id, // Client belongs to userWorkspaceId
        title: "Cross Workspace Exploit",
        invoiceDate: "2026-11-02",
        dueDate: "2026-11-16",
        currency: "USD",
        taxRateBasisPoints: 0,
        lineItems: [
          {
            description: "Illegal Cross Reference",
            quantity: 1,
            unitPriceMinorUnits: 1000,
          },
        ],
      },
    });
    const crossInvoiceRes = await draftInvoiceRoute(crossInvoiceReq);
    expect(crossInvoiceRes.status).toBe(404);
    const crossInvoiceJson = await crossInvoiceRes.json();
    expect(crossInvoiceJson.success).toBe(false);
    expect(crossInvoiceJson.code).toBe("NOT_FOUND");
  });
});
