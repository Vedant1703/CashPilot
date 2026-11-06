/**
 * CashPilot AI — Pagination UI Component Tests
 *
 * Validates pagination behavior across:
 * - InvoiceTable (/invoices): 15-item slicing, range indicators, Previous/Next navigation controls.
 * - ClientDirectory (/clients): 12-item slicing, range indicators, Next/Previous controls.
 * - ActivityFeed (/activity): Incremental loading trigger ("Load earlier events") and completion indicator.
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { InvoiceTable } from "@/components/collections/invoice-table";
import { ClientDirectory } from "@/components/clients/client-directory";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { CashPilotStatus, ActivityEventType, ActorType } from "@prisma/client";
import type { InvoiceRecord } from "@/lib/dashboard/metrics";
import type { ClientItem } from "@/components/clients/client-form-modal";
import type { ActivityItem } from "@/lib/services/activity.service";

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

describe("Pagination UI Components", () => {
  describe("InvoiceTable Pagination (/invoices)", () => {
    function generateMockInvoices(count: number): InvoiceRecord[] {
      return Array.from({ length: count }, (_, i) => ({
        id: `inv-${i + 1}`,
        number: `INV-${String(i + 1).padStart(4, "0")}`,
        title: `Project Service #${i + 1}`,
        totalMinorUnits: (i + 1) * 10000,
        currency: "USD",
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paypalStatus: "SENT",
        paypalInvoiceId: `PAYPAL-INV-${i + 1}`,
        invoiceDate: new Date("2026-10-01"),
        dueDate: new Date("2026-10-31"),
        isDemoData: false,
        syncIsStale: false,
        aiDraftId: null,
        client: {
          id: `client-${i + 1}`,
          name: `Client #${i + 1}`,
          email: `client${i + 1}@example.com`,
          company: `Company #${i + 1}`,
        },
      }));
    }

    it("renders all rows without pagination bar when invoices count is <= 15", () => {
      const invoices = generateMockInvoices(10);
      const html = renderToString(<InvoiceTable invoices={invoices} />);

      expect(html).toContain("INV-0001");
      expect(html).toContain("INV-0010");
      expect(html).not.toContain("Invoice table pagination");
      expect(html).not.toContain("Showing 1 to 10 of 10 invoices");
    });

    it("slices to first 15 items and renders pagination controls when count exceeds 15", () => {
      const invoices = generateMockInvoices(35);
      const html = renderToString(<InvoiceTable invoices={invoices} />);

      // First page items should appear
      expect(html).toContain("INV-0001");
      expect(html).toContain("INV-0015");

      // Items from subsequent pages should not appear in initial render
      expect(html).not.toContain("INV-0016");
      expect(html).not.toContain("INV-0035");

      // Pagination controls and range summary
      expect(html).toContain("Invoice table pagination");
      expect(html).toContain("Showing");
      expect(html).toContain("1");
      expect(html).toContain("to");
      expect(html).toContain("15");
      expect(html).toContain("35");
      expect(html).toContain("Previous");
      expect(html).toContain("Next");
    });
  });

  describe("ClientDirectory Pagination (/clients)", () => {
    function generateMockClients(count: number): ClientItem[] {
      return Array.from({ length: count }, (_, i) => ({
        id: `client-${i + 1}`,
        name: `Acme Corp ${String(i + 1).padStart(2, "0")}`,
        email: `contact${i + 1}@acme.com`,
        company: `Acme Holding ${i + 1}`,
        phone: "+1 555 0100",
        notes: null,
        isDemo: false,
        createdAt: new Date("2026-10-01T00:00:00Z"),
        updatedAt: new Date("2026-10-01T00:00:00Z"),
        _count: { invoices: 1 },
      }));
    }

    it("renders all cards without pagination footer when client count is <= 12", () => {
      const clients = generateMockClients(8);
      const html = renderToString(<ClientDirectory initialClients={clients} />);

      expect(html).toContain("Acme Corp 01");
      expect(html).toContain("Acme Corp 08");
      expect(html).not.toContain("Clients pagination");
    });

    it("slices to first 12 clients and displays pagination navigation when count > 12", () => {
      const clients = generateMockClients(25);
      const html = renderToString(<ClientDirectory initialClients={clients} />);

      // First page clients
      expect(html).toContain("Acme Corp 01");
      expect(html).toContain("Acme Corp 12");

      // Later page clients should not appear
      expect(html).not.toContain("Acme Corp 13");
      expect(html).not.toContain("Acme Corp 25");

      // Pagination controls
      expect(html).toContain("Clients pagination");
      expect(html).toContain("Showing");
      expect(html).toContain("1");
      expect(html).toContain("to");
      expect(html).toContain("12");
      expect(html).toContain("25");
      expect(html).toContain("Previous");
      expect(html).toContain("Next");
    });
  });

  describe("ActivityFeed Incremental Pagination (/activity)", () => {
    const mockItem: ActivityItem = {
      id: "act-test",
      eventType: ActivityEventType.OPERATION_SUCCEEDED,
      actorType: ActorType.USER,
      actorLabel: "You",
      title: "Invoice sent via PayPal · INV-0001",
      subtitle: "You · $500.00 to Studio",
      description: "Invoice sent",
      outcomeBadge: { label: "Confirmed by PayPal", variant: "confirmed" },
      createdAt: "2026-10-20T12:00:00.000Z",
      timeFormatted: "12:00",
      dateFormatted: "Oct 20",
      dateGroupKey: "Tuesday 20 October",
      invoiceId: "inv-1",
      invoiceNumber: "INV-0001",
      clientName: "Studio",
      amountFormatted: "$500.00",
      currency: "USD",
      metadata: {},
    };

    it("renders 'Load earlier events' button when initialHasMore is true", () => {
      const html = renderToString(
        <ActivityFeed
          initialItems={[mockItem]}
          initialTotalCount={45}
          initialHasMore={true}
          initialTrace={null}
          selectorOptions={[]}
          workspaceId="ws-1"
        />
      );

      expect(html).toContain("Load earlier events");
      expect(html).toMatch(/1.*of.*45/);
    });

    it("renders completion message when initialHasMore is false", () => {
      const html = renderToString(
        <ActivityFeed
          initialItems={[mockItem]}
          initialTotalCount={1}
          initialHasMore={false}
          initialTrace={null}
          selectorOptions={[]}
          workspaceId="ws-1"
        />
      );

      expect(html).not.toContain("Load earlier events");
      expect(html).toContain("You have reached the beginning of activity history.");
    });
  });
});
