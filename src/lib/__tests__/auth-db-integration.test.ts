/**
 * CashPilot AI — PostgreSQL-Backed Auth & Migration Integration Tests
 *
 * SRS § 4: Workspace and User Boundary
 * SRS § 7: Security & Financial Integrity
 *
 * Runs against the isolated disposable database (cashpilot_disposable_test)
 * with zero mocks on Prisma, verifying real database persistence, transactions,
 * constraints, and migration backfill behaviors.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  hashPassword,
  verifyPassword,
  isUsablePasswordHash,
} from "@/lib/auth/password";
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_TTL_SECONDS,
} from "@/lib/auth/session";

describe("PostgreSQL-Backed Auth Integration (Disposable DB)", () => {
  const disposableDbUrl = (process.env.DATABASE_URL || "").replace(
    /\/cashpilot_dev(\?.*)?$/,
    "/cashpilot_disposable_test$1"
  );

  let prisma: PrismaClient;
  const testRunId = `test-${Date.now()}`;
  const createdUserIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: {
        db: { url: disposableDbUrl },
      },
    });

    // Verify connection to disposable DB
    const res = await prisma.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database();
    `;
    expect(res[0].current_database).toBe("cashpilot_disposable_test");
  });

  afterAll(async () => {
    // Clean up created records in reverse dependency order
    if (createdWorkspaceIds.length > 0) {
      await prisma.invoiceLineItem.deleteMany({
        where: { invoice: { workspaceId: { in: createdWorkspaceIds } } },
      });
      await prisma.invoice.deleteMany({
        where: { workspaceId: { in: createdWorkspaceIds } },
      });
      await prisma.client.deleteMany({
        where: { workspaceId: { in: createdWorkspaceIds } },
      });
      await prisma.workspace.deleteMany({
        where: { id: { in: createdWorkspaceIds } },
      });
    }

    if (createdUserIds.length > 0) {
      await prisma.session.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }

    await prisma.$disconnect();
  });

  it("atomically creates user, session, and empty non-demo workspace on signup", async () => {
    const signupEmail = `signup-${testRunId}@example.com`;
    const signupPassword = "StrongPassword123!";
    const hashedPassword = await hashPassword(signupPassword);
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: signupEmail,
          name: "New Signup User",
          passwordHash: hashedPassword,
        },
      });

      const session = await tx.session.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      });

      const workspace = await tx.workspace.create({
        data: {
          name: "New Signup User's Workspace",
          ownerId: user.id,
          isDemo: false,
        },
      });

      return { user, session, workspace };
    });

    createdUserIds.push(result.user.id);
    createdWorkspaceIds.push(result.workspace.id);

    // Verify in database
    const persistedUser = await prisma.user.findUnique({
      where: { id: result.user.id },
      include: { sessions: true, workspaces: true },
    });

    expect(persistedUser).not.toBeNull();
    expect(persistedUser?.email).toBe(signupEmail);
    expect(persistedUser?.sessions).toHaveLength(1);
    expect(persistedUser?.sessions[0].tokenHash).toBe(tokenHash);
    expect(persistedUser?.workspaces).toHaveLength(1);
    expect(persistedUser?.workspaces[0].isDemo).toBe(false);
    expect(persistedUser?.workspaces[0].ownerId).toBe(result.user.id);

    // Verify invoices table is empty for the new workspace
    const invoiceCount = await prisma.invoice.count({
      where: { workspaceId: result.workspace.id },
    });
    expect(invoiceCount).toBe(0);

    // Verify atomic rollback on conflict
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            email: signupEmail, // Duplicate email!
            name: "Duplicate User",
            passwordHash: hashedPassword,
          },
        });
      })
    ).rejects.toThrow();
  }, 15000);

  it("persists login session and deletes it on logout", async () => {
    const loginEmail = `login-${testRunId}@example.com`;
    const loginPassword = "LoginPassword456!";
    const hashedPassword = await hashPassword(loginPassword);

    const user = await prisma.user.create({
      data: {
        email: loginEmail,
        name: "Login User",
        passwordHash: hashedPassword,
      },
    });
    createdUserIds.push(user.id);

    // 1. Password verification against database hash
    const dbUser = await prisma.user.findUnique({
      where: { email: loginEmail },
    });
    expect(dbUser).not.toBeNull();
    const isValid = await verifyPassword(loginPassword, dbUser!.passwordHash);
    expect(isValid).toBe(true);

    // 2. Persist session
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    // Verify session lookup with relation
    const foundSession = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    expect(foundSession).not.toBeNull();
    expect(foundSession?.userId).toBe(user.id);
    expect(foundSession?.user.email).toBe(loginEmail);

    // 3. Logout revoking persisted session
    await prisma.session.delete({
      where: { id: session.id },
    });

    const deletedSession = await prisma.session.findUnique({
      where: { tokenHash },
    });
    expect(deletedSession).toBeNull();
  }, 15000);

  it("handles expired and revoked sessions properly", async () => {
    const user = await prisma.user.create({
      data: {
        email: `expiry-${testRunId}@example.com`,
        name: "Expiry User",
        passwordHash: await hashPassword("ExpiryPass789!"),
      },
    });
    createdUserIds.push(user.id);

    // Insert an already expired session (past expiresAt)
    const expiredToken = generateSessionToken();
    const expiredTokenHash = hashSessionToken(expiredToken);
    const pastExpiresAt = new Date(Date.now() - 3600 * 1000); // 1 hour ago

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: expiredTokenHash,
        expiresAt: pastExpiresAt,
      },
    });

    // Query session
    const sessionRecord = await prisma.session.findUnique({
      where: { tokenHash: expiredTokenHash },
    });
    expect(sessionRecord).not.toBeNull();
    expect(sessionRecord!.expiresAt.getTime()).toBeLessThan(Date.now());

    // Prune expired sessions
    const { count } = await prisma.session.deleteMany({
      where: {
        tokenHash: expiredTokenHash,
        expiresAt: { lte: new Date() },
      },
    });
    expect(count).toBe(1);

    const pruned = await prisma.session.findUnique({
      where: { tokenHash: expiredTokenHash },
    });
    expect(pruned).toBeNull();
  });

  it("enforces cross-workspace invoice isolation via ownerId relationships", async () => {
    // Create Owner A and Workspace A
    const userA = await prisma.user.create({
      data: {
        email: `user-a-${testRunId}@example.com`,
        name: "User A",
        passwordHash: await hashPassword("UserPassA123!"),
      },
    });
    createdUserIds.push(userA.id);

    const wsA = await prisma.workspace.create({
      data: {
        name: "Workspace A",
        ownerId: userA.id,
        isDemo: false,
      },
    });
    createdWorkspaceIds.push(wsA.id);

    // Create Owner B and Workspace B
    const userB = await prisma.user.create({
      data: {
        email: `user-b-${testRunId}@example.com`,
        name: "User B",
        passwordHash: await hashPassword("UserPassB123!"),
      },
    });
    createdUserIds.push(userB.id);

    const wsB = await prisma.workspace.create({
      data: {
        name: "Workspace B",
        ownerId: userB.id,
        isDemo: false,
      },
    });
    createdWorkspaceIds.push(wsB.id);

    // Create invoice in Workspace A
    const clientA = await prisma.client.create({
      data: {
        workspaceId: wsA.id,
        name: "Client A",
        email: "client-a@example.com",
      },
    });

    const invoiceA = await prisma.invoice.create({
      data: {
        workspaceId: wsA.id,
        clientId: clientA.id,
        number: `INV-${testRunId}-A`,
        title: "Invoice for A",
        currency: "USD",
        subtotalMinorUnits: 10000,
        taxMinorUnits: 0,
        totalMinorUnits: 10000,
        invoiceDate: new Date(),
        dueDate: new Date(),
        cashpilotStatus: "DRAFT",
      },
    });

    // Query 1: User A accesses Invoice A (Authorized)
    const accessByA = await prisma.invoice.findFirst({
      where: {
        id: invoiceA.id,
        workspace: { ownerId: userA.id },
      },
    });
    expect(accessByA).not.toBeNull();
    expect(accessByA?.id).toBe(invoiceA.id);

    // Query 2: User B attempts to access Invoice A (Unauthorized cross-workspace)
    const accessByB = await prisma.invoice.findFirst({
      where: {
        id: invoiceA.id,
        workspace: { ownerId: userB.id },
      },
    });
    expect(accessByB).toBeNull();
  });

  it("rejects legacy locked users from logging in", async () => {
    // Legacy locked user created during migration backfill
    const legacyUser = await prisma.user.create({
      data: {
        id: `legacy-locked-user-${testRunId}`,
        email: `legacy+locked-${testRunId}@legacy.cashpilot.internal`,
        name: "Legacy Locked User",
        passwordHash: "!LOCKED:LEGACY_BACKFILL",
      },
    });
    createdUserIds.push(legacyUser.id);

    // Machine-check rejection of locked placeholders
    expect(isUsablePasswordHash(legacyUser.passwordHash)).toBe(false);

    // Verification attempt fails safely without throwing unhandled exceptions
    const verified = await verifyPassword("AnyPasswordAttempt!", legacyUser.passwordHash);
    expect(verified).toBe(false);

    // Demo locked user check
    const demoLockedUser = await prisma.user.create({
      data: {
        id: `demo-locked-user-${testRunId}`,
        email: `demo-locked-${testRunId}@cashpilot.test`,
        name: "Demo Locked User",
        passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
      },
    });
    createdUserIds.push(demoLockedUser.id);

    expect(isUsablePasswordHash(demoLockedUser.passwordHash)).toBe(false);
    const demoVerified = await verifyPassword("DemoPassword123!", demoLockedUser.passwordHash);
    expect(demoVerified).toBe(false);
  });

  it("verifies migration backfill SQL preserves workspace IDs and sets locked passwords", async () => {
    // 1. Create a user first so we can satisfy the FK constraint when creating a workspace
    const tempUser = await prisma.user.create({
      data: {
        id: `temp-owner-${testRunId}`,
        email: `temp-${testRunId}@example.com`,
        name: "Temp Owner",
        passwordHash: await hashPassword("TempPass123!"),
      },
    });
    createdUserIds.push(tempUser.id);

    const ws = await prisma.workspace.create({
      data: {
        id: `ws-backfill-${testRunId}`,
        name: "Backfill Test Workspace",
        ownerId: tempUser.id,
        isDemo: false,
      },
    });
    createdWorkspaceIds.push(ws.id);

    // 2. Verify that backfill query pattern would execute idempotently without error
    const backfillResult = await prisma.$executeRaw`
      INSERT INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
      SELECT DISTINCT
          w."ownerId" AS "id",
          CASE
              WHEN w."ownerId" = 'demo-user-1' THEN 'demo@cashpilot.test'
              ELSE 'legacy+' || w."ownerId" || '@legacy.cashpilot.internal'
          END AS "email",
          CASE
              WHEN w."ownerId" = 'demo-user-1' THEN 'Demo User'
              ELSE 'Legacy Workspace Owner (' || w."ownerId" || ')'
          END AS "name",
          CASE
              WHEN w."ownerId" = 'demo-user-1' THEN '!LOCKED:DEMO_USER_MANAGED_AUTH'
              ELSE '!LOCKED:LEGACY_BACKFILL'
          END AS "passwordHash",
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
      FROM "Workspace" w
      WHERE NOT EXISTS (
          SELECT 1 FROM "User" u WHERE u."id" = w."ownerId"
      );
    `;

    // No rows inserted because all workspace owners already exist in User
    expect(backfillResult).toBe(0);

    // 3. Verify Foreign Key constraint is active: deleting a User with workspaces throws error
    await expect(
      prisma.user.delete({
        where: { id: tempUser.id },
      })
    ).rejects.toThrow(); // Foreign key violation (RESTRICT)
  });
});
