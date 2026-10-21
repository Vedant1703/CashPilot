import React, { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { StatusBadge } from "@/components/invoices/status-badge";
import { formatMoney } from "@/lib/money";
import { getInvoiceProvenance } from "@/lib/dashboard/metrics";
import {
  ArrowLeft,
  Building,
  Mail,
  ShieldCheck,
  Info,
} from "lucide-react";

interface InvoiceDetailPageProps {
  params: Promise<{ id: string }>;
}

async function InvoiceDetailContent({ params }: InvoiceDetailPageProps) {
  const { id } = await params;

  const invoice = await db.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      lineItems: { orderBy: { sortOrder: "asc" } },
      activities: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!invoice) {
    return notFound();
  }

  const provenance = getInvoiceProvenance({
    ...invoice,
    invoiceDate: invoice.invoiceDate.toISOString(),
    dueDate: invoice.dueDate.toISOString(),
  });

  const formattedTotal = formatMoney(invoice.totalMinorUnits, invoice.currency);
  const formattedSubtotal = formatMoney(invoice.subtotalMinorUnits, invoice.currency);
  const formattedTax = formatMoney(invoice.taxMinorUnits, invoice.currency);

  return (
    <div className="space-y-6">
      {/* Navigation Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-[#5E718D]">
        <Link href="/" className="hover:text-[#12263F]">
          Dashboard
        </Link>
        <span>/</span>
        <Link href="/collections" className="hover:text-[#12263F]">
          Collections
        </Link>
        <span>/</span>
        <span className="font-mono text-[#12263F] font-semibold">
          {invoice.number ?? invoice.id.slice(0, 10)}
        </span>
      </div>

      {/* Invoice Title & Status Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E3E8EF]">
        <div>
          <div className="flex flex-wrap items-center gap-2.5 mb-1.5">
            <h1 className="font-headline font-bold text-2xl sm:text-3xl text-[#12263F]">
              {invoice.number ?? "Invoice"}
            </h1>
            <StatusBadge status={invoice.cashpilotStatus} />
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${provenance.badgeClass}`}
            >
              <span className="font-mono text-[10px]" aria-hidden="true">
                {provenance.symbol}
              </span>
              <span>{provenance.label}</span>
            </span>
          </div>
          {invoice.title && (
            <p className="text-sm text-[#5E718D]">{invoice.title}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/collections"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#E3E8EF] bg-white hover:bg-[#F6F5F1] text-xs font-semibold text-[#12263F] shadow-xs transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to board</span>
          </Link>
        </div>
      </div>

      {/* Informational Guidance Notice */}
      <div className="p-4 rounded-xl bg-[#F0EEFF]/60 border border-[#CDC4FF] text-[#5B3FD0] text-xs flex items-start gap-3">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <p className="font-semibold text-[#12263F]">Read-Only Financial Inspection View</p>
          <p className="text-[#5E718D]">
            This view displays verified invoice data, line items, and provider status. Consequential workflow operations (Approve, Send, Remind, Cancel) require independent human approval gates.
          </p>
        </div>
      </div>

      {/* Two-Column Details Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Client & Dates Info — 1 col */}
        <div className="space-y-4">
          <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs space-y-4">
            <h3 className="font-semibold text-xs tracking-wider uppercase text-[#5E718D]">
              Client & Recipient
            </h3>

            <div className="space-y-2 text-xs">
              <div className="font-semibold text-sm text-[#12263F]">
                {invoice.client.name}
              </div>

              <div className="flex items-center gap-2 text-[#5E718D]">
                <Mail className="w-3.5 h-3.5 shrink-0" />
                <span className="font-mono truncate">{invoice.client.email}</span>
              </div>

              {invoice.client.company && (
                <div className="flex items-center gap-2 text-[#5E718D]">
                  <Building className="w-3.5 h-3.5 shrink-0" />
                  <span>{invoice.client.company}</span>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs space-y-3 text-xs">
            <h3 className="font-semibold text-xs tracking-wider uppercase text-[#5E718D]">
              Invoice Dates & Terms
            </h3>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D]">Issued Date:</span>
              <span className="font-mono font-medium">
                {new Date(invoice.invoiceDate).toLocaleDateString()}
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D]">Due Date:</span>
              <span className="font-mono font-medium">
                {new Date(invoice.dueDate).toLocaleDateString()}
              </span>
            </div>

            {invoice.terms && (
              <div className="flex justify-between py-1">
                <span className="text-[#5E718D]">Terms:</span>
                <span className="font-medium">{invoice.terms}</span>
              </div>
            )}
          </div>

          {/* Provider Status Separation */}
          <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs space-y-3 text-xs">
            <h3 className="font-semibold text-xs tracking-wider uppercase text-[#5E718D]">
              PayPal Sandbox State
            </h3>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D]">Provider ID:</span>
              <span className="font-mono text-[11px] font-semibold text-[#12263F]">
                {invoice.paypalInvoiceId ?? "Not created in PayPal"}
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D]">Provider Status:</span>
              <span className="font-mono font-medium text-[#12263F]">
                {invoice.paypalStatus ?? "None"}
              </span>
            </div>

            <div className="flex justify-between py-1">
              <span className="text-[#5E718D]">Sync State:</span>
              <span className={invoice.syncIsStale ? "text-[#B4440B] font-semibold" : "text-[#0C7C61] font-medium"}>
                {invoice.syncIsStale ? "Sync Stale" : "Synchronized"}
              </span>
            </div>
          </div>
        </div>

        {/* Line Items & Authoritative Totals — 2 cols */}
        <div className="md:col-span-2 space-y-6">
          <div className="rounded-2xl bg-white border border-[#E3E8EF] shadow-xs overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-[#E3E8EF]">
              <h3 className="font-semibold text-sm text-[#12263F]">
                Line Items & Financial Calculation
              </h3>
              <p className="text-xs text-[#5E718D] mt-0.5">
                Authoritative line items and totals calculated server-side
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-[#F6F5F1] text-[11px] font-semibold text-[#5E718D] uppercase tracking-wider border-b border-[#E3E8EF]">
                  <tr>
                    <th className="py-2.5 px-4 sm:px-6">Description</th>
                    <th className="py-2.5 px-4 text-center">Qty</th>
                    <th className="py-2.5 px-4 text-right">Unit Price</th>
                    <th className="py-2.5 px-4 sm:px-6 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EEF2F6]">
                  {invoice.lineItems.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-xs text-[#5E718D]">
                        No line items.
                      </td>
                    </tr>
                  ) : (
                    invoice.lineItems.map((item) => (
                      <tr key={item.id}>
                        <td className="py-3 px-4 sm:px-6 font-medium text-[#12263F]">
                          {item.description}
                        </td>
                        <td className="py-3 px-4 text-center font-mono tabular-nums text-[#5E718D]">
                          {item.quantity}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-[#5E718D]">
                          {formatMoney(item.unitPriceMinorUnits, invoice.currency)}
                        </td>
                        <td className="py-3 px-4 sm:px-6 text-right font-mono font-semibold tabular-nums text-[#12263F]">
                          {formatMoney(item.totalMinorUnits, invoice.currency)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Authoritative Totals Summary */}
            <div className="p-4 sm:p-6 bg-[#F6F5F1]/40 border-t border-[#E3E8EF] flex justify-end">
              <div className="w-full max-w-xs space-y-2 text-xs">
                <div className="flex justify-between text-[#5E718D]">
                  <span>Subtotal:</span>
                  <span className="font-mono tabular-nums">{formattedSubtotal}</span>
                </div>

                {invoice.taxMinorUnits > 0 && (
                  <div className="flex justify-between text-[#5E718D]">
                    <span>Tax ({(invoice.taxRateBasisPoints / 100).toFixed(1)}%):</span>
                    <span className="font-mono tabular-nums">{formattedTax}</span>
                  </div>
                )}

                <div className="flex justify-between pt-2 border-t border-[#E3E8EF] font-bold text-sm text-[#12263F]">
                  <span>Grand Total:</span>
                  <span className="font-mono tabular-nums text-base text-[#0C7C61]">
                    {formattedTotal}
                  </span>
                </div>
                <p className="text-[10px] text-[#5E718D] text-right italic pt-1">
                  Totals are calculated by the app, never by AI.
                </p>
              </div>
            </div>
          </div>

          {/* Audit Trail for this Invoice */}
          <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs space-y-3">
            <h3 className="font-semibold text-xs tracking-wider uppercase text-[#5E718D]">
              Audit Activity History
            </h3>

            {invoice.activities.length === 0 ? (
              <p className="text-xs text-[#5E718D] italic py-2">
                No activity events recorded for this invoice yet.
              </p>
            ) : (
              <div className="divide-y divide-[#EEF2F6]">
                {invoice.activities.map((act) => (
                  <div key={act.id} className="py-2.5 flex items-start gap-2.5 text-xs">
                    <ShieldCheck className="w-4 h-4 text-[#0C7C61] shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-[#12263F] font-medium">{act.description}</p>
                      <p className="text-[11px] text-[#5E718D]">
                        {new Date(act.createdAt).toLocaleString()} · {act.actorType.toLowerCase()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function InvoiceDetailPage(props: InvoiceDetailPageProps) {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <AppHeader />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <Suspense
          fallback={
            <div className="p-8 text-center text-xs text-[#5E718D] animate-pulse">
              Loading invoice details...
            </div>
          }
        >
          <InvoiceDetailContent {...props} />
        </Suspense>
      </main>

      <MobileNav />
    </div>
  );
}
