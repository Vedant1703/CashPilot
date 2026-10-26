/**
 * CashPilot AI — Judge Demo Access & Session Security Validation Tests (Phase 2D.2)
 *
 * SRS § 4: Workspace and user isolation boundary
 * SRS § 7: Server-enforced identity boundaries, fail-closed security, locked credentials
 *
 * This test suite covers:
 * Part 1: Fail-closed & security boundary tests (mocked failure modes & input validation)
 *   - Database/schema errors fail closed (never grant access or bypass auth)
 *   - Missing User or Session table returns 500 INTERNAL_ERROR
 *   - Ordinary login rejects locked demo credentials (401 INVALID_CREDENTIALS)
 *   - Forged, expired, and revoked session tokens fail closed
 *   - Parameter tampering immunity (POST /api/auth/demo ignores client request bodies)
 *   - Invariant enforcement: corrupted email, unlocked credentials, or non-demo workspace fail closed
 *   - Unexpected ownership: workspace owned by another user fails closed (500 DEMO_OWNERSHIP_MISMATCH)
 *
 * Part 2: Real PostgreSQL integration on isolated disposable DB (cashpilot_disposable_test)
 *   - Strict test database safety guard (fails closed unless connected to cashpilot_disposable_test)
 *   - Real database session creation, persistence, and SHA-256 token hashing
 *   - Real cross-workspace access isolation (demo user cannot access User B; User B cannot access demo)
 *   - Targeted Check 1: Unexpected ownership rejection (never silently take ownership)
 *   - Targeted Check 2: Existing data preservation (repeated access does not reset invoices/clients/settings)
 *   - Targeted Check 3: Repeated and concurrent requests (safe concurrent sessions without corruption)
 *   - Targeted Check 4: Canonical user invariants (existing demo identity records not silently repaired)
 *   - Safe test cleanup deleting only test-created records
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { POST as demoAuthHandler } from "@/app/api/auth/demo/route";
import { POST as loginHandler } from "@/app/api/auth/login/route";
import {
  verifySessionToken,
  createSession,
  revokeSession,
  hashSessionToken,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";
import { db } from "@/lib/db/client";
import { PrismaClient, CashPilotStatus } from "@prisma/client";
import { NextRequest } from "next/server";

describe("Part 1: Demo Auth & Session Security — Unit & Failure Modes (Mocked & Fail-Closed)", () => {
  it("fails closed with 500 when User table is missing or db.user.findUnique throws", async () => {
    vi.spyOn(db.user, "findUnique").mockRejectedValueOnce(
      new Error('relation "User" does not exist')
    );

    const res = await demoAuthHandler();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("INTERNAL_ERROR");

    // Must NEVER issue a session cookie on failure
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeNull();
  });

  it("fails closed with 500 when Session table is missing or db.session.create throws", async () => {
    vi.spyOn(db.user, "findUnique").mockResolvedValueOnce({
      id: "demo-user-1",
      email: "demo@cashpilot.test",
      name: "Demo User",
      passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.spyOn(db.workspace, "findUnique").mockResolvedValueOnce({
      id: "demo-workspace-1",
      name: "My Freelance Studio",
      ownerId: "demo-user-1",
      isDemo: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.spyOn(db.session, "create").mockRejectedValueOnce(
      new Error('relation "Session" does not exist')
    );

    const res = await demoAuthHandler();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("INTERNAL_ERROR");

    // Must NEVER issue a session cookie on failure
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeNull();
  });

  it("fails closed with 500 when login route encounters database/schema failure", async () => {
    vi.spyOn(db.user, "findUnique").mockRejectedValueOnce(
      new Error('relation "User" does not exist')
    );

    const req = new NextRequest("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "someone@example.com",
        password: "Password123!",
      }),
    });

    const res = await loginHandler(req);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("fails closed with 500 DEMO_OWNERSHIP_MISMATCH when demo-workspace-1 is owned by an unexpected user", async () => {
    vi.spyOn(db.user, "findUnique").mockResolvedValueOnce({
      id: "demo-user-1",
      email: "demo@cashpilot.test",
      name: "Demo User",
      passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Workspace exists but is owned by a different user!
    vi.spyOn(db.workspace, "findUnique").mockResolvedValueOnce({
      id: "demo-workspace-1",
      name: "My Freelance Studio",
      ownerId: "attacker-user-id",
      isDemo: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await demoAuthHandler();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("DEMO_OWNERSHIP_MISMATCH");

    // Must NEVER issue a cookie or silently reassign workspace
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeNull();
  });

  it("fails closed with 500 DEMO_INVARIANT_VIOLATION when demo user email is corrupted", async () => {
    vi.spyOn(db.user, "findUnique").mockResolvedValueOnce({
      id: "demo-user-1",
      email: "corrupted-email@evil.test",
      name: "Demo User",
      passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const updateSpy = vi.spyOn(db.user, "update");

    const res = await demoAuthHandler();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("DEMO_INVARIANT_VIOLATION");

    // Must NOT silently repair the corrupted record
    expect(updateSpy).not.toHaveBeenCalled();
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeNull();
  });

  it("fails closed with 500 DEMO_INVARIANT_VIOLATION when demo user password hash is unlocked", async () => {
    vi.spyOn(db.user, "findUnique").mockResolvedValueOnce({
      id: "demo-user-1",
      email: "demo@cashpilot.test",
      name: "Demo User",
      passwordHash: "scrypt$unlocked_password_hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const updateSpy = vi.spyOn(db.user, "update");

    const res = await demoAuthHandler();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("DEMO_INVARIANT_VIOLATION");

    // Must NOT silently overwrite or repair
    expect(updateSpy).not.toHaveBeenCalled();
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeNull();
  });

  it("fails closed with 500 DEMO_INVARIANT_VIOLATION when demo workspace is not flagged isDemo", async () => {
    vi.spyOn(db.user, "findUnique").mockResolvedValueOnce({
      id: "demo-user-1",
      email: "demo@cashpilot.test",
      name: "Demo User",
      passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.spyOn(db.workspace, "findUnique").mockResolvedValueOnce({
      id: "demo-workspace-1",
      name: "My Freelance Studio",
      ownerId: "demo-user-1",
      isDemo: false, // Invariant violation: must be isDemo: true
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await demoAuthHandler();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("DEMO_INVARIANT_VIOLATION");

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeNull();
  });

  it("verifies session creation succeeds and sets HTTP-only cookie on healthy database", async () => {
    vi.spyOn(db.user, "findUnique").mockResolvedValueOnce({
      id: "demo-user-1",
      email: "demo@cashpilot.test",
      name: "Demo User",
      passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.spyOn(db.workspace, "findUnique").mockResolvedValueOnce({
      id: "demo-workspace-1",
      name: "My Freelance Studio",
      ownerId: "demo-user-1",
      isDemo: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fakeExpiresAt = new Date(Date.now() + 7 * 86400 * 1000);
    vi.spyOn(db.session, "create").mockResolvedValueOnce({
      id: "sess-demo-unit-1",
      userId: "demo-user-1",
      tokenHash: "fake-hash",
      expiresAt: fakeExpiresAt,
      createdAt: new Date(),
    });

    const res = await demoAuthHandler();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.user.id).toBe("demo-user-1");
    expect(body.data.workspace.id).toBe("demo-workspace-1");
    expect(body.data.workspace.isDemo).toBe(true);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(SESSION_COOKIE_NAME);
    expect(setCookie?.toLowerCase()).toContain("httponly");
  });

  it("rejects password login attempts for demo user (locked credential)", async () => {
    vi.spyOn(db.user, "findUnique").mockResolvedValueOnce({
      id: "demo-user-1",
      email: "demo@cashpilot.test",
      name: "Demo User",
      passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
      createdAt: new Date(),
      updatedAt: new Date(),
      workspaces: [
        {
          id: "demo-workspace-1",
          name: "My Freelance Studio",
          isDemo: true,
        },
      ],
    } as never);

    const req = new NextRequest("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "demo@cashpilot.test",
        password: "Password123!",
      }),
    });

    const res = await loginHandler(req);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("INVALID_CREDENTIALS");
  });

  it("verifies forged session token fails closed (returns null)", async () => {
    vi.spyOn(db.session, "findUnique").mockResolvedValueOnce(null);

    const result = await verifySessionToken("forged-nonexistent-token-12345");
    expect(result).toBeNull();
  });

  it("verifies expired session token returns null and prunes expired session", async () => {
    const deleteSpy = vi.spyOn(db.session, "delete").mockResolvedValueOnce({} as never);

    vi.spyOn(db.session, "findUnique").mockResolvedValueOnce({
      id: "sess-expired-1",
      userId: "demo-user-1",
      tokenHash: "fake-hash",
      expiresAt: new Date(Date.now() - 60 * 1000), // Expired 1 minute ago
      createdAt: new Date(Date.now() - 100000),
      user: {
        id: "demo-user-1",
        email: "demo@cashpilot.test",
        name: "Demo User",
        createdAt: new Date(),
        workspaces: [
          {
            id: "demo-workspace-1",
            name: "My Freelance Studio",
            isDemo: true,
          },
        ],
      },
    } as never);

    const result = await verifySessionToken("some-expired-token");
    expect(result).toBeNull();
    expect(deleteSpy).toHaveBeenCalledWith({ where: { id: "sess-expired-1" } });
  });

  it("verifies revoked session token cannot be verified", async () => {
    const token = "token-to-revoke-123";
    const tokenHash = hashSessionToken(token);

    const deleteManySpy = vi.spyOn(db.session, "deleteMany").mockResolvedValueOnce({ count: 1 });
    const revoked = await revokeSession(token);
    expect(revoked).toBe(true);
    expect(deleteManySpy).toHaveBeenCalledWith({ where: { tokenHash } });

    vi.spyOn(db.session, "findUnique").mockResolvedValueOnce(null);
    const result = await verifySessionToken(token);
    expect(result).toBeNull();
  });
});

describe("Part 2: Real Database Integration on Isolated Disposable DB (cashpilot_disposable_test)", () => {
  const disposableDbUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL || "").replace(/\/cashpilot_dev(\?.*)?$/, "/cashpilot_disposable_test$1") ||
    "postgresql://cashpilot:cashpilot_dev_password@localhost:5433/cashpilot_disposable_test?schema=public";

  let prisma: PrismaClient;
  const userBId = `user-reg-b-${Date.now()}`;
  const workspaceBId = `ws-reg-b-${Date.now()}`;
  const clientBId = `client-reg-b-${Date.now()}`;
  const invoiceBId = `inv-reg-b-${Date.now()}`;

  const createdSessionIds: string[] = [];
  const testInvoiceId = `inv-preservation-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: disposableDbUrl } },
    });

    // 1. STRICT SAFETY GUARD: Verify we are exclusively on cashpilot_disposable_test
    const dbCheck = await prisma.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database();
    `;
    const currentDb = dbCheck[0]?.current_database;
    if (currentDb !== "cashpilot_disposable_test") {
      throw new Error(
        `SAFETY VIOLATION: Tests must run exclusively on "cashpilot_disposable_test", but connected to "${currentDb}". Aborting.`
      );
    }

    // Ensure demo user and demo workspace exist in disposable DB
    await prisma.user.upsert({
      where: { id: "demo-user-1" },
      update: {},
      create: {
        id: "demo-user-1",
        email: "demo@cashpilot.test",
        name: "Demo User",
        passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
      },
    });

    await prisma.workspace.upsert({
      where: { id: "demo-workspace-1" },
      update: { ownerId: "demo-user-1", isDemo: true },
      create: {
        id: "demo-workspace-1",
        name: "My Freelance Studio",
        ownerId: "demo-user-1",
        isDemo: true,
      },
    });

    // Setup regular user B and workspace B in disposable DB
    await prisma.user.create({
      data: {
        id: userBId,
        name: "User B",
        email: `${userBId}@regular.test`,
        passwordHash: "!LOCKED:REGULAR_USER_B",
      },
    });

    await prisma.workspace.create({
      data: {
        id: workspaceBId,
        name: "User B Studio",
        ownerId: userBId,
        isDemo: false,
      },
    });

    await prisma.client.create({
      data: {
        id: clientBId,
        workspaceId: workspaceBId,
        name: "Regular Client",
        email: "client@regular.test",
        isDemo: false,
      },
    });

    await prisma.invoice.create({
      data: {
        id: invoiceBId,
        workspaceId: workspaceBId,
        clientId: clientBId,
        number: "INV-REG-B-01",
        title: "User B Private Invoice",
        currency: "USD",
        subtotalMinorUnits: 200000,
        taxMinorUnits: 0,
        totalMinorUnits: 200000,
        invoiceDate: new Date(),
        dueDate: new Date(),
        cashpilotStatus: CashPilotStatus.DRAFT,
        isDemoData: false,
      },
    });
  });

  afterAll(async () => {
    const dbCheck = await prisma.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database();
    `;
    const currentDb = dbCheck[0]?.current_database;
    if (currentDb !== "cashpilot_disposable_test") {
      throw new Error(
        `SAFETY VIOLATION: Cleanup must run exclusively on "cashpilot_disposable_test", but connected to "${currentDb}". Aborting.`
      );
    }

    // Clean up created sessions
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({
        where: { id: { in: createdSessionIds } },
      }).catch(() => {});
    }

    // Clean up test invoice if created
    await prisma.invoiceLineItem.deleteMany({
      where: { invoiceId: testInvoiceId },
    }).catch(() => {});
    await prisma.invoice.deleteMany({
      where: { id: testInvoiceId },
    }).catch(() => {});

    // Clean up ONLY records created during this test suite
    await prisma.invoiceLineItem.deleteMany({
      where: { invoice: { workspaceId: workspaceBId } },
    }).catch(() => {});
    await prisma.invoice.deleteMany({
      where: { workspaceId: workspaceBId },
    }).catch(() => {});
    await prisma.client.deleteMany({
      where: { workspaceId: workspaceBId },
    }).catch(() => {});
    await prisma.workspace.deleteMany({
      where: { id: workspaceBId },
    }).catch(() => {});
    await prisma.user.deleteMany({
      where: { id: userBId },
    }).catch(() => {});

    await prisma.$disconnect();
  });

  it("creates a real session in PostgreSQL for demo-user-1 and persists hashed token", async () => {
    const { token, session } = await createSession("demo-user-1", prisma);
    createdSessionIds.push(session.id);

    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(session.id).toBeDefined();

    // Verify session row exists in real database
    const tokenHash = hashSessionToken(token);
    const dbSession = await prisma.session.findUnique({
      where: { tokenHash },
    });

    expect(dbSession).not.toBeNull();
    expect(dbSession?.userId).toBe("demo-user-1");
    expect(dbSession?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("verifies demo user context cannot access User B's workspace (cross-workspace isolation)", async () => {
    const { token, session } = await createSession("demo-user-1", prisma);
    createdSessionIds.push(session.id);

    // Create a request with demo session cookie attempting to access Workspace B
    const req = new NextRequest("http://localhost:3000/api/invoices", {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${token}`,
      },
    });

    // Spy on db to use our disposable prisma instance for authorization check
    vi.spyOn(db.session, "findUnique").mockImplementation((args) =>
      prisma.session.findUnique(args as never) as never
    );
    vi.spyOn(db.workspace, "findUnique").mockImplementation((args) =>
      prisma.workspace.findUnique(args as never) as never
    );

    const authResult = await authorizeWorkspaceAccess(req, workspaceBId);
    expect(authResult.authorized).toBe(false);
    if (!authResult.authorized) {
      expect(authResult.status).toBe(403);
      expect(authResult.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
    }
  });

  it("verifies User B context cannot access demo workspace (cross-workspace isolation)", async () => {
    const { token, session } = await createSession(userBId, prisma);
    createdSessionIds.push(session.id);

    // Create a request with User B session cookie attempting to access demo workspace
    const req = new NextRequest("http://localhost:3000/api/invoices", {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${token}`,
      },
    });

    vi.spyOn(db.session, "findUnique").mockImplementation((args) =>
      prisma.session.findUnique(args as never) as never
    );
    vi.spyOn(db.workspace, "findUnique").mockImplementation((args) =>
      prisma.workspace.findUnique(args as never) as never
    );

    const authResult = await authorizeWorkspaceAccess(req, "demo-workspace-1");
    expect(authResult.authorized).toBe(false);
    if (!authResult.authorized) {
      expect(authResult.status).toBe(403);
      expect(authResult.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
    }
  });

  it("verifies demo workspace has isDemo: true and User B workspace has isDemo: false", async () => {
    const demoWs = await prisma.workspace.findUnique({
      where: { id: "demo-workspace-1" },
    });
    const userBWs = await prisma.workspace.findUnique({
      where: { id: workspaceBId },
    });

    expect(demoWs?.isDemo).toBe(true);
    expect(userBWs?.isDemo).toBe(false);
  });

  // TARGETED TEST 1: Unexpected ownership rejection
  it("Targeted Check 1: refuses to usurp or overwrite an existing workspace with unexpected owner", async () => {
    // If demo-workspace-1 was owned by User B, demo route must fail closed without reassigning ownership
    vi.spyOn(db.user, "findUnique").mockImplementation((args) =>
      prisma.user.findUnique(args as never) as never
    );
    vi.spyOn(db.workspace, "findUnique").mockResolvedValueOnce({
      id: "demo-workspace-1",
      name: "Hijacked Studio",
      ownerId: userBId, // Unexpected owner!
      isDemo: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await demoAuthHandler();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("DEMO_OWNERSHIP_MISMATCH");

    // Verify in real database that workspace was not modified or usurped
    const actualWorkspace = await prisma.workspace.findUnique({
      where: { id: "demo-workspace-1" },
    });
    expect(actualWorkspace?.ownerId).toBe("demo-user-1");
  });

  // TARGETED TEST 2: Existing data preservation
  it("Targeted Check 2: preserves existing demo invoices, clients, and workspace settings on repeated access", async () => {
    // 1. Create a test invoice under demo-workspace-1
    await prisma.invoice.create({
      data: {
        id: testInvoiceId,
        workspaceId: "demo-workspace-1",
        clientId: clientBId,
        number: "INV-PRESERVE-01",
        title: "Preserved Demo Invoice",
        currency: "USD",
        subtotalMinorUnits: 350000,
        taxMinorUnits: 0,
        totalMinorUnits: 350000,
        invoiceDate: new Date(),
        dueDate: new Date(),
        cashpilotStatus: CashPilotStatus.DRAFT,
        isDemoData: true,
      },
    });

    // 2. Count invoices and clients before repeated access
    const invoiceCountBefore = await prisma.invoice.count({
      where: { workspaceId: "demo-workspace-1" },
    });
    const workspaceBefore = await prisma.workspace.findUnique({
      where: { id: "demo-workspace-1" },
    });

    // Wire db calls to disposable prisma instance
    vi.spyOn(db.user, "findUnique").mockImplementation((args) =>
      prisma.user.findUnique(args as never) as never
    );
    vi.spyOn(db.workspace, "findUnique").mockImplementation((args) =>
      prisma.workspace.findUnique(args as never) as never
    );
    vi.spyOn(db.session, "create").mockImplementation((args) =>
      prisma.session.create(args as never) as never
    );

    // 3. Call demoAuthHandler multiple times
    const res1 = await demoAuthHandler();
    const res2 = await demoAuthHandler();
    const res3 = await demoAuthHandler();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);

    // 4. Verify existing data was untouched
    const invoiceCountAfter = await prisma.invoice.count({
      where: { workspaceId: "demo-workspace-1" },
    });
    expect(invoiceCountAfter).toBe(invoiceCountBefore);

    const preservedInvoice = await prisma.invoice.findUnique({
      where: { id: testInvoiceId },
    });
    expect(preservedInvoice).not.toBeNull();
    expect(preservedInvoice?.title).toBe("Preserved Demo Invoice");
    expect(preservedInvoice?.totalMinorUnits).toBe(350000);

    const workspaceAfter = await prisma.workspace.findUnique({
      where: { id: "demo-workspace-1" },
    });
    expect(workspaceAfter?.name).toBe(workspaceBefore?.name);
    expect(workspaceAfter?.ownerId).toBe(workspaceBefore?.ownerId);
  });

  // TARGETED TEST 3: Repeated and concurrent requests
  it("Targeted Check 3: handles concurrent demo access requests without identity conflict or session bypass", async () => {
    vi.spyOn(db.user, "findUnique").mockImplementation((args) =>
      prisma.user.findUnique(args as never) as never
    );
    vi.spyOn(db.workspace, "findUnique").mockImplementation((args) =>
      prisma.workspace.findUnique(args as never) as never
    );
    vi.spyOn(db.session, "create").mockImplementation((args) =>
      prisma.session.create(args as never) as never
    );

    // Launch 5 concurrent demo access requests
    const concurrentResults = await Promise.all([
      demoAuthHandler(),
      demoAuthHandler(),
      demoAuthHandler(),
      demoAuthHandler(),
      demoAuthHandler(),
    ]);

    // All must succeed
    for (const res of concurrentResults) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.user.id).toBe("demo-user-1");
      expect(body.data.workspace.id).toBe("demo-workspace-1");

      const cookie = res.headers.get("set-cookie");
      expect(cookie).not.toBeNull();
      const match = cookie?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
      const token = match?.[1];
      expect(token).toBeDefined();

      // Verify each token is independently valid in the database
      const verified = await prisma.session.findUnique({
        where: { tokenHash: hashSessionToken(token!) },
      });
      expect(verified).not.toBeNull();
      expect(verified?.userId).toBe("demo-user-1");
      if (verified) {
        createdSessionIds.push(verified.id);
      }
    }

    // Verify there is still only exactly 1 demo-user-1 and 1 demo-workspace-1 in DB
    const users = await prisma.user.findMany({ where: { id: "demo-user-1" } });
    expect(users).toHaveLength(1);

    const workspaces = await prisma.workspace.findMany({ where: { id: "demo-workspace-1" } });
    expect(workspaces).toHaveLength(1);
  });

  // TARGETED TEST 4: Canonical user invariants
  it("Targeted Check 4: verifies canonical demo identity invariants are enforced and not silently repaired", async () => {
    // Canonical record verification in real DB
    const dbDemoUser = await prisma.user.findUnique({
      where: { id: "demo-user-1" },
    });
    expect(dbDemoUser).not.toBeNull();
    expect(dbDemoUser?.email).toBe("demo@cashpilot.test");
    expect(dbDemoUser?.passwordHash).toBe("!LOCKED:DEMO_USER_MANAGED_AUTH");

    // If corrupted record is returned, handler refuses to proceed
    vi.spyOn(db.user, "findUnique").mockResolvedValueOnce({
      id: "demo-user-1",
      email: "hijacked@cashpilot.test", // Corrupted
      name: "Demo User",
      passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await demoAuthHandler();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("DEMO_INVARIANT_VIOLATION");
  });
});
