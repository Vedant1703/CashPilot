/**
 * CashPilot AI — Authentication UI & Header Component Tests (Phase 2D.1)
 *
 * Tests:
 * - LoginForm rendering, fields, links, and structure
 * - SignupForm rendering, fields, hints, and structure
 * - AppHeader user context display (name, email, workspace)
 * - AppHeader sign out action visibility
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { LoginForm } from "@/components/auth/login-form";
import { SignupForm } from "@/components/auth/signup-form";
import { AppHeader } from "@/components/layout/app-header";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe("Authentication UI Components (Phase 2D.1)", () => {
  describe("LoginForm", () => {
    it("renders email and password inputs with proper labels and semantic structure", () => {
      const html = renderToString(<LoginForm />);

      expect(html).toContain("Welcome back");
      expect(html).toContain("Sign in to access your CashPilot receivables studio");
      expect(html).toContain('id="email"');
      expect(html).toContain('type="email"');
      expect(html).toContain('id="password"');
      expect(html).toContain('type="password"');
      expect(html).toContain("Sign in to CashPilot");
      expect(html).toContain('href="/signup"');
      expect(html).toContain("Create an account");
      expect(html).toContain("Explore Demo Workspace");
      expect(html).toContain("Judge &amp; Evaluator Quick Access");
    });
  });

  describe("SignupForm", () => {
    it("renders name, email, business name, and password inputs with complexity hint", () => {
      const html = renderToString(<SignupForm />);

      expect(html).toContain("Create your account");
      expect(html).toContain("Start managing receivables and intelligent collections");
      expect(html).toContain('id="name"');
      expect(html).toContain('id="email"');
      expect(html).toContain('id="businessName"');
      expect(html).toContain('id="password"');
      expect(html).toContain("Must contain upper &amp; lower case, number, and special character");
      expect(html).toContain("Create Account &amp; Workspace");
      expect(html).toContain('href="/login"');
      expect(html).toContain("Sign in");
    });
  });

  describe("AppHeader Navigation & User Profile Context", () => {
    it("renders user name, email, and Sign out button when authenticated user is provided", () => {
      const html = renderToString(
        <AppHeader
          workspaceName="Acme Design Studio"
          isDemo={false}
          user={{
            name: "Alex Morgan",
            email: "alex@acmedesign.test",
          }}
        />
      );

      expect(html).toContain("Acme Design Studio");
      expect(html).toContain("Alex Morgan");
      expect(html).toContain("alex@acmedesign.test");
      expect(html).toContain("Sign out");
      // When isDemo is false, sandbox banner is omitted
      expect(html).not.toContain("PayPal Sandbox");
    });

    it("renders PayPal Sandbox banner and omits Sign out when no user profile is provided", () => {
      const html = renderToString(
        <AppHeader
          workspaceName="My Freelance Studio"
          isDemo={true}
        />
      );

      expect(html).toContain("My Freelance Studio");
      expect(html).toContain("DEMO WORKSPACE");
      expect(html).toContain("PayPal Sandbox");
      expect(html).toContain("No real money moves");
      expect(html).not.toContain("Sign out");
    });
  });
});
