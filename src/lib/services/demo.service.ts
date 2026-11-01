/**
 * CashPilot AI — Demo Workspace Service
 *
 * Implements safe, isolated reset mechanics for the judge-facing Demo Workspace.
 *
 * Rules & Invariants:
 * - Operates strictly on `demo-workspace-1` and `demo-user-1`.
 * - Never modifies, deletes, or touches non-demo workspaces or customer data.
 * - Fails closed if workspace ownership, ID, or demo invariants do not match.
 * - Atomic: all deletions and canonical restorations occur within a database transaction.
 * - Read-only with respect to external providers: never makes PayPal API calls or
 *   claims that external PayPal invoices were cancelled.
 * - Transparently accounts for any PayPal-linked invoices that existed prior to reset.
 */

import { db } from "@/lib/db/client";
import { CashPilotStatus, ActivityEventType, ActorType, Prisma } from "@prisma/client";

export const DEMO_USER_ID = "demo-user-1";
export const DEMO_WORKSPACE_ID = "demo-workspace-1";
export const DEMO_WORKSPACE_NAME = "My Freelance Studio";

export const CANONICAL_CLIENT_IDS = [
  "demo-client-1",
  "demo-client-2",
  "demo-client-3",
] as const;

export const CANONICAL_INVOICE_IDS = [
  "demo-invoice-1",
  "demo-invoice-2",
  "demo-invoice-3",
  "demo-invoice-4",
] as const;

export interface ResetDemoResult {
  success: boolean;
  message: string;
  restoredInvoicesCount: number;
  restoredClientsCount: number;
  removedInvoicesCount: number;
  removedClientsCount: number;
  cleanedExternalOperationsCount: number;
  unaffectedPayPalInvoicesCount: number;
  unaffectedPayPalInvoiceIds?: string[];
  resetAt: string;
}

export type ResetDemoServiceResult =
  | { ok: true; data: ResetDemoResult }
  | { ok: false; error: string; code: string; status: number };

export interface ResetDemoOptions {
  actorId?: string;
  targetWorkspaceId?: string;
  _simulateTxError?: boolean;
}

/**
 * Reset the Demo Workspace to its canonical seeded baseline.
 *
 * Requirements:
 * 1. Actor must be demo-user-1 and target must be demo-workspace-1.
 * 2. Workspace must be marked isDemo: true.
 * 3. Atomic database transaction rolls back on any error.
 * 4. Removes non-canonical records and recreates the 4 canonical invoices & 3 clients.
 * 5. Does not make external PayPal calls; notes any unaffected PayPal invoices.
 */
export async function resetDemoWorkspace(
  options?: ResetDemoOptions
): Promise<ResetDemoServiceResult> {
  const actorId = options?.actorId ?? DEMO_USER_ID;
  const targetWorkspaceId = options?.targetWorkspaceId ?? DEMO_WORKSPACE_ID;

  // 1. Invariant check: Target must be demo-workspace-1
  if (targetWorkspaceId !== DEMO_WORKSPACE_ID) {
    return {
      ok: false,
      error: "Access denied. Only the canonical demo workspace may be reset.",
      code: "CANNOT_RESET_NON_DEMO_WORKSPACE",
      status: 403,
    };
  }

  // 2. Invariant check: Actor must be demo-user-1
  if (actorId !== DEMO_USER_ID) {
    return {
      ok: false,
      error: "Access denied. Only the demo user may reset the demo workspace.",
      code: "DEMO_USER_MISMATCH",
      status: 403,
    };
  }

  // 3. Invariant check: Verify workspace existence, ownership, and isDemo flag in DB
  const workspace = await db.workspace.findUnique({
    where: { id: DEMO_WORKSPACE_ID },
  });

  if (!workspace) {
    return {
      ok: false,
      error: "Demo workspace not found in database.",
      code: "WORKSPACE_NOT_FOUND",
      status: 404,
    };
  }

  if (workspace.ownerId !== DEMO_USER_ID) {
    return {
      ok: false,
      error: "Demo workspace ownership mismatch. Refusing reset.",
      code: "DEMO_OWNERSHIP_MISMATCH",
      status: 500,
    };
  }

  if (!workspace.isDemo) {
    return {
      ok: false,
      error: "Workspace is not flagged as a demo workspace. Refusing reset.",
      code: "DEMO_INVARIANT_VIOLATION",
      status: 500,
    };
  }

  // 4. Pre-reset inspection: Inspect external operations and PayPal-linked records
  // We record how many PayPal-linked invoices exist that will be removed from local DB.
  // We do NOT call PayPal to cancel or delete them (Requirement 9 & 10).
  const [
    nonCanonicalInvoicesCount,
    nonCanonicalClientsCount,
    externalOpsCount,
    payPalLinkedInvoices,
  ] = await Promise.all([
    db.invoice.count({
      where: {
        workspaceId: DEMO_WORKSPACE_ID,
        id: { notIn: Array.from(CANONICAL_INVOICE_IDS) },
      },
    }),
    db.client.count({
      where: {
        workspaceId: DEMO_WORKSPACE_ID,
        id: { notIn: Array.from(CANONICAL_CLIENT_IDS) },
      },
    }),
    db.externalOperation.count({
      where: { workspaceId: DEMO_WORKSPACE_ID },
    }),
    db.invoice.findMany({
      where: {
        workspaceId: DEMO_WORKSPACE_ID,
        paypalInvoiceId: { not: null },
        id: { notIn: Array.from(CANONICAL_INVOICE_IDS) },
      },
      select: {
        paypalInvoiceId: true,
      },
    }),
  ]);

  const payPalInvoiceIds = payPalLinkedInvoices
    .map((inv) => inv.paypalInvoiceId)
    .filter((id): id is string => Boolean(id));
  const payPalLinkedCount = payPalInvoiceIds.length;

  const now = new Date();
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
  const subtractDays = (d: Date, n: number) => addDays(d, -n);

  // 5. Execute atomic database transaction
  try {
    await db.$transaction(
      async (tx) => {
        // Step A: Delete activity events strictly for demo-workspace-1,
        // preserving previous demo reset SYSTEM_EVENT records.
        await tx.activityEvent.deleteMany({
          where: {
            workspaceId: DEMO_WORKSPACE_ID,
            NOT: {
              eventType: ActivityEventType.SYSTEM_EVENT,
              description: { startsWith: "[DEMO RESET]" },
            },
          },
        });

        if (options?._simulateTxError) {
          throw new Error("Simulated database failure during reset transaction");
        }

        // Step B: Delete external operations strictly for demo-workspace-1
        await tx.externalOperation.deleteMany({
          where: { workspaceId: DEMO_WORKSPACE_ID },
        });

        // Step C: Delete approvals strictly for demo-workspace-1
        await tx.approval.deleteMany({
          where: { workspaceId: DEMO_WORKSPACE_ID },
        });

        // Step D: Delete AI drafts strictly for demo-workspace-1
        await tx.aiDraft.deleteMany({
          where: { workspaceId: DEMO_WORKSPACE_ID },
        });

        // Step E: Delete all invoice line items belonging to demo-workspace-1 invoices
        await tx.invoiceLineItem.deleteMany({
          where: { invoice: { workspaceId: DEMO_WORKSPACE_ID } },
        });

        // Step F: Delete all existing invoices in demo-workspace-1
        await tx.invoice.deleteMany({
          where: { workspaceId: DEMO_WORKSPACE_ID },
        });

        // Step G: Delete any non-canonical clients in demo-workspace-1
        await tx.client.deleteMany({
          where: {
            workspaceId: DEMO_WORKSPACE_ID,
            id: { notIn: Array.from(CANONICAL_CLIENT_IDS) },
          },
        });

        // Step H: Restore the 3 canonical clients
        const canonicalClients = [
          {
            id: "demo-client-1",
            workspaceId: DEMO_WORKSPACE_ID,
            name: "Acme Corporation",
            email: "accounts@acme-sandbox.example.com",
            company: "Acme Corp",
            isDemo: true,
          },
          {
            id: "demo-client-2",
            workspaceId: DEMO_WORKSPACE_ID,
            name: "Jane Smith",
            email: "jane.smith-sandbox@example.com",
            company: "Smith & Associates",
            isDemo: true,
          },
          {
            id: "demo-client-3",
            workspaceId: DEMO_WORKSPACE_ID,
            name: "TechStart Inc",
            email: "billing-sandbox@techstart.example.com",
            company: "TechStart Inc",
            isDemo: true,
          },
        ];

        for (const c of canonicalClients) {
          await tx.client.upsert({
            where: { id: c.id },
            update: {
              name: c.name,
              email: c.email,
              company: c.company,
              isDemo: true,
            },
            create: c,
          });
        }

        // Step I: Restore the 4 canonical invoices with line items
        const canonicalInvoices = [
          {
            id: "demo-invoice-1",
            clientId: "demo-client-1",
            title: "UX Design Services — Q4 2026",
            currency: "USD",
            taxRateBasisPoints: 0,
            dueDate: addDays(now, 14),
            cashpilotStatus: CashPilotStatus.DRAFT,
            paypalInvoiceId: null,
            paypalStatus: null,
            paypalStatusRaw: Prisma.DbNull,
            paypalPayerViewUrl: null,
            isDemoData: true,
            notes: null,
            lineItems: [
              { description: "UX Research and Wireframes", quantity: 20, unitPriceMinorUnits: 15000 },
              { description: "Prototype Design", quantity: 15, unitPriceMinorUnits: 17500 },
            ],
          },
          {
            id: "demo-invoice-2",
            clientId: "demo-client-2",
            title: "Brand Strategy Consulting",
            currency: "USD",
            taxRateBasisPoints: 0,
            dueDate: addDays(now, 5), // DUE_SOON
            cashpilotStatus: CashPilotStatus.DUE_SOON,
            paypalInvoiceId: null,
            paypalStatus: "SENT",
            paypalStatusRaw: Prisma.DbNull,
            paypalPayerViewUrl: null,
            isDemoData: true,
            notes: null,
            lineItems: [
              { description: "Brand Identity Workshop", quantity: 8, unitPriceMinorUnits: 25000 },
              { description: "Style Guide Document", quantity: 1, unitPriceMinorUnits: 150000 },
            ],
          },
          {
            id: "demo-invoice-3",
            clientId: "demo-client-3",
            title: "Web Development — Sprint 3",
            currency: "USD",
            taxRateBasisPoints: 0,
            dueDate: subtractDays(now, 15), // OVERDUE
            cashpilotStatus: CashPilotStatus.OVERDUE,
            paypalInvoiceId: "INV2-DEMO-OVERDUE-0003",
            paypalStatus: "SENT",
            paypalStatusRaw: Prisma.DbNull,
            paypalPayerViewUrl: null,
            isDemoData: true,
            notes: null,
            lineItems: [
              { description: "Frontend Development", quantity: 40, unitPriceMinorUnits: 12500 },
              { description: "Code Review & Testing", quantity: 10, unitPriceMinorUnits: 10000 },
            ],
          },
          {
            id: "demo-invoice-4",
            clientId: "demo-client-1",
            title: "Logo Design Package",
            currency: "USD",
            taxRateBasisPoints: 0,
            dueDate: subtractDays(now, 30),
            cashpilotStatus: CashPilotStatus.PAID,
            paypalInvoiceId: null,
            paypalStatus: "PAID",
            paypalStatusRaw: Prisma.DbNull,
            paypalPayerViewUrl: null,
            isDemoData: true,
            notes: "[DEMO DATA] This invoice is a fixture record, not PayPal-verified.",
            lineItems: [
              { description: "Logo Design (3 concepts)", quantity: 1, unitPriceMinorUnits: 250000 },
              { description: "Final Files & Brand Kit", quantity: 1, unitPriceMinorUnits: 75000 },
            ],
          },
        ];

        for (const inv of canonicalInvoices) {
          const lineItemTotals = inv.lineItems.map((li) => li.quantity * li.unitPriceMinorUnits);
          const subtotalMinorUnits = lineItemTotals.reduce((a, b) => a + b, 0);
          const taxMinorUnits = Math.round((subtotalMinorUnits * inv.taxRateBasisPoints) / 10000);
          const totalMinorUnits = subtotalMinorUnits + taxMinorUnits;

          await tx.invoice.create({
            data: {
              id: inv.id,
              workspaceId: DEMO_WORKSPACE_ID,
              clientId: inv.clientId,
              title: inv.title,
              currency: inv.currency,
              taxRateBasisPoints: inv.taxRateBasisPoints,
              subtotalMinorUnits,
              taxMinorUnits,
              totalMinorUnits,
              dueDate: inv.dueDate,
              cashpilotStatus: inv.cashpilotStatus,
              paypalInvoiceId: inv.paypalInvoiceId,
              paypalStatus: inv.paypalStatus,
              paypalStatusRaw: inv.paypalStatusRaw,
              paypalPayerViewUrl: inv.paypalPayerViewUrl,
              isDemoData: inv.isDemoData,
              notes: inv.notes,
              lineItems: {
                create: inv.lineItems.map((li, idx) => ({
                  description: li.description,
                  quantity: li.quantity,
                  unitPriceMinorUnits: li.unitPriceMinorUnits,
                  totalMinorUnits: lineItemTotals[idx],
                  sortOrder: idx,
                })),
              },
            },
          });
        }

        // Step J: Re-seed baseline activity events + the audit event for this reset
        await tx.activityEvent.createMany({
          data: [
            {
              workspaceId: DEMO_WORKSPACE_ID,
              invoiceId: "demo-invoice-2",
              eventType: ActivityEventType.OPERATION_SUCCEEDED,
              actorType: ActorType.SYSTEM,
              actorId: "seed",
              description: "[DEMO] Invoice sent via PayPal Sandbox (fixture record)",
              metadata: { isDemoData: true },
            },
            {
              workspaceId: DEMO_WORKSPACE_ID,
              invoiceId: "demo-invoice-3",
              eventType: ActivityEventType.INVOICE_STATUS_CHANGED,
              actorType: ActorType.SYSTEM,
              actorId: "seed",
              description: "[DEMO] Invoice moved to OVERDUE (fixture record)",
              metadata: { isDemoData: true, from: "DUE_SOON", to: "OVERDUE" },
            },
            {
              workspaceId: DEMO_WORKSPACE_ID,
              eventType: ActivityEventType.SYSTEM_EVENT,
              actorType: ActorType.USER,
              actorId,
              description:
                "[DEMO RESET] Demo workspace restored to canonical baseline. Note: External PayPal Sandbox invoices are not automatically cancelled on PayPal.",
              metadata: {
                isDemoReset: true,
                unaffectedPayPalInvoicesCount: payPalLinkedCount,
                unaffectedPayPalInvoiceIds: payPalInvoiceIds,
                cleanedExternalOperationsCount: externalOpsCount,
                resetAt: now.toISOString(),
              },
            },
          ],
        });
      },
      {
        timeout: 15000,
      }
    );

    return {
      ok: true,
      data: {
        success: true,
        message:
          "Demo workspace restored to canonical baseline. External PayPal Sandbox invoices were not cancelled.",
        restoredInvoicesCount: CANONICAL_INVOICE_IDS.length,
        restoredClientsCount: CANONICAL_CLIENT_IDS.length,
        removedInvoicesCount: nonCanonicalInvoicesCount,
        removedClientsCount: nonCanonicalClientsCount,
        cleanedExternalOperationsCount: externalOpsCount,
        unaffectedPayPalInvoicesCount: payPalLinkedCount,
        unaffectedPayPalInvoiceIds: payPalInvoiceIds,
        resetAt: now.toISOString(),
      },
    };
  } catch (err) {
    console.error("Demo workspace reset transaction failed:", err);
    return {
      ok: false,
      error: "Failed to reset demo workspace due to database transaction error.",
      code: "TRANSACTION_FAILED",
      status: 500,
    };
  }
}
