/**
 * CashPilot AI — Activity UI Component Tests
 *
 * SRS §4, §5 & UI Design Reference Page 15:
 * Tests the ActivityFeed, InvoiceJourneyTracker, and SecurityExplainerCard rendering.
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { InvoiceJourneyTracker } from "@/components/activity/invoice-journey-tracker";
import { SecurityExplainerCard } from "@/components/activity/security-explainer-card";
import { ActivityEventType, ActorType } from "@prisma/client";
import type {
  ActivityItem,
  InvoiceJourneyTrace,
  InvoiceSelectorOption,
} from "@/lib/services/activity.service";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/activity",
}));

const mockItems: ActivityItem[] = [
  {
    id: "act-1",
    eventType: ActivityEventType.STATUS_SYNC_SUCCESS,
    actorType: ActorType.SYSTEM,
    actorLabel: "System",
    title: "Status refreshed · 4 invoices",
    subtitle: "System · 1 needs review, 1 couldn't be reached",
    description: "Status refreshed · 4 invoices",
    outcomeBadge: { label: "Partial", variant: "partial" },
    createdAt: "2026-10-16T23:24:00.000Z",
    timeFormatted: "23:24",
    dateFormatted: "Oct 16",
    dateGroupKey: "Today · Friday 16 October",
    invoiceId: null,
    invoiceNumber: null,
    clientName: null,
    amountFormatted: null,
    currency: null,
    metadata: {},
  },
  {
    id: "act-2",
    eventType: ActivityEventType.OPERATION_SUCCEEDED,
    actorType: ActorType.USER,
    actorLabel: "You",
    title: "Invoice sent via PayPal · INV-0014",
    subtitle: "You · $1,200.00 to Acme Studio",
    description: "Invoice sent via PayPal · INV-0014",
    outcomeBadge: { label: "Confirmed by PayPal", variant: "confirmed" },
    createdAt: "2026-10-16T23:21:00.000Z",
    timeFormatted: "23:21",
    dateFormatted: "Oct 16",
    dateGroupKey: "Today · Friday 16 October",
    invoiceId: "inv-14",
    invoiceNumber: "INV-0014",
    clientName: "Acme Studio",
    amountFormatted: "$1200.00",
    currency: "USD",
    metadata: {},
  },
];

const mockTrace: InvoiceJourneyTrace = {
  invoiceId: "inv-14",
  invoiceNumber: "INV-0014",
  clientName: "Acme Studio",
  totalMinorUnits: 120000,
  totalFormatted: "$1,200.00",
  currency: "USD",
  cashpilotStatus: "AWAITING_PAYMENT",
  paypalStatus: "SENT",
  paypalInvoiceId: "INV2-3F8N-D2KJ",
  steps: [
    {
      stepNumber: 1,
      title: "Your request",
      summary: '"Website design, $1,200, due in 14 days"',
      status: "completed",
    },
    {
      stepNumber: 2,
      title: "Navi's draft",
      badgeLabel: "AI",
      badgeVariant: "proposed",
      summary: "Email and due date flagged",
      status: "completed",
    },
    {
      stepNumber: 3,
      title: "Your edits",
      summary: "Email added, due date confirmed",
      status: "completed",
    },
    {
      stepNumber: 4,
      title: "Your approval",
      badgeLabel: "You",
      badgeVariant: "approved",
      summary: "23:20 · version a91f…3c2",
      status: "completed",
    },
    {
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "confirmed",
      summary: "23:21 · accepted, status SENT",
      status: "completed",
    },
  ],
};

const mockSelectorOptions: InvoiceSelectorOption[] = [
  {
    id: "inv-14",
    number: "INV-0014",
    clientName: "Acme Studio",
    status: "AWAITING_PAYMENT",
    totalFormatted: "$1,200.00",
  },
];

describe("Activity UI Components (Page 15 Design)", () => {
  it("renders SecurityExplainerCard with invariant guarantees", () => {
    const html = renderToString(<SecurityExplainerCard />);
    expect(html).toContain("What is recorded");
    expect(html).toContain("Never passwords, tokens or card details");
    expect(html).toContain("Append-only log:");
    expect(html).toContain("Exact payload hashes:");
  });

  it("renders InvoiceJourneyTracker with all 5 lifecycle steps", () => {
    const html = renderToString(
      <InvoiceJourneyTracker
        trace={mockTrace}
        selectorOptions={mockSelectorOptions}
        selectedInvoiceId="inv-14"
        onSelectInvoice={() => {}}
      />
    );

    expect(html).toContain("Follow one invoice end to end");
    expect(html).toContain("INV-0014");
    expect(html).toContain("Acme Studio");
    expect(html).toContain("1 Your request");
    expect(html).toContain("Website design, $1,200, due in 14 days");
    expect(html).toContain("2 Navi&#x27;s draft");
    expect(html).toContain("3 Your edits");
    expect(html).toContain("4 Your approval");
    expect(html).toContain("23:20 · version a91f…3c2");
    expect(html).toContain("5 PayPal&#x27;s response");
    expect(html).toContain("23:21 · accepted, status SENT");
  });

  it("renders ActivityFeed with date groupings, filter toolbar, and badges", () => {
    const html = renderToString(
      <ActivityFeed
        initialItems={mockItems}
        initialTrace={mockTrace}
        selectorOptions={mockSelectorOptions}
        workspaceId="demo-ws"
      />
    );

    expect(html).toContain("Activity");
    expect(html).toContain("PayPal Sandbox");
    expect(html).toContain("A permanent record of what was proposed, approved and confirmed");
    expect(html).toContain("Type:");
    expect(html).toContain("Result:");
    expect(html).toContain("Today · Friday 16 October");
    expect(html).toContain("Status refreshed · 4 invoices");
    expect(html).toContain("Partial");
    expect(html).toContain("Invoice sent via PayPal · INV-0014");
    expect(html).toContain("Confirmed by PayPal");
  });
});
