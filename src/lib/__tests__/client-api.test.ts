/**
 * CashPilot AI — Client Management API Integration Tests (Phase 3A.1)
 *
 * Requirements:
 * - Unauthenticated access returns 401
 * - Create/list/search/update work only in the authenticated workspace
 * - Foreign-workspace client IDs cannot be read, modified, or deleted (returns 404, fails closed)
 * - Client input validation and empty updates are rejected with 400
 * - New clients use the session workspace and force `isDemo: false`
 * - Unreferenced deletion succeeds; deletion of a client referenced by invoices returns 409
 * - Demo seed clients remain intact
 * - Strictly target `cashpilot_disposable_test` with database safety checks
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET as listRoute, POST as createRoute } from "@/app/api/clients/route";
import {
  GET as getClientRoute,
  PATCH as updateRoute,
  DELETE as deleteRoute,
} from "@/app/api/clients/[id]/route";
import { db } from "@/lib/db/client";
import {
  assertAllowedTestDatabase,
  ensureTestUsers,
  cleanupTestUsers,
  createTestSession,
} from "@/lib/test-utils/auth";

describe("Client Management API Integration Tests (Phase 3A.1)", () => {
  const userAId = "test-client-user-a";
  const userBId = "test-client-user-b";
  const workspaceAId = "test-client-ws-a";
  const workspaceBId = "test-client-ws-b";

  let cookieA = "";
  let cookieB = "";

  const createdClientIds: string[] = [];
  const createdInvoiceIds: string[] = [];

  function makeRequest(
    url: string,
    options?: {
      method?: string;
      body?: unknown;
      cookie?: string;
    }
  ): NextRequest {
    const headers = new Headers();
    if (options?.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (options?.cookie) {
      headers.set("Cookie", options.cookie);
    }
    return new NextRequest(new URL(url, "http://localhost:3000"), {
      method: options?.method ?? "GET",
      headers,
      body:
        options?.body !== undefined
          ? typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body)
          : undefined,
    });
  }

  beforeAll(async () => {
    // 1. Safety guard: ensure running against disposable test database only
    await assertAllowedTestDatabase();

    // 2. Ensure test fixture users exist in User table
    await ensureTestUsers([
      { id: userAId, email: "client-a@test.internal", name: "User A" },
      { id: userBId, email: "client-b@test.internal", name: "User B" },
    ]);

    // 3. Ensure test workspaces exist
    await db.workspace.upsert({
      where: { id: workspaceAId },
      update: {},
      create: {
        id: workspaceAId,
        name: "Studio A",
        ownerId: userAId,
        isDemo: false,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceBId },
      update: {},
      create: {
        id: workspaceBId,
        name: "Studio B",
        ownerId: userBId,
        isDemo: false,
      },
    });

    // 4. Register test sessions for User A and User B
    const sessionA = createTestSession({
      userId: userAId,
      workspaceId: workspaceAId,
      email: "client-a@test.internal",
      name: "User A",
      isDemo: false,
    });
    cookieA = sessionA.cookieHeader;

    const sessionB = createTestSession({
      userId: userBId,
      workspaceId: workspaceBId,
      email: "client-b@test.internal",
      name: "User B",
      isDemo: false,
    });
    cookieB = sessionB.cookieHeader;
  });

  afterAll(async () => {
    await assertAllowedTestDatabase();

    // Clean up created invoices first (foreign key dependency)
    if (createdInvoiceIds.length > 0) {
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

    // Clean up test workspaces
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceAId, workspaceBId] } },
    });

    // Clean up synthetic test fixture users
    await cleanupTestUsers();
  });

  describe("Authentication Enforcement", () => {
    it("returns 401 when listing clients without authentication", async () => {
      const req = makeRequest("/api/clients");
      const res = await listRoute(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when creating a client without authentication", async () => {
      const req = makeRequest("/api/clients", {
        method: "POST",
        body: { name: "Test Client", email: "test@example.com" },
      });
      const res = await createRoute(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when getting a client without authentication", async () => {
      const req = makeRequest("/api/clients/dummy-id");
      const res = await getClientRoute(req, {
        params: Promise.resolve({ id: "dummy-id" }),
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when updating a client without authentication", async () => {
      const req = makeRequest("/api/clients/dummy-id", {
        method: "PATCH",
        body: { name: "Updated Name" },
      });
      const res = await updateRoute(req, {
        params: Promise.resolve({ id: "dummy-id" }),
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 when deleting a client without authentication", async () => {
      const req = makeRequest("/api/clients/dummy-id", {
        method: "DELETE",
      });
      const res = await deleteRoute(req, {
        params: Promise.resolve({ id: "dummy-id" }),
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("UNAUTHORIZED");
    });
  });

  describe("Client Input Validation", () => {
    it("rejects non-JSON or malformed request bodies", async () => {
      const req = makeRequest("/api/clients", {
        method: "POST",
        cookie: cookieA,
        body: "invalid json string {",
      });
      const res = await createRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("INVALID_JSON");
    });

    it("rejects missing required fields (name, email)", async () => {
      const req = makeRequest("/api/clients", {
        method: "POST",
        cookie: cookieA,
        body: {},
      });
      const res = await createRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("VALIDATION_ERROR");
      expect(json.error).toContain("Client name is required");
    });

    it("rejects empty or whitespace-only name", async () => {
      const req = makeRequest("/api/clients", {
        method: "POST",
        cookie: cookieA,
        body: { name: "   ", email: "valid@example.com" },
      });
      const res = await createRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid email formats", async () => {
      const req = makeRequest("/api/clients", {
        method: "POST",
        cookie: cookieA,
        body: { name: "Client Test", email: "not-an-email" },
      });
      const res = await createRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("VALIDATION_ERROR");
      expect(json.error).toContain("valid email");
    });

    it("rejects empty PATCH updates", async () => {
      const req = makeRequest("/api/clients/some-id", {
        method: "PATCH",
        cookie: cookieA,
        body: {},
      });
      const res = await updateRoute(req, {
        params: Promise.resolve({ id: "some-id" }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("VALIDATION_ERROR");
      expect(json.error).toContain("At least one field must be provided");
    });

    it("rejects PATCH with whitespace-only name", async () => {
      const req = makeRequest("/api/clients/some-id", {
        method: "PATCH",
        cookie: cookieA,
        body: { name: "   " },
      });
      const res = await updateRoute(req, {
        params: Promise.resolve({ id: "some-id" }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Workspace Isolation, Creation, and Listing", () => {
    let clientAId = "";

    it("creates a client bound to the authenticated workspace with isDemo: false", async () => {
      const req = makeRequest("/api/clients", {
        method: "POST",
        cookie: cookieA,
        body: {
          name: "Acme Alpha",
          email: "billing@alpha.example.com",
          company: "Alpha Corp",
          phone: "+1-555-0101",
          notes: "Primary client",
          // Attempting to override workspaceId or isDemo must be ignored
          workspaceId: workspaceBId,
          isDemo: true,
        },
      });

      const res = await createRoute(req);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);

      const client = json.data;
      expect(client.name).toBe("Acme Alpha");
      expect(client.email).toBe("billing@alpha.example.com");
      expect(client.company).toBe("Alpha Corp");
      expect(client.phone).toBe("+1-555-0101");
      expect(client.notes).toBe("Primary client");
      // Critical invariants:
      expect(client.workspaceId).toBe(workspaceAId); // Derived from session, NOT body
      expect(client.isDemo).toBe(false); // User-created clients are always non-demo

      clientAId = client.id;
      createdClientIds.push(clientAId);
    });

    it("lists clients within User A's workspace", async () => {
      const req = makeRequest("/api/clients", { cookie: cookieA });
      const res = await listRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);

      const found = json.data.find((c: { id: string }) => c.id === clientAId);
      expect(found).toBeDefined();
      expect(found.name).toBe("Acme Alpha");
    });

    it("Workspace B starts empty and cannot see Workspace A's clients", async () => {
      const req = makeRequest("/api/clients", { cookie: cookieB });
      const res = await listRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const found = json.data.find((c: { id: string }) => c.id === clientAId);
      expect(found).toBeUndefined();
    });

    it("searches clients by name, email, or company in authenticated workspace", async () => {
      // Matching search
      const reqMatch = makeRequest("/api/clients?search=alpha", { cookie: cookieA });
      const resMatch = await listRoute(reqMatch);
      expect(resMatch.status).toBe(200);
      const jsonMatch = await resMatch.json();
      expect(jsonMatch.data.length).toBeGreaterThanOrEqual(1);
      expect(jsonMatch.data[0].id).toBe(clientAId);

      // Non-matching search
      const reqNoMatch = makeRequest("/api/clients?search=nonexistentterm", { cookie: cookieA });
      const resNoMatch = await listRoute(reqNoMatch);
      expect(resNoMatch.status).toBe(200);
      const jsonNoMatch = await resNoMatch.json();
      expect(jsonNoMatch.data.length).toBe(0);
    });

    it("fails closed (404) when User B tries to GET User A's client by ID", async () => {
      const req = makeRequest(`/api/clients/${clientAId}`, { cookie: cookieB });
      const res = await getClientRoute(req, {
        params: Promise.resolve({ id: clientAId }),
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("NOT_FOUND");
    });

    it("fails closed (404) when User B tries to PATCH User A's client", async () => {
      const req = makeRequest(`/api/clients/${clientAId}`, {
        method: "PATCH",
        cookie: cookieB,
        body: { name: "Hacked Name" },
      });
      const res = await updateRoute(req, {
        params: Promise.resolve({ id: clientAId }),
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("NOT_FOUND");

      // Verify name was not modified
      const client = await db.client.findUnique({ where: { id: clientAId } });
      expect(client?.name).toBe("Acme Alpha");
    });

    it("fails closed (404) when User B tries to DELETE User A's client", async () => {
      const req = makeRequest(`/api/clients/${clientAId}`, {
        method: "DELETE",
        cookie: cookieB,
      });
      const res = await deleteRoute(req, {
        params: Promise.resolve({ id: clientAId }),
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("NOT_FOUND");

      // Verify client still exists in database
      const client = await db.client.findUnique({ where: { id: clientAId } });
      expect(client).toBeDefined();
    });

    it("successfully updates a client in the authenticated workspace", async () => {
      const req = makeRequest(`/api/clients/${clientAId}`, {
        method: "PATCH",
        cookie: cookieA,
        body: {
          company: "Alpha Global Enterprises",
          phone: "+1-555-0999",
        },
      });
      const res = await updateRoute(req, {
        params: Promise.resolve({ id: clientAId }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.company).toBe("Alpha Global Enterprises");
      expect(json.data.phone).toBe("+1-555-0999");
      expect(json.data.name).toBe("Acme Alpha"); // Unchanged
    });
  });

  describe("Deletion Safety and Referential Integrity", () => {
    let unreferencedClientId = "";
    let referencedClientId = "";
    let testInvoiceId = "";

    beforeAll(async () => {
      // Create unreferenced client
      const unrefClient = await db.client.create({
        data: {
          workspaceId: workspaceAId,
          name: "Unreferenced Client",
          email: "unreferenced@test.internal",
          isDemo: false,
        },
      });
      unreferencedClientId = unrefClient.id;
      createdClientIds.push(unreferencedClientId);

      // Create referenced client and an invoice referencing it
      const refClient = await db.client.create({
        data: {
          workspaceId: workspaceAId,
          name: "Referenced Client",
          email: "referenced@test.internal",
          isDemo: false,
        },
      });
      referencedClientId = refClient.id;
      createdClientIds.push(referencedClientId);

      const invoice = await db.invoice.create({
        data: {
          workspaceId: workspaceAId,
          clientId: referencedClientId,
          number: "INV-TEST-CLIENT-REF",
          title: "Referenced Client Invoice",
          currency: "USD",
          subtotalMinorUnits: 10000,
          totalMinorUnits: 10000,
          dueDate: new Date(Date.now() + 86400000),
          lineItems: {
            create: [
              {
                description: "Test service",
                quantity: 1,
                unitPriceMinorUnits: 10000,
                totalMinorUnits: 10000,
              },
            ],
          },
        },
      });
      testInvoiceId = invoice.id;
      createdInvoiceIds.push(testInvoiceId);
    });

    it("allows deletion of an unreferenced client", async () => {
      const req = makeRequest(`/api/clients/${unreferencedClientId}`, {
        method: "DELETE",
        cookie: cookieA,
      });
      const res = await deleteRoute(req, {
        params: Promise.resolve({ id: unreferencedClientId }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.deleted).toBe(true);

      // Verify deletion from database
      const check = await db.client.findUnique({
        where: { id: unreferencedClientId },
      });
      expect(check).toBeNull();
    });

    it("rejects deletion with 409 when client is referenced by an invoice", async () => {
      const req = makeRequest(`/api/clients/${referencedClientId}`, {
        method: "DELETE",
        cookie: cookieA,
      });
      const res = await deleteRoute(req, {
        params: Promise.resolve({ id: referencedClientId }),
      });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe("CANNOT_DELETE_CLIENT_WITH_INVOICES");
      expect(json.error).toContain("Cannot delete client with existing invoices");

      // Verify client and invoice still exist in database
      const clientCheck = await db.client.findUnique({
        where: { id: referencedClientId },
      });
      expect(clientCheck).not.toBeNull();

      const invoiceCheck = await db.invoice.findUnique({
        where: { id: testInvoiceId },
      });
      expect(invoiceCheck).not.toBeNull();
    });
  });

  describe("Judge Demo Clients Preservation", () => {
    it("ensures demo seed clients remain intact in the database", async () => {
      const demoClients = await db.client.findMany({
        where: { isDemo: true },
        select: { id: true, name: true, isDemo: true, workspaceId: true },
      });

      expect(demoClients.length).toBeGreaterThanOrEqual(3);
      const names = demoClients.map((c) => c.name);
      expect(names).toContain("Acme Corporation");
      expect(names).toContain("Jane Smith");
      expect(names.some((n) => n.startsWith("TechStart"))).toBe(true);
    });
  });
});
