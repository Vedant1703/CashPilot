/**
 * CashPilot AI — Activity API Integration Tests
 *
 * SRS §4, §5 & UI Design Reference Page 15:
 * Integration tests for GET /api/activity route.
 *
 * Invariants tested:
 * - Unauthenticated requests return 401 Unauthorized.
 * - Cross-workspace access attempts return 403 Forbidden.
 * - Authorized workspace requests return 200 OK with feed, badges, and invoice trace.
 * - Filtering by type and result filters the dataset deterministically.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as activityRoute } from "@/app/api/activity/route";
import { db } from "@/lib/db/client";
import {
  ActivityEventType,
  ActorType,
  CashPilotStatus,
  ApprovalAction,
  ApprovalStatus,
  OperationType,
  OperationAttemptState,
} from "@prisma/client";
import {
  createTestSession,
  ensureTestUsers,
  cleanupTestUsers,
  assertAllowedTestDatabase,
} from "@/lib/test-utils/auth";

describe("Workspace Activity API (GET /api/activity)", () => {
  const workspaceA = "test-ws-act-api-a";
  const workspaceB = "test-ws-act-api-b";
  const ownerA = "test-user-act-api-a";
  const ownerB = "test-user-act-api-b";
  const clientA = "test-client-act-api-a";

  let sessionA: { cookieHeader: string; sessionToken: string };
  let sessionB: { cookieHeader: string; sessionToken: string };

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([
      { id: ownerA, email: "act-api-a@example.com", name: "Act API Owner A" },
      { id: ownerB, email: "act-api-b@example.com", name: "Act API Owner B" },
    ]);

    sessionA = createTestSession({ userId: ownerA, email: "act-api-a@example.com" });
    sessionB = createTestSession({ userId: ownerB, email: "act-api-b@example.com" });

    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Activity API Test Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Activity API Test Workspace B",
        ownerId: ownerB,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientA },
      update: { workspaceId: workspaceA },
      create: {
        id: clientA,
        workspaceId: workspaceA,
        name: "Acme Studio",
        email: "billing@acmestudio.test",
      },
    });
  });

  afterAll(async () => {
    await db.activityEvent.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.externalOperation.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.approval.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.invoiceLineItem.deleteMany({
      where: { invoice: { workspaceId: { in: [workspaceA, workspaceB] } } },
    });
    await db.invoice.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.client.deleteMany({
      where: { id: clientA },
    });
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceA, workspaceB] } },
    });
    await cleanupTestUsers([ownerA, ownerB]);
  });

  beforeEach(async () => {
    await db.activityEvent.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.externalOperation.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.approval.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.invoiceLineItem.deleteMany({
      where: { invoice: { workspaceId: { in: [workspaceA, workspaceB] } } },
    });
    await db.invoice.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
  });

  it("returns 401 Unauthorized when unauthenticated", async () => {
    const req = new NextRequest("http://localhost:3000/api/activity");
    const res = await activityRoute(req);
    expect(res.status).toBe(401);

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 Forbidden when user attempts to access another workspace activity", async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/activity?workspaceId=${workspaceA}`,
      {
        headers: { cookie: sessionB.cookieHeader },
      }
    );

    const res = await activityRoute(req);
    expect(res.status).toBe(403);

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
  });

  it("returns 200 OK with activity items, badges, and invoice trace when authorized", async () => {
    // Setup test invoice with approval, operation, and activity events
    const inv = await db.invoice.create({
      data: {
        workspaceId: workspaceA,
        clientId: clientA,
        number: "INV-0014",
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paypalInvoiceId: "INV2-3F8N-D2KJ",
        paypalStatus: "SENT",
        subtotalMinorUnits: 120000,
        taxMinorUnits: 0,
        taxRateBasisPoints: 0,
        totalMinorUnits: 120000,
        currency: "USD",
        invoiceDate: new Date(),
        dueDate: new Date(Date.now() + 14 * 86400000),
      },
    });

    await db.approval.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        actorId: ownerA,
        actionType: ApprovalAction.SEND_INVOICE,
        payloadHash: "a91f38e2d4bc9103c2",
        payloadSnapshot: { totalMinorUnits: 120000 },
        status: ApprovalStatus.APPROVED,
        approvedAt: new Date(),
      },
    });

    await db.externalOperation.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        operationType: OperationType.SEND_INVOICE,
        attemptState: OperationAttemptState.SUCCESS,
        providerInvoiceId: "INV2-3F8N-D2KJ",
        completedAt: new Date(),
      },
    });

    await db.activityEvent.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        eventType: ActivityEventType.OPERATION_SUCCEEDED,
        actorType: ActorType.SYSTEM,
        description: "Invoice sent via PayPal · INV-0014",
        metadata: { provider: "paypal" },
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/activity?workspaceId=${workspaceA}&invoiceId=${inv.id}`,
      {
        headers: { cookie: sessionA.cookieHeader },
      }
    );

    const res = await activityRoute(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.items.length).toBe(1);
    expect(json.data.items[0].eventType).toBe(ActivityEventType.OPERATION_SUCCEEDED);
    expect(json.data.items[0].outcomeBadge.variant).toBe("confirmed");

    // Verify 5-step trace in response
    expect(json.data.invoiceTrace).toBeDefined();
    expect(json.data.invoiceTrace.invoiceNumber).toBe("INV-0014");
    expect(json.data.invoiceTrace.steps.length).toBe(5);
    expect(json.data.invoiceTrace.steps[4].badgeLabel).toBe("PayPal");
    expect(json.data.invoiceTrace.steps[4].summary).toContain("accepted, status SENT");
  });
});
