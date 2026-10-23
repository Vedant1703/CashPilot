import React, { Suspense } from "react";
import { Metadata } from "next";
import Link from "next/link";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { InvoiceTable } from "@/components/collections/invoice-table";
import { CollectionsSkeleton } from "@/components/collections/collections-skeleton";
import { getDashboardData } from "@/lib/services/dashboard.service";
import { Plus, AlertCircle, ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Invoices | CashPilot",
  description: "View and manage all invoices across every lifecycle stage.",
};

interface InvoicesPageProps {
  searchParams?: Promise<{
    filter?: string;
  }>;
}

async function InvoicesContent({ searchParams }: InvoicesPageProps) {
  const params = await searchParams;
  const result = await getDashboardData("demo-workspace-1", "demo-user-1");

  if (!result.ok) {
    return (
      <>
        <AppHeader />
        <main className="flex-1 max-w-4xl mx-auto px-4 py-16 flex flex-col items-center justify-center text-center">
          <div className="p-5 rounded-2xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] max-w-md">
            <AlertCircle className="w-8 h-8 mx-auto mb-2" />
            <h2 className="font-semibold text-base mb-1">Failed to load invoices</h2>
            <p className="text-xs text-[#5E718D]">{result.error}</p>
          </div>
        </main>
      </>
    );
  }

  const { workspace, invoices, lastSyncAt, hasStaleInvoices } = result.data;

  // Map query-string filter param to InvoiceTable initialFilter
  let initialFilter = "ALL";
  const filterParam = params?.filter?.toUpperCase();
  if (filterParam === "DRAFT") initialFilter = "DRAFT";
  else if (filterParam === "AWAITING") initialFilter = "AWAITING_PAYMENT";
  else if (filterParam === "DUE_SOON") initialFilter = "DUE_SOON";
  else if (filterParam === "OVERDUE") initialFilter = "OVERDUE";
  else if (filterParam === "PAID") initialFilter = "PAID";
  else if (filterParam === "NEEDS_REVIEW") initialFilter = "NEEDS_REVIEW";

  return (
    <>
      <AppHeader
        workspaceName={workspace.name}
        isDemo={workspace.isDemo}
        lastSyncAt={lastSyncAt}
        hasStaleInvoices={hasStaleInvoices}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link
                href="/"
                className="text-xs text-[#5E718D] hover:text-[#12263F] flex items-center gap-1 font-medium"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Dashboard</span>
              </Link>
              <span className="text-xs text-[#5E718D]">/</span>
              <span className="text-xs text-[#12263F] font-semibold">Invoices</span>
            </div>

            <h1 className="font-headline font-bold text-2xl sm:text-3xl text-[#12263F] tracking-tight">
              Invoices
            </h1>
            <p className="text-xs text-[#5E718D] mt-1">
              Complete invoice directory — search, filter and open any invoice across all lifecycle stages.
            </p>
          </div>

          <Link
            href="/invoices/new"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#0C7C61] hover:bg-[#096851] text-white text-xs font-semibold shadow-xs transition-colors touch-target self-start sm:self-auto"
          >
            <Plus className="w-4 h-4 stroke-[2.5]" />
            <span>New invoice</span>
          </Link>
        </div>

        {/* Invoice Directory Table */}
        <InvoiceTable invoices={invoices} initialFilter={initialFilter} />
      </main>
    </>
  );
}

function InvoicesLoadingShell() {
  return (
    <>
      <AppHeader />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <CollectionsSkeleton />
      </main>
    </>
  );
}

export default function InvoicesPage(props: InvoicesPageProps) {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <Suspense fallback={<InvoicesLoadingShell />}>
        <InvoicesContent {...props} />
      </Suspense>

      {/* Mobile Bottom Navigation Bar */}
      <MobileNav />
    </div>
  );
}
