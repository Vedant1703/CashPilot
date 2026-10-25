/**
 * CashPilot AI — Test Authentication Helpers
 *
 * Provides standardized session-based authentication helpers for integration tests.
 * Uses real `cashpilot_session` cookies and verified session contexts.
 * Never relies on client-controlled actor headers or demo fallbacks.
 */

import { NextRequest } from "next/server";
import { registerTestSession, clearTestSessions, SESSION_COOKIE_NAME, SessionContext } from "@/lib/auth/session";

export { clearTestSessions };

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
