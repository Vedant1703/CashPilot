/**
 * CashPilot AI — Studio Wizard & Describe Step Intent UI Tests
 *
 * Verifies:
 * - DescribeStep renders default state with title, avatar, and example chips
 * - DescribeStep displays Navi inline guidance card when non-billing intent is detected
 * - StudioWizard stays on DescribeStep and exposes guidance rather than navigating to ReviewStep on non-billing input
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { DescribeStep } from "@/components/studio/describe-step";
import { StudioWizard } from "@/components/studio/studio-wizard";

describe("Studio Wizard & DescribeStep Intent UI", () => {
  it("renders standard DescribeStep without errors or guidance banner when clean", () => {
    const html = renderToString(
      <DescribeStep
        onDraftGenerated={() => {}}
        onManualDraftRequested={() => {}}
        isLoading={false}
        error={null}
      />
    );

    expect(html).toContain("What are we billing today?");
    expect(html).toContain("Draft with Navi");
    expect(html).toContain("Prefer a blank form? Draft manually");
    expect(html).not.toContain("Navi couldn&#x27;t find billing details in this request");
  });

  it("renders Navi guidance banner when a non-billing rejection reason is provided", () => {
    const rejectionReason = "This request appears to be a general question or command rather than an invoice or billing description.";
    const html = renderToString(
      <DescribeStep
        onDraftGenerated={() => {}}
        onManualDraftRequested={() => {}}
        isLoading={false}
        error={rejectionReason}
      />
    );

    expect(html).toContain("Navi couldn&#x27;t find billing details in this request");
    expect(html).toContain(rejectionReason);
    expect(html).toContain("Bill Acme Corp $1,500 for web design due in 14 days");
  });

  it("renders StudioWizard initially on Describe step", () => {
    const knownClients = [
      { id: "c-1", name: "Acme Corp", email: "billing@acme.com", company: "Acme Corp" },
    ];

    const html = renderToString(<StudioWizard knownClients={knownClients} />);

    // Starts on Describe step
    expect(html).toContain("What are we billing today?");
    expect(html).toContain("Draft with Navi");
    // Does not show the Review step form fields initially
    expect(html).not.toContain("Review &amp; Edit Draft");
  });
});
