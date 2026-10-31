/**
 * CashPilot AI — Activity Service Integration Tests
 *
 * SRS §4, §5 & UI Design Reference Page 15:
 * Tests the audit query service, event transformation, badge derivation, and 5-step journey tracer.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import {
  getWorkspaceActivityFeed,
  getInvoiceEndToEndTrace,
  getWorkspaceInvoicesForActivitySelector,
  deriveOutcomeBadge,
} from "@/lib/services/activity.service";
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
  ensureTestUsers,
  cleanupTestUsers,
  assertAllowedTestDatabase,
} from "@/lib/test-utils/auth";

describe("Activity & Audit Service (activity.service.ts)", () => {
  const workspaceA = "test-ws-act-service-a";
  const workspaceB = "test-ws-act-service-b";
  const ownerA = "test-user-act-service-a";
  const ownerB = "test-user-act-service-b";
  const clientA = "test-client-act-service-a";

  beforeAll(async () => {
    await assertAllowedTestDatabase();
    await ensureTestUsers([
      { id: ownerA, email: "act-service-a@example.com", name: "Act Owner A" },
      { id: ownerB, email: "act-service-b@example.com", name: "Act Owner B" },
    ]);

    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Activity Test Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Activity Test Workspace B",
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
    await db.aiDraft.deleteMany({
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
    await db.aiDraft.deleteMany({
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
  });

  it("derives badge variants correctly based on event types and metadata", () => {
    expect(deriveOutcomeBadge(ActivityEventType.OPERATION_SUCCEEDED, ActorType.SYSTEM, "Confirmed").variant).toBe("confirmed");
    expect(deriveOutcomeBadge(ActivityEventType.APPROVAL_APPROVED, ActorType.USER, "Approved sending").variant).toBe("approved");
    expect(deriveOutcomeBadge(ActivityEventType.AI_DRAFT_GENERATED, ActorType.AI, "Draft generated").variant).toBe("proposed");
    expect(deriveOutcomeBadge(ActivityEventType.APPROVAL_INVALIDATED, ActorType.SYSTEM, "Material edit").variant).toBe("rejected");
    expect(deriveOutcomeBadge(ActivityEventType.SYSTEM_EVENT, ActorType.SYSTEM, "AI request blocked: outside workspace").variant).toBe("rejected");
    expect(deriveOutcomeBadge(ActivityEventType.OPERATION_TIMED_OUT, ActorType.SYSTEM, "Send timed out").variant).toBe("unknown");
    expect(deriveOutcomeBadge(ActivityEventType.STATUS_SYNC_SUCCESS, ActorType.SYSTEM, "1 needs review", { staleCount: 1 }).variant).toBe("partial");
  });

  it("enforces tenant boundary: rejects actor that does not own workspace", async () => {
    await expect(
      getWorkspaceActivityFeed(workspaceA, ownerB)
    ).rejects.toThrow("Unauthorized workspace access");
  });

  it("retrieves workspace activity feed with date grouping, badges, and filters", async () => {
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

    // Create 3 events
    await db.activityEvent.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        eventType: ActivityEventType.AI_DRAFT_GENERATED,
        actorType: ActorType.AI,
        description: "Invoice drafted from your request",
        metadata: { missingFieldsCount: 2 },
      },
    });

    await db.activityEvent.create({
      data: {
        workspaceId: workspaceA,
        invoiceId: inv.id,
        eventType: ActivityEventType.APPROVAL_APPROVED,
        actorType: ActorType.USER,
        actorId: ownerA,
        description: "You approved sending · INV-0014",
        metadata: { payloadHash: "a91f38e2d4bc9103c2" },
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

    // Test Feed
    const feed = await getWorkspaceActivityFeed(workspaceA, ownerA);
    expect(feed.totalCount).toBe(3);
    expect(feed.items.length).toBe(3);

    // Verify first item (most recent: OPERATION_SUCCEEDED)
    const item0 = feed.items[0];
    expect(item0.eventType).toBe(ActivityEventType.OPERATION_SUCCEEDED);
    expect(item0.outcomeBadge.variant).toBe("confirmed");
    expect(item0.amountFormatted).toBe("$1200.00");
    expect(item0.dateGroupKey).toContain("Today");

    // Verify filtering by type: approval
    const approvalFeed = await getWorkspaceActivityFeed(workspaceA, ownerA, { type: "approval" });
    expect(approvalFeed.totalCount).toBe(1);
    expect(approvalFeed.items[0].eventType).toBe(ActivityEventType.APPROVAL_APPROVED);
    expect(approvalFeed.items[0].outcomeBadge.variant).toBe("approved");

    // Verify filtering by result: proposed
    const proposedFeed = await getWorkspaceActivityFeed(workspaceA, ownerA, { result: "proposed" });
    expect(proposedFeed.totalCount).toBe(1);
    expect(proposedFeed.items[0].eventType).toBe(ActivityEventType.AI_DRAFT_GENERATED);
    expect(proposedFeed.items[0].outcomeBadge.variant).toBe("proposed");
  });

  it("reconstructs the 5-step lifecycle trace for an invoice (Page 15 'Follow one invoice end to end')", async () => {
    // 1. AiDraft
    const draft = await db.aiDraft.create({
      data: {
        workspaceId: workspaceA,
        inputText: "Website design, $1,200, due in 14 days",
        structuredOutput: {
          clientName: "Acme Studio",
          totalMinorUnits: 120000,
          currency: "USD",
        },
      },
    });

    // 2. Invoice
    const inv = await db.invoice.create({
      data: {
        workspaceId: workspaceA,
        clientId: clientA,
        aiDraftId: draft.id,
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

    // 3. Approval
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

    // 4. External Operation
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

    // Reconstruct Trace
    const trace = await getInvoiceEndToEndTrace(workspaceA, inv.id);
    expect(trace).not.toBeNull();
    expect(trace!.invoiceNumber).toBe("INV-0014");
    expect(trace!.clientName).toBe("Acme Studio");
    expect(trace!.totalFormatted).toBe("$1200.00");
    expect(trace!.steps.length).toBe(5);

    // Step 1: Your request
    expect(trace!.steps[0].title).toBe("Your request");
    expect(trace!.steps[0].summary).toBe("Website design, $1,200, due in 14 days");
    expect(trace!.steps[0].status).toBe("completed");

    // Step 2: Navi's draft
    expect(trace!.steps[1].title).toBe("Navi's draft");
    expect(trace!.steps[1].badgeLabel).toBe("AI");
    expect(trace!.steps[1].status).toBe("completed");

    // Step 3: Your edits
    expect(trace!.steps[2].title).toBe("Your edits");
    expect(trace!.steps[2].status).toBe("completed");

    // Step 4: Your approval
    expect(trace!.steps[3].title).toBe("Your approval");
    expect(trace!.steps[3].badgeLabel).toBe("You");
    expect(trace!.steps[3].summary).toContain("version a91f…03c2");
    expect(trace!.steps[3].status).toBe("completed");

    // Step 5: PayPal's response
    expect(trace!.steps[4].title).toBe("PayPal's response");
    expect(trace!.steps[4].badgeLabel).toBe("PayPal");
    expect(trace!.steps[4].summary).toContain("accepted, status SENT");
    expect(trace!.steps[4].status).toBe("completed");

    // Verify selector helper
    const selectorOptions = await getWorkspaceInvoicesForActivitySelector(workspaceA);
    expect(selectorOptions.length).toBe(1);
    expect(selectorOptions[0].number).toBe("INV-0014");
  });
});
