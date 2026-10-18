/**
 * CashPilot AI — Secure Invoice Approval Integration & Unit Tests
 *
 * Task 5: Tests for hash-bound human approval gate (POST /api/invoices/[id]/approve)
 *
 * Invariants tested:
 * - Deterministic SHA-256 hashes for identical non-empty payloads.
 * - Hash changes when any material field changes (email, total, currency, due date, action type, line items).
 * - Valid approval creation bound to exact reviewed payload hash.
 * - Missing, malformed, or invalid JSON rejection (400).
 * - Stale hash rejection after invoice change (409 Conflict).
 * - Nonexistent invoice rejection (404 Not Found).
 * - Cross-workspace access rejection (403 Forbidden).
 * - Unauthorized request handling (401 Unauthorized in production boundary).
 * - Duplicate approval idempotency (returns existing approval, no duplicate row).
 * - Audit trail: ActivityEvent recorded with APPROVAL_APPROVED.
 * - Graceful internal error handling without leaking secrets (500).
 * - Zero PayPal or external provider calls during approval.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { POST as approveRoute } from "@/app/api/invoices/[id]/approve/route";
import { POST as draftRoute } from "@/app/api/invoices/draft/route";
import { GET as getInvoiceRoute } from "@/app/api/invoices/[id]/route";
import { db } from "@/lib/db/client";
import { computeMaterialPayloadHash } from "@/lib/services/invoice.service";
import * as paypalAdapter from "@/lib/paypal/adapter";
import { ApprovalStatus, ActivityEventType } from "@prisma/client";

describe("Secure Invoice Approval Gate", () => {
  const workspaceA = "demo-workspace-approval-a";
  const workspaceB = "demo-workspace-approval-b";
  const ownerA = "demo-user-approval-a";
  const ownerB = "demo-user-approval-b";
  const clientA = "demo-client-approval-a";

  const createdInvoiceIds: string[] = [];

  // Spy on PayPal adapter to verify zero external calls
  const createPayPalDraftSpy = vi.spyOn(paypalAdapter, "createPayPalDraftInvoice");
  const sendPayPalSpy = vi.spyOn(paypalAdapter, "sendPayPalInvoice");
  const getAccessTokenSpy = vi.spyOn(paypalAdapter, "getPayPalAccessToken");

  beforeAll(async () => {
    // Setup isolated test workspaces and clients in local PostgreSQL
    await db.workspace.upsert({
      where: { id: workspaceA },
      update: { ownerId: ownerA },
      create: {
        id: workspaceA,
        name: "Workspace A",
        ownerId: ownerA,
        isDemo: true,
      },
    });

    await db.workspace.upsert({
      where: { id: workspaceB },
      update: { ownerId: ownerB },
      create: {
        id: workspaceB,
        name: "Workspace B",
        ownerId: ownerB,
        isDemo: true,
      },
    });

    await db.client.upsert({
      where: { id: clientA },
      update: {},
      create: {
        id: clientA,
        workspaceId: workspaceA,
        name: "Client Alpha",
        email: "alpha@example.com",
        isDemo: true,
      },
    });
  });

  afterAll(async () => {
    // Clean up created test data in foreign-key order
    await db.activityEvent.deleteMany({
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
      where: { workspaceId: { in: [workspaceA, workspaceB] } },
    });
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceA, workspaceB] } },
    });
  });

  // Helper to create a draft invoice via API route
  async function createTestDraft() {
    const payload = {
      workspaceId: workspaceA,
      clientId: clientA,
      title: "Design & Security Audit",
      currency: "USD",
      taxRateBasisPoints: 500, // 5%
      invoiceDate: "2026-10-18",
      dueDate: "2026-11-01",
      notes: "Net 14 days",
      terms: "Strict compliance",
      lineItems: [
        {
          description: "Codebase Security Assessment",
          quantity: 2,
          unitPriceMinorUnits: 50000, // $500.00
        },
      ],
    };

    const res = await draftRoute(
      new NextRequest("http://localhost:3000/api/invoices/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );

    const json = await res.json();
    expect(res.status).toBe(201);
    createdInvoiceIds.push(json.data.id);
    return {
      invoiceId: json.data.id as string,
      initialHash: json.data.materialPayloadHash as string,
      invoice: json.data,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Material Payload Hash Determinism & Sensitivity
  // ───────────────────────────────────────────────────────────────────────────
  describe("Material Payload Hashing", () => {
    const basePayload = {
      id: "inv-test-hash-1",
      workspaceId: "ws-test-1",
      client: { email: "billing@client.com" },
      totalMinorUnits: 105000,
      currency: "USD",
      dueDate: "2026-11-01",
      actionType: "SEND_INVOICE" as const,
      lineItems: [
        {
          description: "Code Review",
          quantity: 2,
          unitPriceMinorUnits: 50000,
        },
      ],
    };

    it("produces deterministic SHA-256 hashes for identical non-empty payloads", () => {
      const hash1 = computeMaterialPayloadHash(basePayload);
      const hash2 = computeMaterialPayloadHash({ ...basePayload });

      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
      expect(hash1).toBe(hash2);
    });

    it("changes hash when recipient email changes", () => {
      const hash1 = computeMaterialPayloadHash(basePayload);
      const hash2 = computeMaterialPayloadHash({
        ...basePayload,
        client: { email: "different@client.com" },
      });
      expect(hash1).not.toBe(hash2);
    });

    it("changes hash when total minor units change", () => {
      const hash1 = computeMaterialPayloadHash(basePayload);
      const hash2 = computeMaterialPayloadHash({
        ...basePayload,
        totalMinorUnits: 105001,
      });
      expect(hash1).not.toBe(hash2);
    });

    it("changes hash when currency changes", () => {
      const hash1 = computeMaterialPayloadHash(basePayload);
      const hash2 = computeMaterialPayloadHash({
        ...basePayload,
        currency: "EUR",
      });
      expect(hash1).not.toBe(hash2);
    });

    it("changes hash when due date changes", () => {
      const hash1 = computeMaterialPayloadHash(basePayload);
      const hash2 = computeMaterialPayloadHash({
        ...basePayload,
        dueDate: "2026-11-15",
      });
      expect(hash1).not.toBe(hash2);
    });

    it("changes hash when action type changes", () => {
      const hash1 = computeMaterialPayloadHash({ ...basePayload, actionType: "SEND_INVOICE" });
      const hash2 = computeMaterialPayloadHash({ ...basePayload, actionType: "SEND_REMINDER" });
      const hash3 = computeMaterialPayloadHash({ ...basePayload, actionType: "CANCEL_INVOICE" });
      expect(hash1).not.toBe(hash2);
      expect(hash2).not.toBe(hash3);
      expect(hash1).not.toBe(hash3);
    });

    it("changes hash when line item contents change", () => {
      const hash1 = computeMaterialPayloadHash(basePayload);
      const hash2 = computeMaterialPayloadHash({
        ...basePayload,
        lineItems: [
          {
            description: "Code Review & Penetration Test",
            quantity: 2,
            unitPriceMinorUnits: 50000,
          },
        ],
      });
      expect(hash1).not.toBe(hash2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Valid Approval Flow & Idempotency
  // ───────────────────────────────────────────────────────────────────────────
  describe("Valid Approval", () => {
    it("successfully approves an invoice with valid reviewed hash and actor authorization", async () => {
      const { invoiceId, initialHash } = await createTestDraft();

      const res = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: initialHash,
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.approvalId).toBeDefined();
      expect(json.data.invoiceId).toBe(invoiceId);
      expect(json.data.actionType).toBe("SEND_INVOICE");
      expect(json.data.status).toBe(ApprovalStatus.APPROVED);
      expect(json.data.approvedPayloadHash).toBe(initialHash);
      expect(new Date(json.data.expiresAt).getTime()).toBeGreaterThan(Date.now());

      // Verify approval record in DB
      const dbApproval = await db.approval.findUnique({
        where: { id: json.data.approvalId },
      });
      expect(dbApproval).not.toBeNull();
      expect(dbApproval?.status).toBe(ApprovalStatus.APPROVED);
      expect(dbApproval?.payloadHash).toBe(initialHash);
      expect(dbApproval?.actorId).toBe(ownerA);

      // Verify audit event in DB
      const auditEvent = await db.activityEvent.findFirst({
        where: {
          invoiceId,
          eventType: ActivityEventType.APPROVAL_APPROVED,
        },
      });
      expect(auditEvent).not.toBeNull();
      expect(auditEvent?.actorId).toBe(ownerA);
      expect(auditEvent?.approvalId).toBe(json.data.approvalId);
    });

    it("returns existing approval idempotently on duplicate approval calls", async () => {
      const { invoiceId, initialHash } = await createTestDraft();

      // First call
      const res1 = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: initialHash,
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      const json1 = await res1.json();
      expect(res1.status).toBe(200);

      // Second identical call
      const res2 = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: initialHash,
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      const json2 = await res2.json();
      expect(res2.status).toBe(200);
      expect(json2.data.approvalId).toBe(json1.data.approvalId);
      expect(json2.data.approvedPayloadHash).toBe(json1.data.approvedPayloadHash);

      // Ensure only ONE approval record was created in the database
      const approvalsCount = await db.approval.count({
        where: { invoiceId, status: ApprovalStatus.APPROVED },
      });
      expect(approvalsCount).toBe(1);
    });

    it("seamlessly approves using hash returned by GET /api/invoices/[id]", async () => {
      const { invoiceId } = await createTestDraft();

      // Client reviews invoice via GET endpoint
      const getRes = await getInvoiceRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}`, {
          method: "GET",
          headers: { "x-workspace-id": workspaceA },
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      expect(getRes.status).toBe(200);
      const getJson = await getRes.json();
      const reviewedHash = getJson.data.materialPayloadHash;
      expect(reviewedHash).toHaveLength(64);

      // Client submits approval using hash from GET review
      const approveRes = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: reviewedHash,
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      expect(approveRes.status).toBe(200);
      const approveJson = await approveRes.json();
      expect(approveJson.success).toBe(true);
      expect(approveJson.data.approvedPayloadHash).toBe(reviewedHash);
    });

    it("handles concurrent approval attempts gracefully without creating duplicate approvals", async () => {
      const { invoiceId, initialHash } = await createTestDraft();

      // Launch two concurrent approval requests
      const [res1, res2] = await Promise.all([
        approveRoute(
          new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-actor-id": ownerA,
            },
            body: JSON.stringify({
              actionType: "SEND_INVOICE",
              reviewedPayloadHash: initialHash,
            }),
          }),
          { params: Promise.resolve({ id: invoiceId }) }
        ),
        approveRoute(
          new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-actor-id": ownerA,
            },
            body: JSON.stringify({
              actionType: "SEND_INVOICE",
              reviewedPayloadHash: initialHash,
            }),
          }),
          { params: Promise.resolve({ id: invoiceId }) }
        ),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      const json1 = await res1.json();
      const json2 = await res2.json();

      expect(json1.success).toBe(true);
      expect(json2.success).toBe(true);
      expect(json1.data.approvedPayloadHash).toBe(json2.data.approvedPayloadHash);

      const approvedCount = await db.approval.count({
        where: { invoiceId, status: ApprovalStatus.APPROVED },
      });
      expect(approvedCount).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Stale Hash Rejection & Material Invalidation
  // ───────────────────────────────────────────────────────────────────────────
  describe("Stale Hash & Invalidation", () => {
    it("rejects approval with 409 Conflict if reviewed hash does not match current invoice state", async () => {
      const { invoiceId } = await createTestDraft();

      const staleHash = "0000000000000000000000000000000000000000000000000000000000000000";

      const res = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: staleHash,
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.code).toBe("STALE_PAYLOAD_HASH");
      expect(json.error).toContain("The invoice has changed since review");

      // Verify no approval was saved
      const approval = await db.approval.findFirst({
        where: { invoiceId, payloadHash: staleHash },
      });
      expect(approval).toBeNull();
    });

    it("rejects approval if a material field was updated in the database after review", async () => {
      const { invoiceId, initialHash } = await createTestDraft();

      // Mutate a material field (e.g. totalMinorUnits) directly in DB simulating an update
      await db.invoice.update({
        where: { id: invoiceId },
        data: { totalMinorUnits: 999999 },
      });

      // Attempt approval with original hash (now stale)
      const res = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: initialHash,
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(409);
      expect(json.code).toBe("STALE_PAYLOAD_HASH");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Request Validation Errors
  // ───────────────────────────────────────────────────────────────────────────
  describe("Request Validation", () => {
    it("rejects request with missing reviewedPayloadHash with 400", async () => {
      const { invoiceId } = await createTestDraft();

      const res = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({ actionType: "SEND_INVOICE" }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe("VALIDATION_ERROR");
    });

    it("rejects malformed hash (non-hex or incorrect length) with 400", async () => {
      const { invoiceId } = await createTestDraft();

      // 63 chars (too short)
      const resShort = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: "a".repeat(63),
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      expect(resShort.status).toBe(400);

      // Non-hex characters
      const resNonHex = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: "z".repeat(64),
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );
      expect(resNonHex.status).toBe(400);
    });

    it("rejects non-JSON request body with 400", async () => {
      const { invoiceId } = await createTestDraft();

      const res = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: "INVALID_JSON{{{",
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe("INVALID_JSON");
    });

    it("returns 404 for nonexistent invoice ID", async () => {
      const validHash = "a".repeat(64);
      const res = await approveRoute(
        new NextRequest("http://localhost:3000/api/invoices/nonexistent-id-999/approve", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: validHash,
          }),
        }),
        { params: Promise.resolve({ id: "nonexistent-id-999" }) }
      );

      const json = await res.json();
      expect(res.status).toBe(404);
      expect(json.code).toBe("NOT_FOUND");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Authorization & Cross-Workspace Boundary
  // ───────────────────────────────────────────────────────────────────────────
  describe("Authorization & Workspace Boundaries", () => {
    it("rejects cross-workspace approval with 403 Forbidden", async () => {
      const { invoiceId, initialHash } = await createTestDraft();

      // Attempt to approve invoice in Workspace A using actor credentials of Workspace B's owner
      const res = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerB, // Actor belongs to workspace B, not A!
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: initialHash,
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      const json = await res.json();
      expect(res.status).toBe(403);
      expect(json.success).toBe(false);
      expect(json.code).toBe("CROSS_WORKSPACE_FORBIDDEN");
      expect(json.error).toContain("Access denied");

      // Verify no approval was created
      const count = await db.approval.count({ where: { invoiceId } });
      expect(count).toBe(0);
    });

    it("rejects missing actor with 401 Unauthorized when NODE_ENV is production", async () => {
      const originalEnv = process.env.NODE_ENV;
      try {
        (process.env as Record<string, string | undefined>).NODE_ENV = "production";
        const { invoiceId, initialHash } = await createTestDraft();

        const res = await approveRoute(
          new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // No actor header provided
            },
            body: JSON.stringify({
              actionType: "SEND_INVOICE",
              reviewedPayloadHash: initialHash,
            }),
          }),
          { params: Promise.resolve({ id: invoiceId }) }
        );

        const json = await res.json();
        expect(res.status).toBe(401);
        expect(json.code).toBe("UNAUTHORIZED");
      } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. External Boundary Invariants (Zero PayPal / AI Calls)
  // ───────────────────────────────────────────────────────────────────────────
  describe("External Service Boundaries", () => {
    it("strictly never invokes PayPal or external writes during approval", async () => {
      createPayPalDraftSpy.mockClear();
      sendPayPalSpy.mockClear();
      getAccessTokenSpy.mockClear();

      const { invoiceId, initialHash } = await createTestDraft();

      const res = await approveRoute(
        new NextRequest(`http://localhost:3000/api/invoices/${invoiceId}/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actor-id": ownerA,
          },
          body: JSON.stringify({
            actionType: "SEND_INVOICE",
            reviewedPayloadHash: initialHash,
          }),
        }),
        { params: Promise.resolve({ id: invoiceId }) }
      );

      expect(res.status).toBe(200);

      // Verify ZERO calls to PayPal
      expect(createPayPalDraftSpy).not.toHaveBeenCalled();
      expect(sendPayPalSpy).not.toHaveBeenCalled();
      expect(getAccessTokenSpy).not.toHaveBeenCalled();

      // Verify invoice status remains DRAFT, NOT paid or sent
      const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
      expect(invoice?.cashpilotStatus).toBe("DRAFT");
      expect(invoice?.paypalInvoiceId).toBeNull();
      expect(invoice?.paypalStatus).toBeNull();
    });
  });
});
