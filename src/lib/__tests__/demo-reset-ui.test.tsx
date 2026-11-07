/**
 * CashPilot AI — Demo Reset UI Component Tests (Phase 3B)
 *
 * Verifies:
 * - AppHeader displays "Reset Demo Data" button when isDemo = true.
 * - AppHeader hides "Reset Demo Data" button when isDemo = false.
 * - DemoResetModal does not render when isOpen = false.
 * - DemoResetModal renders explanation, scope, and PayPal Sandbox notice when isOpen = true.
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { AppHeader } from "@/components/layout/app-header";
import { DemoResetModal } from "@/components/layout/demo-reset-modal";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe("Phase 3B: Demo Reset UI Components", () => {
  describe("AppHeader Demo Reset Integration", () => {
    it("renders Reset Demo Data button when isDemo = true", () => {
      const html = renderToString(
        <AppHeader
          workspaceName="My Freelance Studio"
          isDemo={true}
          user={{ name: "Demo User", email: "demo@cashpilot.test" }}
        />
      );

      expect(html).toContain("Reset Demo Data");
      expect(html).toContain("DEMO WORKSPACE");
      expect(html).toContain("reset-demo-data-btn");
    });

    it("does not render Reset Demo Data button when isDemo = false", () => {
      const html = renderToString(
        <AppHeader
          workspaceName="Production Workspace"
          isDemo={false}
          user={{ name: "Real User", email: "real@customer.com" }}
        />
      );

      expect(html).not.toContain("Reset Demo Data");
      expect(html).not.toContain("reset-demo-data-btn");
      expect(html).not.toContain("DEMO WORKSPACE");
    });
  });

  describe("DemoResetModal Component", () => {
    it("returns null when isOpen = false", () => {
      const html = renderToString(
        <DemoResetModal isOpen={false} onClose={vi.fn()} />
      );

      expect(html).toBe("");
    });

    it("renders modal dialog, warnings, and PayPal notice when isOpen = true", () => {
      const html = renderToString(
        <DemoResetModal isOpen={true} onClose={vi.fn()} />
      );

      // Title & description
      expect(html).toContain("Reset Demo Workspace");
      expect(html).toContain("Restore My Freelance Studio to original seeded state");

      // Scope breakdown
      expect(html).toContain("What will be reset:");
      expect(html).toContain("Any newly drafted or sent demo invoices will be removed.");
      expect(html).toContain("4 canonical demo invoices");

      // PayPal Sandbox Notice (Requirement 9 & 10)
      expect(html).toContain("PayPal Sandbox Notice:");
      expect(html).toContain(
        "Resetting local demo data does not cancel or delete previously sent invoices on PayPal Sandbox."
      );

      // Buttons
      expect(html).toContain("Cancel");
      expect(html).toContain("Confirm Reset Demo Data");
      expect(html).toContain("confirm-demo-reset-btn");
    });
  });

  describe("Detail-Page Navigation Safety (Refinement 3)", () => {
    it("correctly identifies non-canonical invoice detail routes for / redirect", async () => {
      const { isViewingNonCanonicalInvoice } = await import("@/components/layout/demo-reset-modal");

      // Non-canonical invoices that will be deleted upon reset -> must redirect to /
      expect(isViewingNonCanonicalInvoice("/invoices/demo-extra-inv-123")).toBe(true);
      expect(isViewingNonCanonicalInvoice("/invoices/cm890abcdef123")).toBe(true);
      expect(isViewingNonCanonicalInvoice("/invoices/custom-invoice-999")).toBe(true);

      // Canonical invoices that are restored and remain valid -> should refresh, not redirect
      expect(isViewingNonCanonicalInvoice("/invoices/demo-invoice-1")).toBe(false);
      expect(isViewingNonCanonicalInvoice("/invoices/demo-invoice-2")).toBe(false);
      expect(isViewingNonCanonicalInvoice("/invoices/demo-invoice-3")).toBe(false);
      expect(isViewingNonCanonicalInvoice("/invoices/demo-invoice-4")).toBe(false);

      // Non-detail pages -> should refresh, not redirect
      expect(isViewingNonCanonicalInvoice("/invoices")).toBe(false);
      expect(isViewingNonCanonicalInvoice("/invoices/new")).toBe(false);
      expect(isViewingNonCanonicalInvoice("/")).toBe(false);
      expect(isViewingNonCanonicalInvoice("/dashboard")).toBe(false);
      expect(isViewingNonCanonicalInvoice("/clients")).toBe(false);
      expect(isViewingNonCanonicalInvoice("/activity")).toBe(false);
      expect(isViewingNonCanonicalInvoice(null)).toBe(false);
    });
  });
});
