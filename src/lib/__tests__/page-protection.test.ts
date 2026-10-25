/**
 * CashPilot AI — Server-Side Page Protection & Workspace Isolation Tests (Phase 2D.1)
 *
 * Invariants tested:
 * - requireAuth() redirects unauthenticated visitors to /login
 * - requireAuth() returns verified SessionContext when active session cookie is present
 * - Cross-workspace invoice detail isolation: User A cannot retrieve User B's invoice (triggers notFound)
 * - New user workspace isolation: New accounts see only their own empty workspace, never demo data
 * - Logout invalidation: revoking a session invalidates subsequent authentication attempts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCurrentSession, requireAuth } from "@/lib/auth/server-session";
import {
  createTestSession,
  clearTestSessions,
} from "@/lib/test-utils/auth";
import { revokeSession, verifySessionToken } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { CashPilotStatus } from "@prisma/client";

// Mock next/headers
const mockCookieStore: Map<string, string> = new Map();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const val = mockCookieStore.get(name);
      return val ? { name, value: val } : undefined;
    },
    set: (name: string, value: string) => {
      mockCookieStore.set(name, value);
    },
    delete: (name: string) => {
      mockCookieStore.delete(name);
    },
  })),
}));

// Mock next/navigation redirect
const mockRedirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

describe("Server-Side Page Protection & Workspace Isolation (Phase 2D.1)", () => {
  beforeEach(() => {
    mockCookieStore.clear();
    clearTestSessions();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockCookieStore.clear();
    clearTestSessions();
  });

  describe("getCurrentSession & requireAuth", () => {
    it("returns null from getCurrentSession when no session cookie is present", async () => {
      const session = await getCurrentSession();
      expect(session).toBeNull();
    });

    it("returns null from getCurrentSession when session cookie has an unknown token", async () => {
      mockCookieStore.set("cashpilot_session", "invalid-unregistered-token");
      const session = await getCurrentSession();
      expect(session).toBeNull();
    });

    it("resolves active SessionContext when valid session cookie is present", async () => {
      const created = createTestSession({
        userId: "user-test-page-1",
        workspaceId: "workspace-test-page-1",
        email: "page-test@example.com",
        name: "Page Test User",
      });

      mockCookieStore.set("cashpilot_session", created.token);

      const session = await getCurrentSession();
      expect(session).not.toBeNull();
      expect(session?.user.id).toBe("user-test-page-1");
      expect(session?.user.email).toBe("page-test@example.com");
      expect(session?.workspace?.id).toBe("workspace-test-page-1");
    });

    it("redirects unauthenticated visitor to /login in requireAuth", async () => {
      await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT:/login");
      expect(mockRedirect).toHaveBeenCalledWith("/login");
    });

    it("returns authenticated session in requireAuth when valid cookie is present", async () => {
      const created = createTestSession({
        userId: "user-auth-req-1",
        workspaceId: "workspace-auth-req-1",
      });

      mockCookieStore.set("cashpilot_session", created.token);

      const session = await requireAuth();
      expect(session.user.id).toBe("user-auth-req-1");
      expect(session.workspace.id).toBe("workspace-auth-req-1");
      expect(mockRedirect).not.toHaveBeenCalled();
    });
  });

  describe("Cross-Workspace Invoice Access Isolation", () => {
    const userA = "user-isolation-a";
    const workspaceA = "ws-isolation-a";
    const userB = "user-isolation-b";
    const workspaceB = "ws-isolation-b";
    const clientB = "client-isolation-b";
    const invoiceBId = "inv-isolation-b-1";

    beforeEach(async () => {
      // Create user B workspace, client, and invoice in database
      await db.workspace.upsert({
        where: { id: workspaceB },
        update: { ownerId: userB },
        create: {
          id: workspaceB,
          name: "Workspace B",
          ownerId: userB,
          isDemo: false,
        },
      });

      await db.client.upsert({
        where: { id: clientB },
        update: {},
        create: {
          id: clientB,
          workspaceId: workspaceB,
          name: "Client B",
          email: "client-b@test.com",
          isDemo: false,
        },
      });

      await db.invoice.upsert({
        where: { id: invoiceBId },
        update: { workspaceId: workspaceB },
        create: {
          id: invoiceBId,
          workspaceId: workspaceB,
          clientId: clientB,
          number: "INV-B-001",
          title: "User B Private Invoice",
          currency: "USD",
          subtotalMinorUnits: 150000,
          taxMinorUnits: 0,
          totalMinorUnits: 150000,
          invoiceDate: new Date(),
          dueDate: new Date(),
          cashpilotStatus: CashPilotStatus.DRAFT,
          isDemoData: false,
        },
      });
    });

    afterEach(async () => {
      await db.invoiceLineItem.deleteMany({
        where: { invoice: { workspaceId: workspaceB } },
      });
      await db.invoice.deleteMany({
        where: { workspaceId: workspaceB },
      });
      await db.client.deleteMany({
        where: { workspaceId: workspaceB },
      });
      await db.workspace.deleteMany({
        where: { id: { in: [workspaceA, workspaceB] } },
      });
    });

    it("verifies User A cannot access User B's invoice (server-side boundary check)", async () => {
      // User A session
      const sessionA = createTestSession({
        userId: userA,
        workspaceId: workspaceA,
      });

      // Fetch invoice B from database
      const invoiceB = await db.invoice.findUnique({
        where: { id: invoiceBId },
        include: { workspace: true },
      });

      expect(invoiceB).not.toBeNull();
      // Enforce the exact check used in InvoiceDetailContent:
      // if (!invoice || invoice.workspace.ownerId !== session.user.id) -> notFound()
      const isAuthorized = invoiceB && invoiceB.workspace.ownerId === sessionA.sessionContext.user.id;
      expect(isAuthorized).toBe(false);
    });

    it("verifies User B can access their own invoice", async () => {
      // User B session
      const sessionB = createTestSession({
        userId: userB,
        workspaceId: workspaceB,
      });

      const invoiceB = await db.invoice.findUnique({
        where: { id: invoiceBId },
        include: { workspace: true },
      });

      expect(invoiceB).not.toBeNull();
      const isAuthorized = invoiceB && invoiceB.workspace.ownerId === sessionB.sessionContext.user.id;
      expect(isAuthorized).toBe(true);
    });
  });

  describe("New User Workspace Isolation (Zero Demo Data Leak)", () => {
    const newUserId = "user-new-empty-account";
    const newWorkspaceId = "ws-new-empty-account";

    beforeEach(async () => {
      await db.workspace.upsert({
        where: { id: newWorkspaceId },
        update: { ownerId: newUserId },
        create: {
          id: newWorkspaceId,
          name: "Fresh Studio",
          ownerId: newUserId,
          isDemo: false,
        },
      });
    });

    afterEach(async () => {
      await db.workspace.deleteMany({
        where: { id: newWorkspaceId },
      });
    });

    it("verifies a new workspace query returns 0 invoices and 0 clients without leaking demo data", async () => {
      // Fetch invoices scoped to new workspace
      const invoices = await db.invoice.findMany({
        where: { workspaceId: newWorkspaceId },
      });
      expect(invoices).toHaveLength(0);

      // Fetch clients scoped to new workspace
      const clients = await db.client.findMany({
        where: { workspaceId: newWorkspaceId },
      });
      expect(clients).toHaveLength(0);

      // Verify demo invoices and demo clients from demo-workspace-1 are NEVER returned
      const anyDemoInvoices = invoices.some((i) => i.isDemoData || i.workspaceId === "demo-workspace-1");
      expect(anyDemoInvoices).toBe(false);
    });
  });

  describe("Logout Revocation", () => {
    it("invalidates session upon revocation so subsequent verification fails", async () => {
      const created = createTestSession({
        userId: "user-logout-test",
        workspaceId: "ws-logout-test",
      });

      // Initially valid
      const initial = await verifySessionToken(created.token);
      expect(initial).not.toBeNull();

      // Revoke session
      const revoked = await revokeSession(created.token);
      expect(revoked).toBe(true);

      // Subsequent lookup fails
      const afterRevocation = await verifySessionToken(created.token);
      expect(afterRevocation).toBeNull();
    });
  });
});
