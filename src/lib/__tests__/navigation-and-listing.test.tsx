/**
 * CashPilot AI — Navigation & Listing Unit Tests (UX-03, UX-05, UX-06)
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { calculateDashboardMetrics } from "@/lib/dashboard/metrics";
import { StageBreakdown } from "@/components/dashboard/stage-breakdown";
import { InvoiceTable } from "@/components/collections/invoice-table";
import { ClientDirectory } from "@/components/clients/client-directory";
import { CashPilotStatus } from "@prisma/client";
import type { InvoiceRecord } from "@/lib/dashboard/metrics";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: () => "/invoices",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

describe("Dashboard KPI Card Navigation (UX-03)", () => {
  const mockInvoices: InvoiceRecord[] = [
    {
      id: "inv-1",
      number: "INV-001",
      title: "Services",
      totalMinorUnits: 10000,
      currency: "USD",
      cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
      paypalStatus: "SENT",
      paypalInvoiceId: "PAY-1",
      invoiceDate: new Date("2026-11-01"),
      dueDate: new Date("2026-11-20"),
      isDemoData: false,
      syncIsStale: false,
      aiDraftId: null,
      client: { id: "c1", name: "Client A", email: "a@test.com", company: null },
    },
    {
      id: "inv-2",
      number: "INV-002",
      title: "Consulting",
      totalMinorUnits: 20000,
      currency: "USD",
      cashpilotStatus: CashPilotStatus.OVERDUE,
      paypalStatus: "SENT",
      paypalInvoiceId: "PAY-2",
      invoiceDate: new Date("2026-10-01"),
      dueDate: new Date("2026-10-15"),
      isDemoData: false,
      syncIsStale: false,
      aiDraftId: null,
      client: { id: "c2", name: "Client B", email: "b@test.com", company: null },
    },
    {
      id: "inv-3",
      number: "INV-003",
      title: "Design",
      totalMinorUnits: 15000,
      currency: "USD",
      cashpilotStatus: CashPilotStatus.PAID,
      paypalStatus: "PAID",
      paypalInvoiceId: "PAY-3",
      invoiceDate: new Date("2026-10-10"),
      dueDate: new Date("2026-10-25"),
      isDemoData: false,
      syncIsStale: false,
      aiDraftId: null,
      client: { id: "c3", name: "Client C", email: "c@test.com", company: null },
    },
  ];

  it("routes KPI cards to filtered invoice lists instead of collections", () => {
    const metrics = calculateDashboardMetrics(mockInvoices, new Date("2026-11-07"));

    expect(metrics.outstanding.href).toBe("/invoices?status=unpaid");
    expect(metrics.overdue.href).toBe("/invoices?status=overdue");
    expect(metrics.dueSoon.href).toBe("/invoices?status=due_soon");
    expect(metrics.paidThisMonth.href).toBe("/invoices?status=paid");
  });

  it("routes StageBreakdown cards to filtered invoices", () => {
    const metrics = calculateDashboardMetrics(mockInvoices, new Date("2026-11-07"));
    const html = renderToString(<StageBreakdown breakdown={metrics.stageBreakdown} />);

    expect(html).toContain('href="/invoices?status=overdue"');
    expect(html).toContain('href="/invoices?status=unpaid"');
    expect(html).not.toContain('href="/collections?stage=overdue"');
    expect(html).not.toContain('href="/collections?stage=awaiting"');
  });
});

describe("Invoice Table Issue Date Column (UX-05)", () => {
  const mockInvoices: InvoiceRecord[] = [
    {
      id: "inv-1",
      number: "INV-001",
      title: "Services",
      totalMinorUnits: 10000,
      currency: "USD",
      cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
      paypalStatus: "SENT",
      paypalInvoiceId: "PAY-1",
      invoiceDate: new Date("2026-11-01"),
      dueDate: new Date("2026-11-20"),
      isDemoData: false,
      syncIsStale: false,
      aiDraftId: null,
      client: { id: "c1", name: "Acme Corp", email: "a@test.com", company: null },
    },
  ];

  it("renders Issue Date table header and cell with formatted date", () => {
    const html = renderToString(<InvoiceTable invoices={mockInvoices} />);

    // Header exists and is sortable
    expect(html).toContain("Issue Date");
    expect(html).toContain("Due Date");

    // Formatted Issue Date appears in cell (Nov 1, 2026)
    expect(html).toContain("Nov 1, 2026");
  });
});

describe("Client Row Navigation to Invoices (UX-06)", () => {
  const mockClients = [
    {
      id: "c-1",
      name: "Acme Corporation",
      email: "billing@acme.com",
      company: "Acme Industries",
      phone: "+1 555 0100",
      notes: null,
      isDemo: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _count: { invoices: 3 },
    },
  ];

  it("renders 'Invoices' action button linking to filtered invoices for that client", () => {
    const html = renderToString(<ClientDirectory initialClients={mockClients} />);

    // Links to filtered /invoices?q=Acme%20Corporation
    expect(html).toContain('href="/invoices?q=Acme%20Corporation"');
    expect(html).toContain("Invoices");
  });
});
