/**
 * CashPilot AI — PayPal Status Mapper Tests
 *
 * SRS §5: Status and financial truth
 * Tests cover:
 *   - Every known PayPal status → CashPilot status mapping
 *   - Unknown/unmapped statuses → NEEDS_REVIEW (never PAID)
 *   - Null/undefined status → NEEDS_REVIEW
 *   - DUE_SOON / OVERDUE refinement based on due date
 *   - PAID only from provider evidence (PayPal "PAID" status)
 *   - MARKED_AS_PAID → NEEDS_REVIEW (not auto-verified)
 */

import { describe, it, expect } from "vitest";
import {
  mapPayPalStatusToCashPilot,
  canSendToPayPal,
  canSendReminder,
  canCancelInvoice,
} from "@/lib/paypal/status-mapper";
import { CashPilotStatus } from "@prisma/client";

const now = new Date("2026-10-15T12:00:00Z");
const dueFarFuture = new Date("2026-12-01T00:00:00Z");
const dueSoon = new Date("2026-10-20T00:00:00Z"); // 5 days away
const duePast = new Date("2026-10-01T00:00:00Z");  // 14 days ago

describe("mapPayPalStatusToCashPilot", () => {
  // ── DRAFT ───────────────────────────────────────────────────────────────
  it("maps DRAFT to DRAFT", () => {
    const result = mapPayPalStatusToCashPilot("DRAFT", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.DRAFT);
    expect(result.isKnownStatus).toBe(true);
  });

  // ── SENT / AWAITING_PAYMENT with due-date refinement ─────────────────
  it("maps SENT to AWAITING_PAYMENT when due date is far away", () => {
    const result = mapPayPalStatusToCashPilot("SENT", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.AWAITING_PAYMENT);
  });

  it("maps SENT to DUE_SOON when due date is within 7 days", () => {
    const result = mapPayPalStatusToCashPilot("SENT", dueSoon, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.DUE_SOON);
  });

  it("maps SENT to OVERDUE when due date is past", () => {
    const result = mapPayPalStatusToCashPilot("SENT", duePast, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.OVERDUE);
  });

  // ── PAID — requires provider evidence ─────────────────────────────────
  it("maps PAID to PAID (only via verified provider status)", () => {
    const result = mapPayPalStatusToCashPilot("PAID", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.PAID);
    expect(result.isKnownStatus).toBe(true);
  });

  // ── MARKED_AS_PAID → NEEDS_REVIEW (not PayPal-verified) ──────────────
  it("maps MARKED_AS_PAID to NEEDS_REVIEW (not provider-verified)", () => {
    const result = mapPayPalStatusToCashPilot("MARKED_AS_PAID", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);
    expect(result.requiresReview).toBe(true);
  });

  // ── CANCELLED ─────────────────────────────────────────────────────────
  it("maps CANCELLED to CANCELLED", () => {
    const result = mapPayPalStatusToCashPilot("CANCELLED", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.CANCELLED);
  });

  it("maps VOIDED to CANCELLED", () => {
    const result = mapPayPalStatusToCashPilot("VOIDED", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.CANCELLED);
  });

  // ── Partial / Refund states → NEEDS_REVIEW ────────────────────────────
  it("maps PARTIALLY_PAID to NEEDS_REVIEW", () => {
    const result = mapPayPalStatusToCashPilot("PARTIALLY_PAID", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);
  });

  it("maps REFUNDED to NEEDS_REVIEW", () => {
    const result = mapPayPalStatusToCashPilot("REFUNDED", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);
  });

  // ── Unknown / unmapped states → NEEDS_REVIEW (never PAID) ─────────────
  it("maps unknown status string to NEEDS_REVIEW", () => {
    const result = mapPayPalStatusToCashPilot("SOME_FUTURE_STATUS", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);
    expect(result.isKnownStatus).toBe(false);
    expect(result.requiresReview).toBe(true);
  });

  it("maps null status to NEEDS_REVIEW", () => {
    const result = mapPayPalStatusToCashPilot(null, dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);
    expect(result.isKnownStatus).toBe(false);
  });

  it("maps undefined status to NEEDS_REVIEW", () => {
    const result = mapPayPalStatusToCashPilot(undefined, dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);
  });

  it("maps empty string to NEEDS_REVIEW", () => {
    const result = mapPayPalStatusToCashPilot("", dueFarFuture, now);
    expect(result.cashpilotStatus).toBe(CashPilotStatus.NEEDS_REVIEW);
  });

  // ── Critical safety test: UNKNOWN NEVER becomes PAID ──────────────────
  it("NEVER maps an unknown status to PAID", () => {
    const unknownStatuses = ["", null, undefined, "UNKNOWN", "PROCESSING", "PENDING_REVIEW"];
    for (const status of unknownStatuses) {
      const result = mapPayPalStatusToCashPilot(status as string, dueFarFuture, now);
      expect(result.cashpilotStatus).not.toBe(CashPilotStatus.PAID);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State transition guards
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendToPayPal", () => {
  it("allows DRAFT invoices to be sent", () => {
    expect(canSendToPayPal(CashPilotStatus.DRAFT)).toBe(true);
  });

  it("disallows non-DRAFT invoices from being sent", () => {
    expect(canSendToPayPal(CashPilotStatus.AWAITING_PAYMENT)).toBe(false);
    expect(canSendToPayPal(CashPilotStatus.PAID)).toBe(false);
    expect(canSendToPayPal(CashPilotStatus.OVERDUE)).toBe(false);
    expect(canSendToPayPal(CashPilotStatus.NEEDS_REVIEW)).toBe(false);
  });
});

describe("canSendReminder", () => {
  it("allows reminders for AWAITING_PAYMENT, DUE_SOON, OVERDUE", () => {
    expect(canSendReminder(CashPilotStatus.AWAITING_PAYMENT)).toBe(true);
    expect(canSendReminder(CashPilotStatus.DUE_SOON)).toBe(true);
    expect(canSendReminder(CashPilotStatus.OVERDUE)).toBe(true);
  });

  it("disallows reminders for DRAFT, PAID, CANCELLED", () => {
    expect(canSendReminder(CashPilotStatus.DRAFT)).toBe(false);
    expect(canSendReminder(CashPilotStatus.PAID)).toBe(false);
    expect(canSendReminder(CashPilotStatus.CANCELLED)).toBe(false);
  });
});

describe("canCancelInvoice", () => {
  it("allows cancellation for sent unpaid invoices with active PayPal status", () => {
    expect(canCancelInvoice(CashPilotStatus.AWAITING_PAYMENT, "SENT")).toBe(true);
    expect(canCancelInvoice(CashPilotStatus.DUE_SOON, "SENT")).toBe(true);
    expect(canCancelInvoice(CashPilotStatus.OVERDUE, "SENT")).toBe(true);
    expect(canCancelInvoice(CashPilotStatus.AWAITING_PAYMENT, "UNPAID")).toBe(true);
  });

  it("disallows cancellation for DRAFT, PAID, CANCELLED, and NEEDS_REVIEW", () => {
    expect(canCancelInvoice(CashPilotStatus.DRAFT, "SENT")).toBe(false);
    expect(canCancelInvoice(CashPilotStatus.PAID, "PAID")).toBe(false);
    expect(canCancelInvoice(CashPilotStatus.CANCELLED, "CANCELLED")).toBe(false);
    expect(canCancelInvoice(CashPilotStatus.NEEDS_REVIEW, "SENT")).toBe(false);
  });

  it("disallows cancellation when paypalStatus indicates paid, draft, or already cancelled", () => {
    expect(canCancelInvoice(CashPilotStatus.AWAITING_PAYMENT, "PAID")).toBe(false);
    expect(canCancelInvoice(CashPilotStatus.AWAITING_PAYMENT, "MARKED_AS_PAID")).toBe(false);
    expect(canCancelInvoice(CashPilotStatus.AWAITING_PAYMENT, "PARTIALLY_PAID")).toBe(false);
    expect(canCancelInvoice(CashPilotStatus.AWAITING_PAYMENT, "CANCELLED")).toBe(false);
    expect(canCancelInvoice(CashPilotStatus.AWAITING_PAYMENT, "VOIDED")).toBe(false);
    expect(canCancelInvoice(CashPilotStatus.AWAITING_PAYMENT, "DRAFT")).toBe(false);
    expect(canCancelInvoice(CashPilotStatus.AWAITING_PAYMENT, null)).toBe(false);
  });
});

