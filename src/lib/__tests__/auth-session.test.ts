import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateSessionToken,
  hashSessionToken,
  getSessionCookieOptions,
  createSession,
  verifySessionToken,
  revokeSession,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from "@/lib/auth/session";
import { db } from "@/lib/db/client";

describe("Database Session Management Utilities", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("generates opaque base64url tokens with at least 256 bits of entropy", () => {
    const token1 = generateSessionToken();
    const token2 = generateSessionToken();

    expect(token1).not.toBe(token2);
    expect(token1.length).toBeGreaterThanOrEqual(42);
    expect(token1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("computes deterministic SHA-256 hash for opaque tokens", () => {
    const token = "my-opaque-session-token-1234567890";
    const hash1 = hashSessionToken(token);
    const hash2 = hashSessionToken(token);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).not.toBe(token);
  });

  it("produces secure HTTP-only cookie options", () => {
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    const options = getSessionCookieOptions(expiresAt);

    expect(options.name).toBe(SESSION_COOKIE_NAME);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.expires).toEqual(expiresAt);
    expect(options.maxAge).toBe(SESSION_TTL_SECONDS);
  });

  it("creates a session by storing only the SHA-256 hash, returning the raw token", async () => {
    const fakeUserId = "usr-test-123";
    const createSpy = vi.spyOn(db.session, "create").mockResolvedValue({
      id: "sess-123",
      userId: fakeUserId,
      tokenHash: "mock-hash",
      expiresAt: new Date(Date.now() + 100000),
      createdAt: new Date(),
    });

    const result = await createSession(fakeUserId);

    expect(result.token).toBeDefined();
    expect(result.session.id).toBe("sess-123");
    expect(createSpy).toHaveBeenCalledTimes(1);

    const callArgs = createSpy.mock.calls[0][0];
    expect(callArgs.data.userId).toBe(fakeUserId);
    expect(callArgs.data.tokenHash).toBe(hashSessionToken(result.token));
  });

  it("verifies a valid session token against stored tokenHash", async () => {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const futureDate = new Date(Date.now() + 3600000);

    vi.spyOn(db.session, "findUnique").mockResolvedValue({
      id: "sess-valid",
      userId: "usr-456",
      tokenHash,
      expiresAt: futureDate,
      createdAt: new Date(),
      user: {
        id: "usr-456",
        email: "alice@example.com",
        name: "Alice Builder",
        createdAt: new Date(),
        workspaces: [
          {
            id: "ws-alice-1",
            name: "Alice Studio",
            isDemo: false,
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof db.session.findUnique>>);

    const sessionContext = await verifySessionToken(token);

    expect(sessionContext).not.toBeNull();
    expect(sessionContext?.user.email).toBe("alice@example.com");
    expect(sessionContext?.workspace?.id).toBe("ws-alice-1");
    expect(sessionContext?.workspace?.isDemo).toBe(false);
  });

  it("rejects and prunes expired session tokens", async () => {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const pastDate = new Date(Date.now() - 3600000); // 1 hour ago

    vi.spyOn(db.session, "findUnique").mockResolvedValue({
      id: "sess-expired",
      userId: "usr-expired",
      tokenHash,
      expiresAt: pastDate,
      createdAt: new Date(),
      user: {
        id: "usr-expired",
        email: "bob@example.com",
        name: "Bob Builder",
        createdAt: new Date(),
        workspaces: [],
      },
    } as unknown as Awaited<ReturnType<typeof db.session.findUnique>>);

    const deleteSpy = vi
      .spyOn(db.session, "delete")
      .mockResolvedValue({} as unknown as Awaited<ReturnType<typeof db.session.delete>>);

    const sessionContext = await verifySessionToken(token);

    expect(sessionContext).toBeNull();
    expect(deleteSpy).toHaveBeenCalledWith({ where: { id: "sess-expired" } });
  });

  it("revokes an active session by token hash", async () => {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);

    const deleteManySpy = vi.spyOn(db.session, "deleteMany").mockResolvedValue({ count: 1 });

    const success = await revokeSession(token);

    expect(success).toBe(true);
    expect(deleteManySpy).toHaveBeenCalledWith({ where: { tokenHash } });
  });

  it("handles empty or missing tokens cleanly without throwing", async () => {
    expect(await verifySessionToken("")).toBeNull();
    expect(await verifySessionToken(null)).toBeNull();
    expect(await verifySessionToken(undefined)).toBeNull();
    expect(await revokeSession("")).toBe(false);
  });
});
