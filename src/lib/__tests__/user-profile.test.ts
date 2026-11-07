/**
 * CashPilot AI — User Profile Management Integration & UI Tests (USER-01)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import React from "react";
import { NextRequest } from "next/server";
import { GET, PATCH } from "@/app/api/user/profile/route";
import { db } from "@/lib/db/client";
import {
  assertAllowedTestDatabase,
  ensureTestUsers,
  cleanupTestUsers,
  createTestSession,
} from "@/lib/test-utils/auth";

describe("User Profile Management API (USER-01)", () => {
  const runId = Math.random().toString(36).substring(2, 7);
  const user1Id = `test-profile-u1-${runId}`;
  const user2Id = `test-profile-u2-${runId}`;
  const workspace1Id = `test-profile-ws-${runId}`;
  const user1Email = `profile1-${runId}@test.internal`;
  const user2Email = `profile2-${runId}@test.internal`;

  let cookie1 = "";
  let cookie2 = "";

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
    await assertAllowedTestDatabase();

    await ensureTestUsers([
      { id: user1Id, email: user1Email, name: "Initial Name" },
      { id: user2Id, email: user2Email, name: "Other User" },
    ]);

    await db.workspace.upsert({
      where: { id: workspace1Id },
      update: {},
      create: {
        id: workspace1Id,
        name: "Profile Test Studio",
        ownerId: user1Id,
        isDemo: false,
      },
    });

    const session1 = createTestSession({
      userId: user1Id,
      workspaceId: workspace1Id,
      email: user1Email,
      name: "Initial Name",
      isDemo: false,
    });
    cookie1 = session1.cookieHeader;

    const session2 = createTestSession({
      userId: user2Id,
      workspaceId: workspace1Id,
      email: user2Email,
      name: "Other User",
      isDemo: false,
    });
    cookie2 = session2.cookieHeader;
  });

  afterAll(async () => {
    try {
      await db.activityEvent.deleteMany({
        where: { workspaceId: workspace1Id },
      });
      await db.workspace.deleteMany({
        where: { id: workspace1Id },
      });
    } catch {
      // ignore
    }
    await cleanupTestUsers([user1Id, user2Id]);
  });

  describe("GET /api/user/profile", () => {
    it("returns 401 when unauthenticated", async () => {
      const req = makeRequest("/api/user/profile");
      const res = await GET(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it("returns authenticated user profile and workspace summary without exposing passwordHash", async () => {
      const req = makeRequest("/api/user/profile", { cookie: cookie1 });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.user.id).toBe(user1Id);
      expect(json.data.user.name).toBe("Initial Name");
      expect(json.data.user.email).toBe(user1Email);
      expect(json.data.user.passwordHash).toBeUndefined();
      expect(json.data.workspace.id).toBe(workspace1Id);
      expect(json.data.workspace.name).toBe("Profile Test Studio");
    });
  });

  describe("PATCH /api/user/profile", () => {
    it("returns 401 when unauthenticated", async () => {
      const req = makeRequest("/api/user/profile", {
        method: "PATCH",
        body: { name: "New Name", email: "new@test.internal" },
      });
      const res = await PATCH(req);
      expect(res.status).toBe(401);
    });

    it("rejects invalid inputs with 400", async () => {
      // Too short name
      const req1 = makeRequest("/api/user/profile", {
        method: "PATCH",
        cookie: cookie1,
        body: { name: "A", email: "valid@test.internal" },
      });
      const res1 = await PATCH(req1);
      expect(res1.status).toBe(400);

      // Invalid email
      const req2 = makeRequest("/api/user/profile", {
        method: "PATCH",
        cookie: cookie1,
        body: { name: "Valid Name", email: "not-an-email" },
      });
      const res2 = await PATCH(req2);
      expect(res2.status).toBe(400);
    });

    it("rejects email collision with another user", async () => {
      const req = makeRequest("/api/user/profile", {
        method: "PATCH",
        cookie: cookie1,
        body: { name: "Updated Name", email: user2Email },
      });
      const res = await PATCH(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/already in use/i);
    });

    it("successfully updates name and email in database and returns updated user", async () => {
      const updatedEmail = `alex-${runId}@test.internal`;
      const req = makeRequest("/api/user/profile", {
        method: "PATCH",
        cookie: cookie1,
        body: { name: "Alex Freelancer", email: updatedEmail },
      });
      const res = await PATCH(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.name).toBe("Alex Freelancer");
      expect(json.data.email).toBe(updatedEmail);
      expect(json.data.passwordHash).toBeUndefined();

      // Verify directly in DB
      const dbUser = await db.user.findUnique({ where: { id: user1Id } });
      expect(dbUser?.name).toBe("Alex Freelancer");
      expect(dbUser?.email).toBe(updatedEmail);
    });
  });

  describe("UserProfileView Component UI Rendering", () => {
    it("renders user information, initials avatar, and workspace statistics", async () => {
      const { renderToString } = await import("react-dom/server");
      const { UserProfileView } = await import("@/components/profile/user-profile-view");

      const html = renderToString(
        React.createElement(UserProfileView, {
          initialData: {
            user: {
              id: "test-user-id",
              name: "Sara Connor",
              email: "sara@cyberdyne.org",
              createdAt: "2026-01-15T00:00:00.000Z",
              updatedAt: "2026-01-15T00:00:00.000Z",
            },
            workspace: {
              id: "test-ws-id",
              name: "Resistance Ops",
              isDemo: true,
              invoiceCount: 14,
              clientCount: 8,
            },
          },
        })
      );

      // Verify name, email, initials SC, and workspace metrics
      expect(html).toContain("Sara Connor");
      expect(html).toContain("sara@cyberdyne.org");
      expect(html).toContain("SC");
      expect(html).toContain("Resistance Ops");
      expect(html).toContain("DEMO");
      expect(html).toContain("14");
      expect(html).toContain("8");
      expect(html).toContain("Save Profile");
    });
  });
});
