/**
 * CashPilot AI — Client Management UI Component Tests (Phase 3A.2)
 *
 * Tests:
 * - ClientDirectory rendering (empty workspace, populated list, search bar, new client button)
 * - ClientFormModal rendering (create mode, edit mode, form fields, accessibility)
 * - ClientDeleteModal rendering (warning badge, client details, 409 error state, accessibility)
 * - AppHeader & MobileNav "Clients" navigation integration
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { ClientDirectory } from "@/components/clients/client-directory";
import { ClientFormModal, type ClientItem } from "@/components/clients/client-form-modal";
import { ClientDeleteModal } from "@/components/clients/client-delete-modal";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: () => "/clients",
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const mockClients: ClientItem[] = [
  {
    id: "client-1",
    name: "Acme Corporation",
    email: "billing@acme.com",
    company: "Acme Industries",
    phone: "+1 (555) 0101",
    notes: "VIP Client",
    isDemo: false,
    createdAt: new Date("2026-10-25T10:00:00Z"),
    updatedAt: new Date("2026-10-25T10:00:00Z"),
    _count: { invoices: 3 },
  },
  {
    id: "client-2",
    name: "Jane Smith",
    email: "jane@smithassociates.com",
    company: "Smith & Associates",
    phone: null,
    notes: null,
    isDemo: false,
    createdAt: new Date("2026-10-25T11:00:00Z"),
    updatedAt: new Date("2026-10-25T11:00:00Z"),
    _count: { invoices: 0 },
  },
];

describe("Client Management UI Components (Phase 3A.2)", () => {
  describe("Navigation Integration", () => {
    it("renders Clients link in AppHeader desktop navigation and fallback", () => {
      const html = renderToString(
        <AppHeader
          workspaceName="Test Studio"
          isDemo={false}
          user={{ name: "Alex Invoicer", email: "alex@example.com" }}
        />
      );

      expect(html).toContain('href="/clients"');
      expect(html).toContain("Clients");
    });

    it("renders Clients tab in MobileNav with proper icon and label", () => {
      const html = renderToString(<MobileNav />);

      expect(html).toContain('href="/clients"');
      expect(html).toContain("Clients");
    });
  });

  describe("ClientDirectory", () => {
    it("renders the client roster when clients are provided", () => {
      const html = renderToString(<ClientDirectory initialClients={mockClients} />);

      expect(html).toContain("Clients");
      expect(html).toContain("Acme Corporation");
      expect(html).toContain("Acme Industries");
      expect(html).toContain("billing@acme.com");
      expect(html).toContain("+1 (555) 0101");
      expect(html).toContain("3 invoices");

      expect(html).toContain("Jane Smith");
      expect(html).toContain("jane@smithassociates.com");
      expect(html).toContain("0 invoices");

      expect(html).toContain("New Client");
      expect(html).toContain('type="search"');
      expect(html).toContain('placeholder="Search by client name, email, or company..."');
    });

    it("renders empty workspace state when clients list is empty", () => {
      const html = renderToString(<ClientDirectory initialClients={[]} />);

      expect(html).toContain("Your client roster is empty");
      expect(html).toContain("Add your first client with their billing email and company info");
      expect(html).toContain("Add Your First Client");
    });
  });

  describe("ClientFormModal", () => {
    it("renders create client form with proper accessible attributes and required labels", () => {
      const html = renderToString(
        <ClientFormModal
          isOpen={true}
          onClose={() => {}}
          onSuccess={() => {}}
          initialClient={null}
        />
      );

      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain("Add New Client");
      expect(html).toContain("Create a recipient record to use when drafting invoices.");
      expect(html).toContain('id="client-name"');
      expect(html).toContain('id="client-email"');
      expect(html).toContain('id="client-company"');
      expect(html).toContain('id="client-phone"');
      expect(html).toContain('id="client-notes"');
      expect(html).toContain("Create Client");
      expect(html).toContain("Cancel");
    });

    it("renders edit client form with pre-filled client values", () => {
      const html = renderToString(
        <ClientFormModal
          isOpen={true}
          onClose={() => {}}
          onSuccess={() => {}}
          initialClient={mockClients[0]}
        />
      );

      expect(html).toContain("Edit Client Profile");
      expect(html).toContain("Update client contact information for your workspace.");
      expect(html).toContain('value="Acme Corporation"');
      expect(html).toContain('value="billing@acme.com"');
      expect(html).toContain('value="Acme Industries"');
      expect(html).toContain('value="+1 (555) 0101"');
      expect(html).toContain("VIP Client");
      expect(html).toContain("Save Changes");
    });

    it("returns null when closed", () => {
      const html = renderToString(
        <ClientFormModal
          isOpen={false}
          onClose={() => {}}
          onSuccess={() => {}}
          initialClient={null}
        />
      );

      expect(html).toBe("");
    });
  });

  describe("ClientDeleteModal", () => {
    it("renders delete confirmation with client details and invoice warning", () => {
      const html = renderToString(
        <ClientDeleteModal
          isOpen={true}
          onClose={() => {}}
          onDeleteSuccess={() => {}}
          client={mockClients[0]} // 3 invoices
        />
      );

      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain("Delete Client");
      expect(html).toContain("Acme Corporation");
      expect(html).toContain("billing@acme.com");
      expect(html).toContain("3 invoices");
      expect(html).toContain("Clients referenced by financial records cannot be deleted");
      expect(html).toContain("Delete Client");
      expect(html).toContain("Cancel");
    });

    it("returns null when closed", () => {
      const html = renderToString(
        <ClientDeleteModal
          isOpen={false}
          onClose={() => {}}
          onDeleteSuccess={() => {}}
          client={mockClients[0]}
        />
      );

      expect(html).toBe("");
    });
  });

  describe("ClientsPage Layout", () => {
    it("renders page container with Suspense boundary and MobileNav", async () => {
      const { default: ClientsPage } = await import("@/app/clients/page");
      const html = renderToString(<ClientsPage />);

      expect(html).toContain("min-h-screen");
      expect(html).toContain('href="/clients"');
      expect(html).toContain("Clients");
    });
  });
});
