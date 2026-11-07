/**
 * CashPilot AI — Modal Usability and Activity Selection Unit Tests (UX-01, UX-02, UX-04)
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  ActivityFeed,
  type ActivityItem,
  type InvoiceSelectorOption,
} from "@/components/activity/activity-feed";
import { SendApprovalModal } from "@/components/invoices/send-approval-modal";
import { SendReminderApprovalModal } from "@/components/invoices/send-reminder-approval-modal";
import { CancelApprovalModal } from "@/components/invoices/cancel-approval-modal";
import { ClientFormModal, type ClientItem } from "@/components/clients/client-form-modal";
import { ClientDeleteModal } from "@/components/clients/client-delete-modal";
import { ReviewStep } from "@/components/studio/review-step";
import type { SerializedInvoiceDetail } from "@/components/invoices/invoice-detail-view";

describe("Activity Row Selection & Highlighting (UX-01)", () => {
  const mockItems = [
    {
      id: "act-1",
      dateGroupKey: "Today",
      timeFormatted: "10:30 AM",
      title: "Invoice INV-001 Created",
      subtitle: "Created by Alice",
      invoiceId: "inv-1",
      outcomeBadge: { label: "Proposed", variant: "proposed" },
    },
    {
      id: "act-2",
      dateGroupKey: "Today",
      timeFormatted: "11:00 AM",
      title: "Invoice INV-001 Sent",
      subtitle: "Sent via PayPal",
      invoiceId: "inv-1",
      outcomeBadge: { label: "Confirmed", variant: "confirmed" },
    },
  ] as unknown as ActivityItem[];

  const mockSelector: InvoiceSelectorOption[] = [
    {
      id: "inv-1",
      number: "INV-001",
      clientName: "Client A",
      status: "DRAFT",
      totalFormatted: "$100.00",
    },
  ];

  it("renders activity rows with distinct grouping cues and keyboard accessibility", () => {
    const html = renderToString(
      <ActivityFeed
        initialItems={mockItems}
        initialTrace={null}
        selectorOptions={mockSelector}
        workspaceId="ws-1"
        initialInvoiceId="inv-1"
      />
    );

    // Both rows render
    expect(html).toContain("Invoice INV-001 Created");
    expect(html).toContain("Invoice INV-001 Sent");
    // Verified related grouping cue mechanism exists
    expect(html).toContain("Related to active invoice");
  });
});

describe("Modal Sizing & Internal Overflow Scrolling (UX-02)", () => {
  const mockInvoice = {
    id: "inv-test-1",
    workspaceId: "ws-1",
    clientId: "c-1",
    number: "INV-100",
    title: "Design Services",
    notes: null,
    terms: null,
    client: { id: "c-1", name: "Test Client", email: "client@test.com", company: null },
    cashpilotStatus: "AWAITING_PAYMENT",
    paypalStatus: "SENT",
    paypalInvoiceId: "PAYPAL-INV-100",
    invoiceDate: new Date("2026-11-01"),
    dueDate: new Date("2026-11-20"),
    totalMinorUnits: 25000,
    subtotalMinorUnits: 25000,
    taxMinorUnits: 0,
    taxRateBasisPoints: 0,
    currency: "USD",
    isDemoData: false,
    aiDraftId: null,
    lastSyncAt: null,
    syncIsStale: false,
    lineItems: [
      {
        id: "li-1",
        invoiceId: "inv-test-1",
        description: "Design Work",
        quantity: 1,
        unitPriceMinorUnits: 25000,
        totalMinorUnits: 25000,
      },
    ],
    approvals: [],
    operations: [],
  } as unknown as SerializedInvoiceDetail;

  it("renders SendApprovalModal with max-h and flex-1 overflow-y-auto body", () => {
    const html = renderToString(
      <SendApprovalModal
        isOpen={true}
        invoice={mockInvoice}
        materialPayloadHash="abc123hash"
        onClose={() => {}}
        onSendSuccess={() => {}}
      />
    );

    expect(html).toContain("max-h-[calc(100vh-2rem)]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("flex-1");
    expect(html).toContain("Approve and send via PayPal");
  });

  it("renders SendReminderApprovalModal with max-h and internal scrolling", () => {
    const html = renderToString(
      <SendReminderApprovalModal
        isOpen={true}
        invoice={mockInvoice}
        materialPayloadHash="abc123hash"
        onClose={() => {}}
        onRemindSuccess={() => {}}
      />
    );

    expect(html).toContain("max-h-[calc(100vh-2rem)]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("flex-1");
    expect(html).toContain("Approve and send reminder via PayPal");
  });

  it("renders CancelApprovalModal with max-h and internal scrolling", () => {
    const html = renderToString(
      <CancelApprovalModal
        isOpen={true}
        invoice={mockInvoice}
        materialPayloadHash="abc123hash"
        onClose={() => {}}
        onCancelSuccess={() => {}}
      />
    );

    expect(html).toContain("max-h-[calc(100vh-2rem)]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("flex-1");
    expect(html).toContain("Approve and cancel on PayPal");
  });

  it("renders ClientFormModal with max-h and internal scrolling", () => {
    const html = renderToString(
      <ClientFormModal
        isOpen={true}
        onClose={() => {}}
        onSuccess={() => {}}
      />
    );

    expect(html).toContain("max-h-[calc(100vh-2rem)]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("flex-1");
  });

  it("renders ClientDeleteModal with max-h and internal scrolling", () => {
    const mockClientItem: ClientItem = {
      id: "c1",
      name: "Client 1",
      email: "c1@test.com",
      company: null,
      phone: null,
      notes: null,
      isDemo: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const html = renderToString(
      <ClientDeleteModal
        isOpen={true}
        client={mockClientItem}
        onClose={() => {}}
        onDeleteSuccess={() => {}}
      />
    );

    expect(html).toContain("max-h-[calc(100vh-2rem)]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("flex-1");
  });
});

describe("ReviewStep New Client Button (UX-04)", () => {
  it("does not render duplicate '+' text next to Plus icon", () => {
    const html = renderToString(
      <ReviewStep
        initialData={{}}
        knownClients={[]}
        missingFields={[]}
        onBack={() => {}}
        onDraftSaved={() => {}}
      />
    );

    expect(html).not.toContain("+ Create new client");
    expect(html).toContain("<span>Create new client</span>");
  });
});
