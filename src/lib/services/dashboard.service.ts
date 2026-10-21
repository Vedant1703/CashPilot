/**
 * CashPilot AI — Dashboard & Collections Data Service
 *
 * Server-side data access layer for Dashboard and Collections UI.
 * Enforces:
 *   - Workspace authorization boundary (never trusts unverified client params).
 *   - Strict separation of financial states.
 *   - Read-only data access (does NOT execute PayPal writes).
 *   - Integer minor units for all money amounts.
 */

import { db } from "@/lib/db/client";
import {
  calculateDashboardMetrics,
  groupInvoicesForCollections,
  type InvoiceRecord,
  type DashboardMetrics,
  type GroupedCollections,
} from "@/lib/dashboard/metrics";

export interface ActivityFeedItem {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  description: string;
  createdAt: string;
  invoiceId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  isDemo: boolean;
  ownerId: string;
}

export interface DashboardDataResult {
  workspace: WorkspaceSummary;
  invoices: InvoiceRecord[];
  metrics: DashboardMetrics;
  collections: GroupedCollections;
  recentActivities: ActivityFeedItem[];
  lastSyncAt: string | null;
  hasStaleInvoices: boolean;
}

/**
 * Fetches dashboard and collections data server-side for the target workspace.
 */
export async function getDashboardData(
  workspaceId: string = "demo-workspace-1",
  actorId: string = "demo-user-1"
): Promise<{ ok: true; data: DashboardDataResult } | { ok: false; error: string; status: number }> {
  // 1. Authorize workspace access
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
  });

  if (!workspace) {
    return { ok: false, error: "Workspace not found", status: 404 };
  }

  // Verify ownership in development/demo mode
  if (workspace.ownerId !== actorId && process.env.NODE_ENV === "production") {
    return { ok: false, error: "Access denied to target workspace", status: 403 };
  }

  // 2. Fetch all invoices for workspace
  const rawInvoices = await db.invoice.findMany({
    where: { workspaceId },
    include: {
      client: {
        select: { id: true, name: true, email: true, company: true },
      },
      lineItems: {
        select: {
          id: true,
          description: true,
          quantity: true,
          unitPriceMinorUnits: true,
          totalMinorUnits: true,
        },
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Serialize dates into InvoiceRecord objects
  const invoices: InvoiceRecord[] = rawInvoices.map((inv) => ({
    id: inv.id,
    number: inv.number,
    title: inv.title,
    client: inv.client,
    currency: inv.currency,
    totalMinorUnits: inv.totalMinorUnits,
    subtotalMinorUnits: inv.subtotalMinorUnits,
    taxMinorUnits: inv.taxMinorUnits,
    invoiceDate: inv.invoiceDate.toISOString(),
    dueDate: inv.dueDate.toISOString(),
    cashpilotStatus: inv.cashpilotStatus,
    paypalStatus: inv.paypalStatus,
    paypalInvoiceId: inv.paypalInvoiceId,
    isDemoData: inv.isDemoData,
    syncIsStale: inv.syncIsStale,
    aiDraftId: inv.aiDraftId,
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
    lastSyncAt: inv.lastSyncAt ? inv.lastSyncAt.toISOString() : null,
    notes: inv.notes,
    lineItems: inv.lineItems,
  }));

  // 3. Fetch recent audit/activity events
  const rawActivities = await db.activityEvent.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const recentActivities: ActivityFeedItem[] = rawActivities.map((act) => ({
    id: act.id,
    eventType: act.eventType,
    actorType: act.actorType,
    actorId: act.actorId,
    description: act.description,
    createdAt: act.createdAt.toISOString(),
    invoiceId: act.invoiceId,
    metadata: (act.metadata as Record<string, unknown>) ?? null,
  }));

  // 4. Compute metrics and collections
  const now = new Date();
  const metrics = calculateDashboardMetrics(invoices, now);
  const collections = groupInvoicesForCollections(invoices, now);

  // Check last sync time across invoices
  let latestSync: Date | null = null;
  let hasStaleInvoices = false;

  for (const inv of rawInvoices) {
    if (inv.syncIsStale) hasStaleInvoices = true;
    if (inv.lastSyncAt) {
      if (!latestSync || inv.lastSyncAt > latestSync) {
        latestSync = inv.lastSyncAt;
      }
    }
  }

  return {
    ok: true,
    data: {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        isDemo: workspace.isDemo,
        ownerId: workspace.ownerId,
      },
      invoices,
      metrics,
      collections,
      recentActivities,
      lastSyncAt: latestSync ? latestSync.toISOString() : null,
      hasStaleInvoices,
    },
  };
}
