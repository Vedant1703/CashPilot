import React, { Suspense } from "react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { InvoiceDetailView, SerializedInvoiceDetail } from "@/components/invoices/invoice-detail-view";

/**
 * Invoice Detail Page — /invoices/[id]
 *
 * Displays authoritative server-calculated invoice data, client info, line items,
 * and PayPal Sandbox reconciliation status.
 *
 * Consequential financial actions (send, reminder, cancel) are not triggered from here;
 * this page provides read-only inspection and safe status synchronization via POST /api/invoices/[id]/sync.
 *
 * MVP Authentication Limitation:
 * CashPilot uses workspace-scoped sessions for Sandbox verification. Production requires OAuth 2.0 / JWT session auth.
 */

interface InvoiceDetailPageProps {
  params: Promise<{ id: string }>;
}

async function InvoiceDetailContent({ params }: InvoiceDetailPageProps) {
  const { id } = await params;

  if (!id || typeof id !== "string" || id.trim().length === 0) {
    return notFound();
  }

  const invoice = await db.invoice.findUnique({
    where: { id: id.trim() },
    include: {
      workspace: true,
      client: true,
      lineItems: { orderBy: { sortOrder: "asc" } },
      activities: { orderBy: { createdAt: "desc" }, take: 15 },
    },
  });

  if (!invoice) {
    return notFound();
  }

  const serializedInvoice: SerializedInvoiceDetail = {
    id: invoice.id,
    workspaceId: invoice.workspaceId,
    clientId: invoice.clientId,
    number: invoice.number,
    title: invoice.title,
    notes: invoice.notes,
    terms: invoice.terms,
    currency: invoice.currency,
    subtotalMinorUnits: invoice.subtotalMinorUnits,
    taxRateBasisPoints: invoice.taxRateBasisPoints,
    taxMinorUnits: invoice.taxMinorUnits,
    totalMinorUnits: invoice.totalMinorUnits,
    invoiceDate: invoice.invoiceDate.toISOString(),
    dueDate: invoice.dueDate.toISOString(),
    cashpilotStatus: invoice.cashpilotStatus,
    paypalInvoiceId: invoice.paypalInvoiceId,
    paypalStatus: invoice.paypalStatus,
    lastSyncAt: invoice.lastSyncAt ? invoice.lastSyncAt.toISOString() : null,
    syncIsStale: invoice.syncIsStale,
    isDemoData: invoice.isDemoData,
    aiDraftId: invoice.aiDraftId,
    client: {
      id: invoice.client.id,
      name: invoice.client.name,
      email: invoice.client.email,
      company: invoice.client.company,
      phone: invoice.client.phone,
      isDemo: invoice.client.isDemo,
    },
    lineItems: invoice.lineItems.map((li) => ({
      id: li.id,
      description: li.description,
      quantity: li.quantity,
      unitPriceMinorUnits: li.unitPriceMinorUnits,
      totalMinorUnits: li.totalMinorUnits,
      sortOrder: li.sortOrder,
    })),
    activities: invoice.activities.map((act) => ({
      id: act.id,
      eventType: act.eventType,
      actorType: act.actorType,
      actorId: act.actorId,
      description: act.description,
      createdAt: act.createdAt.toISOString(),
      metadata: act.metadata,
    })),
    workspace: {
      id: invoice.workspace.id,
      name: invoice.workspace.name,
      isDemo: invoice.workspace.isDemo,
    },
  };

  return (
    <>
      <AppHeader
        workspaceName={invoice.workspace.name}
        isDemo={invoice.workspace.isDemo}
        lastSyncAt={serializedInvoice.lastSyncAt}
        hasStaleInvoices={invoice.syncIsStale}
      />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <InvoiceDetailView initialInvoice={serializedInvoice} />
      </main>
    </>
  );
}

function InvoiceDetailSkeleton() {
  return (
    <div className="space-y-6 max-w-5xl mx-auto px-4 py-8 animate-pulse" aria-label="Loading invoice details">
      <div className="h-4 w-32 bg-[#E3E8EF] rounded-md" />
      <div className="h-8 w-64 bg-[#E3E8EF] rounded-md" />
      <div className="h-20 w-full bg-[#E3E8EF] rounded-2xl" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="space-y-4">
          <div className="h-32 bg-[#E3E8EF] rounded-2xl" />
          <div className="h-32 bg-[#E3E8EF] rounded-2xl" />
        </div>
        <div className="md:col-span-2 space-y-4">
          <div className="h-64 bg-[#E3E8EF] rounded-2xl" />
          <div className="h-32 bg-[#E3E8EF] rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

export default function InvoiceDetailPage(props: InvoiceDetailPageProps) {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <Suspense fallback={<InvoiceDetailSkeleton />}>
        <InvoiceDetailContent {...props} />
      </Suspense>

      <MobileNav />
    </div>
  );
}
