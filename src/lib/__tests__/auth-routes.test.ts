import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { hashPassword } from "@/lib/auth/password";
import { SESSION_COOKIE_NAME, hashSessionToken } from "@/lib/auth/session";
import { resetRateLimiter } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db/client";

function createJsonRequest(url: string, method: string, body?: unknown, cookies?: Record<string, string>): NextRequest {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  if (cookies) {
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    headers.set("Cookie", cookieHeader);
  }

  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Authentication API Routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRateLimiter();
  });

  describe("POST /api/auth/signup", () => {
    it("successfully creates a new user, isolated non-demo workspace, and session cookie", async () => {
      vi.spyOn(db.user, "findUnique").mockResolvedValue(null);

      const fakeUser = {
        id: "usr-new-1",
        email: "charlie@example.com",
        name: "Charlie Davis",
        createdAt: new Date(),
      };

      const fakeWorkspace = {
        id: "ws-charlie-1",
        name: "Charlie's Consulting",
        isDemo: false,
      };

      const fakeSession = {
        id: "sess-charlie-1",
        expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
      };

      vi.spyOn(db, "$transaction").mockImplementation(async (callback) => {
        if (typeof callback === "function") {
          return (callback as (tx: unknown) => Promise<unknown>)({
            user: {
              create: vi.fn().mockResolvedValue(fakeUser),
            },
            workspace: {
              create: vi.fn().mockResolvedValue(fakeWorkspace),
            },
            session: {
              create: vi.fn().mockResolvedValue(fakeSession),
            },
          });
        }
        return [];
      });

      const req = createJsonRequest("http://localhost:3000/api/auth/signup", "POST", {
        name: "Charlie Davis",
        email: "charlie@example.com",
        password: "ValidPassword123!",
        businessName: "Charlie's Consulting",
      });

      const res = await signupRoute(req);
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.user.id).toBe("usr-new-1");
      expect(json.data.user.email).toBe("charlie@example.com");
      expect(json.data.workspace.id).toBe("ws-charlie-1");
      expect(json.data.workspace.isDemo).toBe(false);

      // Verify Set-Cookie header contains session cookie
      const setCookie = res.headers.get("set-cookie") || "";
      expect(setCookie).toContain(SESSION_COOKIE_NAME);
      expect(setCookie.toLowerCase()).toContain("httponly");
      expect(setCookie.toLowerCase()).toContain("samesite=lax");
    });

    it("rejects duplicate email with 409 Conflict", async () => {
      vi.spyOn(db.user, "findUnique").mockResolvedValue({ id: "existing-id" } as unknown as Awaited<
        ReturnType<typeof db.user.findUnique>
      >);

      const req = createJsonRequest("http://localhost:3000/api/auth/signup", "POST", {
        name: "Duplicate User",
        email: "already@exists.com",
        password: "ValidPassword123!",
      });

      const res = await signupRoute(req);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.code).toBe("EMAIL_EXISTS");
    });

    it("rejects reserved synthetic internal email domains", async () => {
      const invalidEmails = [
        "hacker@legacy.cashpilot.internal",
        "test@example.test",
        "admin@system.local",
        "legacy+user@example.com",
      ];

      for (const email of invalidEmails) {
        const req = createJsonRequest("http://localhost:3000/api/auth/signup", "POST", {
          name: "Invalid Domain User",
          email,
          password: "ValidPassword123!",
        });

        const res = await signupRoute(req);
        const json = await res.json();

        expect(res.status).toBe(400);
        expect(json.success).toBe(false);
        expect(json.error).toMatch(/reserved/i);
      }
    });

    it("rejects short or invalid passwords", async () => {
      const req = createJsonRequest("http://localhost:3000/api/auth/signup", "POST", {
        name: "Short Password User",
        email: "short@example.com",
        password: "short", // less than 8 chars
      });

      const res = await signupRoute(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.code).toBe("VALIDATION_ERROR");
      expect(json.error).toMatch(/8 characters/i);
    });

    it("rejects malformed JSON", async () => {
      const req = new NextRequest(new URL("http://localhost:3000/api/auth/signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid-json{",
      });

      const res = await signupRoute(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe("INVALID_JSON");
    });
  });

  describe("POST /api/auth/login", () => {
    it("successfully verifies credentials and issues a session cookie", async () => {
      const password = "MySecretPassword123!";
      const passwordHash = await hashPassword(password);

      vi.spyOn(db.user, "findUnique").mockResolvedValue({
        id: "usr-login-1",
        email: "dan@example.com",
        name: "Dan Developer",
        passwordHash,
        createdAt: new Date(),
        workspaces: [
          {
            id: "ws-dan-1",
            name: "Dan's Studio",
            isDemo: false,
          },
        ],
      } as unknown as Awaited<ReturnType<typeof db.user.findUnique>>);

      vi.spyOn(db.session, "create").mockResolvedValue({
        id: "sess-dan-1",
        userId: "usr-login-1",
        tokenHash: "fake-hash",
        expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
        createdAt: new Date(),
      });

      const req = createJsonRequest("http://localhost:3000/api/auth/login", "POST", {
        email: "dan@example.com",
        password,
      });

      const res = await loginRoute(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.user.email).toBe("dan@example.com");
      expect(json.data.workspace.id).toBe("ws-dan-1");

      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain(SESSION_COOKIE_NAME);
    });

    it("rejects incorrect password with generic 401 INVALID_CREDENTIALS", async () => {
      const passwordHash = await hashPassword("RealPassword123!");

      vi.spyOn(db.user, "findUnique").mockResolvedValue({
        id: "usr-login-1",
        email: "dan@example.com",
        name: "Dan Developer",
        passwordHash,
        workspaces: [],
      } as unknown as Awaited<ReturnType<typeof db.user.findUnique>>);

      const req = createJsonRequest("http://localhost:3000/api/auth/login", "POST", {
        email: "dan@example.com",
        password: "WrongPassword999!",
      });

      const res = await loginRoute(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.success).toBe(false);
      expect(json.code).toBe("INVALID_CREDENTIALS");
      expect(json.error).toBe("Invalid email or password.");
    });

    it("rejects non-existent email with generic 401 INVALID_CREDENTIALS", async () => {
      vi.spyOn(db.user, "findUnique").mockResolvedValue(null);

      const req = createJsonRequest("http://localhost:3000/api/auth/login", "POST", {
        email: "nonexistent@example.com",
        password: "AnyPassword123!",
      });

      const res = await loginRoute(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.code).toBe("INVALID_CREDENTIALS");
      expect(json.error).toBe("Invalid email or password.");
    });

    it("strictly rejects locked legacy and demo accounts with 401", async () => {
      const lockedUsers = [
        { email: "demo@cashpilot.test", passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH" },
        { email: "legacy+owner@legacy.cashpilot.internal", passwordHash: "!LOCKED:LEGACY_BACKFILL" },
        { email: "old@example.com", passwordHash: "!UNUSABLE_PASSWORD_BACKFILL" },
      ];

      for (const lockedUser of lockedUsers) {
        vi.spyOn(db.user, "findUnique").mockResolvedValue({
          id: "locked-id",
          email: lockedUser.email,
          name: "Locked User",
          passwordHash: lockedUser.passwordHash,
          workspaces: [],
        } as unknown as Awaited<ReturnType<typeof db.user.findUnique>>);

        const req = createJsonRequest("http://localhost:3000/api/auth/login", "POST", {
          email: lockedUser.email,
          password: "Password123!",
        });

        const res = await loginRoute(req);
        const json = await res.json();

        expect(res.status).toBe(401);
        expect(json.code).toBe("INVALID_CREDENTIALS");
      }
    });
  });

  describe("POST /api/auth/logout", () => {
    it("revokes the database session and clears the session cookie", async () => {
      const token = "active-test-session-token-123456789";
      const deleteManySpy = vi.spyOn(db.session, "deleteMany").mockResolvedValue({ count: 1 });

      const req = createJsonRequest("http://localhost:3000/api/auth/logout", "POST", undefined, {
        [SESSION_COOKIE_NAME]: token,
      });

      const res = await logoutRoute(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(deleteManySpy).toHaveBeenCalledWith({
        where: { tokenHash: hashSessionToken(token) },
      });

      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
      expect(setCookie).toContain("Max-Age=0");
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns authenticated user safe profile and workspace without leaking secrets", async () => {
      const token = "valid-session-token-abc";
      const tokenHash = hashSessionToken(token);

      vi.spyOn(db.session, "findUnique").mockResolvedValue({
        id: "sess-me-1",
        userId: "usr-me-1",
        tokenHash,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        user: {
          id: "usr-me-1",
          email: "emma@example.com",
          name: "Emma Stone",
          passwordHash: "$scrypt$v=1$hidden",
          createdAt: new Date(),
          workspaces: [
            {
              id: "ws-emma-1",
              name: "Emma Design",
              isDemo: false,
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof db.session.findUnique>>);

      const req = createJsonRequest("http://localhost:3000/api/auth/me", "GET", undefined, {
        [SESSION_COOKIE_NAME]: token,
      });

      const res = await meRoute(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.user.id).toBe("usr-me-1");
      expect(json.data.user.email).toBe("emma@example.com");
      expect(json.data.user.name).toBe("Emma Stone");
      expect(json.data.user.passwordHash).toBeUndefined(); // NEVER leaked
      expect(json.data.workspace.id).toBe("ws-emma-1");
      expect(json.data.workspace.isDemo).toBe(false);
    });

    it("rejects unauthenticated requests with 401 UNAUTHORIZED", async () => {
      const req = createJsonRequest("http://localhost:3000/api/auth/me", "GET");

      const res = await meRoute(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.success).toBe(false);
      expect(json.code).toBe("UNAUTHORIZED");
    });
  });
});
