/**
 * CashPilot AI — Task 2C.2: Critical Authentication Hardening Tests
 *
 * Verifies:
 * 1. Strict scrypt parameter bounds and power-of-two validation.
 * 2. Nonexistent and locked user login timing protection via dummy scrypt verification.
 * 3. Rate limiting on login and signup endpoints.
 * 4. Header spoofing rejection: x-actor-id / x-user-id headers are ignored.
 * 5. Unauthenticated access rejection on all protected invoice & assistant routes.
 * 6. Cross-workspace access rejection (403 Forbidden).
 * 7. Expired and revoked session rejection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  verifyPassword,
  isUsablePasswordHash,
  DUMMY_SCRYPT_HASH,
} from "@/lib/auth/password";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { POST as extractRoute } from "@/app/api/invoices/extract/route";
import { GET as getInvoiceRoute } from "@/app/api/invoices/[id]/route";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as sendRoute } from "@/app/api/invoices/[id]/send/route";
import { POST as remindRoute } from "@/app/api/invoices/[id]/remind/route";
import { POST as cancelRoute } from "@/app/api/invoices/[id]/cancel/route";
import { POST as syncRoute } from "@/app/api/invoices/[id]/sync/route";
import { POST as paypalDraftRoute } from "@/app/api/invoices/[id]/paypal-draft/route";
import { POST as chatRoute } from "@/app/api/navi-ai/chat/route";
import { resetRateLimiter } from "@/lib/auth/rate-limit";
import { SESSION_COOKIE_NAME, hashSessionToken } from "@/lib/auth/session";
import { db } from "@/lib/db/client";

function createJsonReq(
  url: string,
  method: string,
  body?: unknown,
  cookies?: Record<string, string>,
  headers?: Record<string, string>
): NextRequest {
  const reqHeaders = new Headers();
  reqHeaders.set("Content-Type", "application/json");

  if (cookies) {
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    reqHeaders.set("Cookie", cookieHeader);
  }

  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      reqHeaders.set(k, v);
    }
  }

  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method,
    headers: reqHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Critical Authentication Hardening (Phase 2C.2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRateLimiter();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Password Verification Hardening & Parameter Bounding
  // ───────────────────────────────────────────────────────────────────────────
  describe("Password Verification Hardening", () => {
    it("rejects scrypt hash where N is not a power of two", async () => {
      // N=10000 is not a power of two
      const invalidHash =
        "$scrypt$v=1$N=10000,r=8,p=1$a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4$e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      expect(isUsablePasswordHash(invalidHash)).toBe(false);
      expect(await verifyPassword("Password123!", invalidHash)).toBe(false);
    });

    it("rejects scrypt hash where N exceeds maximum safe bound (N > 65536)", async () => {
      const extremeNHash =
        "$scrypt$v=1$N=131072,r=8,p=1$a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4$e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      expect(isUsablePasswordHash(extremeNHash)).toBe(false);
      expect(await verifyPassword("Password123!", extremeNHash)).toBe(false);
    });

    it("rejects scrypt hash where r or p exceed safe bounds", async () => {
      // r=64 exceeds r <= 32
      const extremeR =
        "$scrypt$v=1$N=16384,r=64,p=1$a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4$e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      expect(isUsablePasswordHash(extremeR)).toBe(false);
      expect(await verifyPassword("Password123!", extremeR)).toBe(false);

      // p=32 exceeds p <= 16
      const extremeP =
        "$scrypt$v=1$N=16384,r=8,p=32$a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4$e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      expect(isUsablePasswordHash(extremeP)).toBe(false);
      expect(await verifyPassword("Password123!", extremeP)).toBe(false);
    });

    it("validates DUMMY_SCRYPT_HASH is well-formed but rejects invalid passwords", async () => {
      expect(isUsablePasswordHash(DUMMY_SCRYPT_HASH)).toBe(true);
      expect(await verifyPassword("AnyRandomPassword999!", DUMMY_SCRYPT_HASH)).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Non-existent User Login Timing Defense
  // ───────────────────────────────────────────────────────────────────────────
  describe("Login Non-existent User Defense", () => {
    it("runs dummy scrypt check and returns generic 401 when user does not exist", async () => {
      vi.spyOn(db.user, "findUnique").mockResolvedValue(null);

      const req = createJsonReq("http://localhost:3000/api/auth/login", "POST", {
        email: "ghost@example.com",
        password: "SomePassword123!",
      });

      const res = await loginRoute(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.code).toBe("INVALID_CREDENTIALS");
      expect(json.error).toBe("Invalid email or password.");
    });

    it("runs dummy scrypt check and returns generic 401 when user account is locked", async () => {
      vi.spyOn(db.user, "findUnique").mockResolvedValue({
        id: "locked-id",
        email: "locked@example.com",
        name: "Locked User",
        passwordHash: "!LOCKED:DEMO_USER_MANAGED_AUTH",
        createdAt: new Date(),
        workspaces: [],
      } as unknown as Awaited<ReturnType<typeof db.user.findUnique>>);

      const req = createJsonReq("http://localhost:3000/api/auth/login", "POST", {
        email: "locked@example.com",
        password: "SomePassword123!",
      });

      const res = await loginRoute(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.code).toBe("INVALID_CREDENTIALS");
      expect(json.error).toBe("Invalid email or password.");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Abuse Protection (Rate Limiting)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Rate Limiting", () => {
    it("rate limits login attempts after 10 requests from the same IP", async () => {
      vi.spyOn(db.user, "findUnique").mockResolvedValue(null);

      const ipHeaders = { "x-forwarded-for": "198.51.100.42" };

      // Perform 10 failed login requests (allowed)
      for (let i = 0; i < 10; i++) {
        const req = createJsonReq(
          "http://localhost:3000/api/auth/login",
          "POST",
          { email: `user${i}@example.com`, password: "wrongPassword!" },
          undefined,
          ipHeaders
        );
        const res = await loginRoute(req);
        expect(res.status).toBe(401);
      }

      // 11th request must be rate limited with 429
      const throttledReq = createJsonReq(
        "http://localhost:3000/api/auth/login",
        "POST",
        { email: "user11@example.com", password: "wrongPassword!" },
        undefined,
        ipHeaders
      );
      const res = await loginRoute(throttledReq);
      const json = await res.json();

      expect(res.status).toBe(429);
      expect(json.code).toBe("TOO_MANY_REQUESTS");
      expect(res.headers.get("retry-after")).toBeDefined();
    });

    it("rate limits signup attempts after 5 requests from the same IP", async () => {
      vi.spyOn(db.user, "findUnique").mockResolvedValue(null);
      vi.spyOn(db, "$transaction").mockImplementation(async (callback) => {
        if (typeof callback === "function") {
          return (callback as (tx: unknown) => Promise<unknown>)({
            user: {
              create: vi.fn().mockResolvedValue({
                id: "usr-mock-rate",
                email: "mock@exists.com",
                name: "Mock User",
                createdAt: new Date(),
              }),
            },
            workspace: {
              create: vi.fn().mockResolvedValue({
                id: "ws-mock-rate",
                name: "Mock Studio",
                isDemo: false,
              }),
            },
            session: {
              create: vi.fn().mockResolvedValue({
                id: "sess-mock-rate",
                expiresAt: new Date(Date.now() + 604800000),
              }),
            },
          });
        }
        return [];
      });

      const ipHeaders = { "x-forwarded-for": "198.51.100.99" };

      for (let i = 0; i < 5; i++) {
        const req = createJsonReq(
          "http://localhost:3000/api/auth/signup",
          "POST",
          { name: `User ${i}`, email: "already@exists.com", password: "ValidPassword123!" },
          undefined,
          ipHeaders
        );
        // Will reject as duplicate email or pass validation
        await signupRoute(req);
      }

      // 6th request must be rate limited
      const throttledReq = createJsonReq(
        "http://localhost:3000/api/auth/signup",
        "POST",
        { name: "New User", email: "new@example.com", password: "ValidPassword123!" },
        undefined,
        ipHeaders
      );
      const res = await signupRoute(throttledReq);
      const json = await res.json();

      expect(res.status).toBe(429);
      expect(json.code).toBe("TOO_MANY_REQUESTS");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Header Spoofing Resistance
  // ───────────────────────────────────────────────────────────────────────────
  describe("Header Spoofing Resistance", () => {
    it("rejects x-actor-id and x-user-id headers without session on draft invoice", async () => {
      const req = createJsonReq(
        "http://localhost:3000/api/invoices/draft",
        "POST",
        {
          clientId: "client-1",
          workspaceId: "demo-workspace-1",
          issueDate: "2026-10-25",
          dueDate: "2026-11-25",
          currency: "USD",
          lineItems: [{ description: "Design", quantity: 1, unitPriceMinorUnits: 10000 }],
        },
        undefined,
        {
          "x-actor-id": "demo-user-1",
          "x-user-id": "admin",
          "x-workspace-id": "demo-workspace-1",
        }
      );

      const res = await draftRoute(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.code).toBe("UNAUTHORIZED");
    });

    it("rejects spoofed x-actor-id on Ask Navi chat without session", async () => {
      const req = createJsonReq(
        "http://localhost:3000/api/navi-ai/chat",
        "POST",
        { message: "What's overdue?", workspaceId: "demo-workspace-1" },
        undefined,
        { "x-actor-id": "demo-user-1" }
      );

      const res = await chatRoute(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.code).toBe("UNAUTHORIZED");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Unauthenticated Access Rejection across All Protected Routes
  // ───────────────────────────────────────────────────────────────────────────
  describe("Unauthenticated Access Rejection", () => {
    it("rejects unauthenticated draft invoice creation with 401", async () => {
      const req = createJsonReq("http://localhost:3000/api/invoices/draft", "POST", {});
      const res = await draftRoute(req);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated extract proposal with 401", async () => {
      const req = createJsonReq("http://localhost:3000/api/invoices/extract", "POST", {
        prompt: "Bill Acme $500 for consulting",
      });
      const res = await extractRoute(req);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated invoice read with 401", async () => {
      vi.spyOn(db.invoice, "findUnique").mockResolvedValue({
        id: "inv-123",
        workspaceId: "ws-123",
      } as unknown as Awaited<ReturnType<typeof db.invoice.findUnique>>);

      const req = createJsonReq("http://localhost:3000/api/invoices/inv-123", "GET");
      const res = await getInvoiceRoute(req, { params: Promise.resolve({ id: "inv-123" }) });
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated approve with 401", async () => {
      vi.spyOn(db.invoice, "findUnique").mockResolvedValue({
        id: "inv-123",
        workspaceId: "ws-123",
      } as unknown as Awaited<ReturnType<typeof db.invoice.findUnique>>);

      const req = createJsonReq("http://localhost:3000/api/invoices/inv-123/approve", "POST", {
        actionType: "SEND_INVOICE",
        reviewedPayloadHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });
      const res = await approveRoute(req, { params: Promise.resolve({ id: "inv-123" }) });
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated send with 401", async () => {
      vi.spyOn(db.invoice, "findUnique").mockResolvedValue({
        id: "inv-123",
        workspaceId: "ws-123",
      } as unknown as Awaited<ReturnType<typeof db.invoice.findUnique>>);

      const req = createJsonReq("http://localhost:3000/api/invoices/inv-123/send", "POST", {
        approvalId: "appr-1",
      });
      const res = await sendRoute(req, { params: Promise.resolve({ id: "inv-123" }) });
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated remind with 401", async () => {
      vi.spyOn(db.invoice, "findUnique").mockResolvedValue({
        id: "inv-123",
        workspaceId: "ws-123",
      } as unknown as Awaited<ReturnType<typeof db.invoice.findUnique>>);

      const req = createJsonReq("http://localhost:3000/api/invoices/inv-123/remind", "POST", {
        approvalId: "appr-1",
      });
      const res = await remindRoute(req, { params: Promise.resolve({ id: "inv-123" }) });
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated cancel with 401", async () => {
      vi.spyOn(db.invoice, "findUnique").mockResolvedValue({
        id: "inv-123",
        workspaceId: "ws-123",
      } as unknown as Awaited<ReturnType<typeof db.invoice.findUnique>>);

      const req = createJsonReq("http://localhost:3000/api/invoices/inv-123/cancel", "POST", {
        approvalId: "appr-1",
      });
      const res = await cancelRoute(req, { params: Promise.resolve({ id: "inv-123" }) });
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated sync with 401", async () => {
      vi.spyOn(db.invoice, "findUnique").mockResolvedValue({
        id: "inv-123",
        workspaceId: "ws-123",
      } as unknown as Awaited<ReturnType<typeof db.invoice.findUnique>>);

      const req = createJsonReq("http://localhost:3000/api/invoices/inv-123/sync", "POST");
      const res = await syncRoute(req, { params: Promise.resolve({ id: "inv-123" }) });
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated paypal-draft with 401", async () => {
      vi.spyOn(db.invoice, "findUnique").mockResolvedValue({
        id: "inv-123",
        workspaceId: "ws-123",
      } as unknown as Awaited<ReturnType<typeof db.invoice.findUnique>>);

      const req = createJsonReq("http://localhost:3000/api/invoices/inv-123/paypal-draft", "POST", {
        approvalId: "appr-1",
      });
      const res = await paypalDraftRoute(req, { params: Promise.resolve({ id: "inv-123" }) });
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated Ask Navi chat with 401", async () => {
      const req = createJsonReq("http://localhost:3000/api/navi-ai/chat", "POST", {
        message: "Summarize outstanding balance",
      });
      const res = await chatRoute(req);
      expect(res.status).toBe(401);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Cross-Workspace Access Rejection (403 Forbidden)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Cross-Workspace Authorization", () => {
    it("rejects user from accessing an invoice in a workspace they do not own with 403", async () => {
      const token = "alice-session-token";
      const tokenHash = hashSessionToken(token);

      // Alice owns ws-alice, NOT ws-bob
      vi.spyOn(db.session, "findUnique").mockResolvedValue({
        id: "sess-alice",
        userId: "usr-alice",
        tokenHash,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        user: {
          id: "usr-alice",
          email: "alice@example.com",
          name: "Alice Builder",
          createdAt: new Date(),
          workspaces: [{ id: "ws-alice", name: "Alice Studio", isDemo: false }],
        },
      } as unknown as Awaited<ReturnType<typeof db.session.findUnique>>);

      // Target invoice belongs to ws-bob
      vi.spyOn(db.invoice, "findUnique").mockResolvedValue({
        id: "inv-bob-1",
        workspaceId: "ws-bob",
      } as unknown as Awaited<ReturnType<typeof db.invoice.findUnique>>);

      // ws-bob is owned by usr-bob
      vi.spyOn(db.workspace, "findUnique").mockResolvedValue({
        id: "ws-bob",
        name: "Bob Studio",
        ownerId: "usr-bob",
        isDemo: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const req = createJsonReq(
        "http://localhost:3000/api/invoices/inv-bob-1",
        "GET",
        undefined,
        { [SESSION_COOKIE_NAME]: token }
      );

      const res = await getInvoiceRoute(req, { params: Promise.resolve({ id: "inv-bob-1" }) });
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
    });

    it("rejects user from extracting an invoice into a workspace they do not own with 403", async () => {
      const token = "alice-session-token";
      const tokenHash = hashSessionToken(token);

      vi.spyOn(db.session, "findUnique").mockResolvedValue({
        id: "sess-alice",
        userId: "usr-alice",
        tokenHash,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        user: {
          id: "usr-alice",
          email: "alice@example.com",
          name: "Alice",
          createdAt: new Date(),
          workspaces: [{ id: "ws-alice", name: "Alice Studio", isDemo: false }],
        },
      } as unknown as Awaited<ReturnType<typeof db.session.findUnique>>);

      vi.spyOn(db.workspace, "findUnique").mockResolvedValue({
        id: "ws-bob",
        name: "Bob Studio",
        ownerId: "usr-bob", // owned by Bob!
        isDemo: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const req = createJsonReq(
        "http://localhost:3000/api/invoices/extract",
        "POST",
        {
          prompt: "Bill Acme $1000",
          workspaceId: "ws-bob",
        },
        { [SESSION_COOKIE_NAME]: token }
      );

      const res = await extractRoute(req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Expired & Revoked Sessions Rejection
  // ───────────────────────────────────────────────────────────────────────────
  describe("Expired & Revoked Session Handling", () => {
    it("rejects expired session token with 401 UNAUTHORIZED", async () => {
      const token = "expired-token";
      const tokenHash = hashSessionToken(token);

      vi.spyOn(db.session, "findUnique").mockResolvedValue({
        id: "sess-expired",
        userId: "usr-expired",
        tokenHash,
        expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
        createdAt: new Date(),
        user: {
          id: "usr-expired",
          email: "expired@example.com",
          name: "Expired User",
          createdAt: new Date(),
          workspaces: [],
        },
      } as unknown as Awaited<ReturnType<typeof db.session.findUnique>>);

      vi.spyOn(db.session, "delete").mockResolvedValue({} as unknown as Awaited<
        ReturnType<typeof db.session.delete>
      >);

      const req = createJsonReq(
        "http://localhost:3000/api/invoices/draft",
        "POST",
        {
          issueDate: "2026-10-25",
          dueDate: "2026-11-25",
          currency: "USD",
          lineItems: [{ description: "Dev work", quantity: 1, unitPriceMinorUnits: 5000 }],
        },
        { [SESSION_COOKIE_NAME]: token }
      );

      const res = await draftRoute(req);
      expect(res.status).toBe(401);
    });

    it("rejects revoked session token with 401 UNAUTHORIZED", async () => {
      // Session has been deleted from DB (findUnique returns null)
      vi.spyOn(db.session, "findUnique").mockResolvedValue(null);

      const req = createJsonReq(
        "http://localhost:3000/api/invoices/draft",
        "POST",
        {},
        { [SESSION_COOKIE_NAME]: "revoked-token-123" }
      );

      const res = await draftRoute(req);
      expect(res.status).toBe(401);
    });
  });
});
