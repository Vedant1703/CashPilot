/**
 * CashPilot AI — Test Authentication Helpers
 *
 * Provides standardized session-based authentication helpers for integration tests.
 * Uses real `cashpilot_session` cookies and verified session contexts.
 * Never relies on client-controlled actor headers or demo fallbacks.
 */

import { NextRequest } from "next/server";
import { registerTestSession, clearTestSessions, SESSION_COOKIE_NAME, SessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db/client";

export { clearTestSessions };

export const PERMITTED_TEST_DATABASE = "cashpilot_disposable_test";

/**
 * Resolves the explicitly configured test database name from environment variables.
 * Fails closed immediately if the URL is missing, malformed, non-PostgreSQL scheme,
 * or specifies any database other than `cashpilot_disposable_test`.
 * Never exposes raw URL strings in error messages to protect credentials.
 */
export function getExplicitTestDatabaseName(): string {
  const rawUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      "SAFETY VIOLATION: No test database URL configured in environment."
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("SAFETY VIOLATION: Malformed database URL configured in test environment.");
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("SAFETY VIOLATION: Test database URL must use 'postgresql:' or 'postgres:' scheme.");
  }

  const dbName = parsed.pathname.replace(/^\//, "").split("?")[0];
  if (!dbName) {
    throw new Error("SAFETY VIOLATION: Configured test database URL does not specify a database name.");
  }

  if (dbName !== PERMITTED_TEST_DATABASE) {
    throw new Error(
      `SAFETY VIOLATION: Database-writing tests must target "${PERMITTED_TEST_DATABASE}", but configured database is "${dbName}".`
    );
  }

  return dbName;
}

/**
 * Asserts that the test runner is connected to the only permitted test database (cashpilot_disposable_test).
 * Fails closed immediately before any writes if:
 * 1. The configured database is not cashpilot_disposable_test.
 * 2. SELECT current_database() does not equal cashpilot_disposable_test.
 */
export async function assertAllowedTestDatabase(): Promise<string> {
  const result = await db.$queryRaw<Array<{ current_database: string }>>`SELECT current_database();`;
  const currentDb = result[0]?.current_database;
  const configuredDb = getExplicitTestDatabaseName();

  if (!currentDb) {
    throw new Error("SAFETY VIOLATION: Could not determine current database name from PostgreSQL.");
  }

  if (currentDb !== PERMITTED_TEST_DATABASE) {
    throw new Error(
      `SAFETY VIOLATION: Connected to database "${currentDb}". Database-writing tests must run exclusively on "${PERMITTED_TEST_DATABASE}".`
    );
  }

  if (currentDb !== configuredDb) {
    throw new Error(
      `SAFETY VIOLATION: Test database mismatch. Connected to "${currentDb}", but configured test database is "${configuredDb}".`
    );
  }

  return currentDb;
}

export const TEST_RUN_TOKEN = `run_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
export const FIXTURE_PASSWORD_PREFIX = "!LOCKED:TEST_FIXTURE_USER:";
export const CURRENT_RUN_FIXTURE_HASH = `${FIXTURE_PASSWORD_PREFIX}${TEST_RUN_TOKEN}`;

const trackedFixtureUserIds = new Set<string>();

/**
 * Returns a copy of currently tracked fixture user IDs created by `ensureTestUsers` in this test run.
 */
export function getTrackedFixtureUserIds(): string[] {
  return Array.from(trackedFixtureUserIds);
}

/**
 * Ensures that synthetic test owners exist in the User table before creating workspaces,
 * satisfying the Workspace_ownerId_fkey foreign key constraint.
 *
 * Safety guards:
 * - Checks whether the user already exists in the database.
 * - If not, creates the fixture user tagged with the current test run token.
 * - Handles concurrent creation races gracefully without duplicate key failures.
 * - Only records newly created test users in `trackedFixtureUserIds` so that `cleanupTestUsers`
 *   will NEVER delete a pre-existing user (such as demo-user-1 or existing development records)
 *   or fixtures created by other test processes.
 */
export async function ensureTestUsers(
  users: Array<{ id: string; email?: string; name?: string }> | string[] | string
): Promise<void> {
  await assertAllowedTestDatabase();
  const list = typeof users === "string"
    ? [{ id: users }]
    : Array.isArray(users)
    ? users.map((u) => (typeof u === "string" ? { id: u } : u))
    : [users];

  for (const u of list) {
    const targetEmail = u.email ?? `${u.id}@test.internal`;
    const targetName = u.name ?? `Test User ${u.id}`;

    const existingById = await db.user.findUnique({
      where: { id: u.id },
      select: { id: true, email: true, passwordHash: true },
    });

    if (existingById) {
      // (a) Email consistency: if caller specified an email, it must match the existing record
      if (u.email && existingById.email !== u.email) {
        throw new Error(
          `SAFETY VIOLATION: Existing user "${u.id}" has email "${existingById.email}", which conflicts with requested "${u.email}".`
        );
      }

      // (b) If this user was created by the current test run, track it.
      if (existingById.passwordHash === CURRENT_RUN_FIXTURE_HASH) {
        trackedFixtureUserIds.add(u.id);
        continue;
      }

      // (c) The user was NOT created by this run. Do NOT track or delete that user.
      // Integrity check: Existing non-demo users must be locked test fixtures
      const isCanonicalDemoUser = u.id === "demo-user-1" || u.id === "demo-user-2";
      const isLockedFixture = existingById.passwordHash.startsWith(FIXTURE_PASSWORD_PREFIX);

      if (!isCanonicalDemoUser && !isLockedFixture) {
        throw new Error(
          `SAFETY VIOLATION: Cannot reuse user ID "${u.id}" as test fixture: existing user is not a locked test fixture or canonical demo user.`
        );
      }

      // Safe to reuse as existing foreign-key target without tracking or deleting
      continue;
    }

    // Verify target email is not already taken by a different user before attempting create
    const existingByEmail = await db.user.findUnique({
      where: { email: targetEmail },
      select: { id: true },
    });
    if (existingByEmail && existingByEmail.id !== u.id) {
      throw new Error(
        `SAFETY VIOLATION: Cannot create test user "${u.id}": email "${targetEmail}" is already used by user "${existingByEmail.id}".`
      );
    }

    try {
      await db.user.create({
        data: {
          id: u.id,
          email: targetEmail,
          name: targetName,
          passwordHash: CURRENT_RUN_FIXTURE_HASH,
        },
      });
      trackedFixtureUserIds.add(u.id);
    } catch (err: unknown) {
      // Handle concurrent creation race (P2002)
      if ((err as { code?: string })?.code === "P2002") {
        // Distinguish ID conflict from email conflict
        const racedById = await db.user.findUnique({
          where: { id: u.id },
          select: { id: true, email: true, passwordHash: true },
        });

        if (racedById) {
          // ID conflict: user exists. If created by current run, track it.
          if (racedById.passwordHash === CURRENT_RUN_FIXTURE_HASH) {
            trackedFixtureUserIds.add(u.id);
            continue;
          }

          // User exists with different passwordHash (pre-existing or other run).
          // Verify fixture assumptions:
          if (u.email && racedById.email !== u.email) {
            throw new Error(
              `SAFETY VIOLATION: User "${u.id}" exists with mismatched email "${racedById.email}" (expected "${u.email}").`
            );
          }

          const isCanonicalDemoUser = u.id === "demo-user-1" || u.id === "demo-user-2";
          const isLockedFixture = racedById.passwordHash.startsWith(FIXTURE_PASSWORD_PREFIX);

          if (!isCanonicalDemoUser && !isLockedFixture) {
            throw new Error(
              `SAFETY VIOLATION: Concurrently existing user "${u.id}" is not a locked test fixture or canonical demo user.`
            );
          }

          // Do not track or delete other-run user; fixture assumptions verified
          continue;
        }

        // If racedById is null, P2002 was caused by an email conflict!
        const racedByEmail = await db.user.findUnique({
          where: { email: targetEmail },
          select: { id: true },
        });
        throw new Error(
          `SAFETY VIOLATION: Cannot create fixture user "${u.id}" due to email conflict: "${targetEmail}" is claimed by user "${racedByEmail?.id ?? "unknown"}".`
        );
      }

      throw err;
    }
  }
}

/**
 * Cleans up synthetic test users created by ensureTestUsers in foreign-key-safe order.
 * Must be executed after workspaces and dependent entities have been deleted.
 *
 * Safety guards:
 * 1. Verifies database identity immediately. If verification fails, aborts with an error
 *    without performing any write operations.
 * 2. Only deletes users that were tracked as newly created by this test process/run.
 * 3. Enforces matching `passwordHash: CURRENT_RUN_FIXTURE_HASH` to guarantee that pre-existing
 *    users or fixtures from other test runs are never deleted.
 */
export async function cleanupTestUsers(userIds?: string[] | string): Promise<void> {
  // 1. Verify database identity immediately before any cleanup action.
  // Aborts unconditionally without writes if not connected to cashpilot_disposable_test.
  await assertAllowedTestDatabase();

  const requestedIds = userIds
    ? (Array.isArray(userIds) ? userIds : [userIds])
    : Array.from(trackedFixtureUserIds);

  if (requestedIds.length === 0) return;

  // 2. Filter to only IDs tracked as created by ensureTestUsers in this run
  const idsToDelete = requestedIds.filter((id) => trackedFixtureUserIds.has(id));
  if (idsToDelete.length === 0) return;

  // 3. Delete only rows matching both the tracked IDs and this run's fixture hash
  await db.user.deleteMany({
    where: {
      id: { in: idsToDelete },
      passwordHash: CURRENT_RUN_FIXTURE_HASH,
    },
  });

  for (const id of idsToDelete) {
    trackedFixtureUserIds.delete(id);
  }
}

export interface TestSessionOptions {
  actorId?: string;
  userId?: string;
  workspaceId?: string;
  email?: string;
  name?: string;
  expiresInSeconds?: number;
  isDemo?: boolean;
}

export interface CreatedTestSession {
  token: string;
  sessionToken: string;
  cookieHeader: string;
  sessionContext: SessionContext;
}

/**
 * Creates and registers a valid verified session in the test session registry.
 */
export function createTestSession(options?: TestSessionOptions): CreatedTestSession {
  const actorId = options?.userId ?? options?.actorId ?? "demo-user-1";
  const workspaceId = options?.workspaceId ?? "demo-workspace-1";
  const email = options?.email ?? `${actorId}@example.com`;
  const name = options?.name ?? `User ${actorId}`;
  const expiresInSeconds = options?.expiresInSeconds ?? 86400;
  const isDemo = options?.isDemo ?? true;

  const token = `test-sess-token-${actorId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  const sessionContext: SessionContext = {
    sessionId: `sess-${actorId}-${Date.now()}`,
    expiresAt,
    user: {
      id: actorId,
      email,
      name,
      createdAt: new Date(),
    },
    workspace: {
      id: workspaceId,
      name: `${name}'s Workspace`,
      isDemo,
    },
  };

  registerTestSession(token, sessionContext);

  return {
    token,
    sessionToken: token,
    cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
    sessionContext,
  };
}

/**
 * Creates a NextRequest with a valid session cookie for the given actor and workspace.
 */
export function createAuthenticatedRequest(
  url: string,
  options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    actorId?: string;
    workspaceId?: string;
    token?: string;
  }
): NextRequest {
  const method = options?.method ?? "GET";
  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  let token = options?.token;
  if (!token) {
    const session = createTestSession({
      actorId: options?.actorId,
      workspaceId: options?.workspaceId,
    });
    token = session.token;
  }

  headers.set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);

  if (options?.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headers.set(k, v);
    }
  }

  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
}
