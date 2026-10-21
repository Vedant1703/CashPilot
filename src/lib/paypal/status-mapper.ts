/**
 * CashPilot AI — PayPal Status Mapper
 *
 * SRS §5: Status and financial truth
 * This is the SINGLE, TESTED module that maps raw PayPal provider status
 * to CashPilot's normalized workflow status.
 *
 * Key invariants:
 *   - Unknown/unmapped states → NEEDS_REVIEW (never Paid)
 *   - PAID requires verified provider evidence (not AI inference)
 *   - Raw PayPal status is stored separately alongside mapped status
 *   - Stale status must be preserved when refresh fails
 *
 * Reference: PayPal Invoicing API v2 status values observed in Sandbox
 */

import { CashPilotStatus } from "@prisma/client";

/**
 * Known PayPal invoice status strings (as observed from API responses).
 * This list should be updated as provider documentation changes.
 */
export type PayPalInvoiceStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "SENT"
  | "PARTIALLY_PAID"
  | "PAYMENT_PENDING"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "MARKED_AS_REFUNDED"
  | "UNPAID"
  | "PAYMENT_DUE"
  | "VOIDED";

/**
 * Mapping from PayPal raw status to CashPilot normalized status.
 *
 * Design notes:
 *   - PARTIALLY_PAID → NEEDS_REVIEW (partial payment requires human decision)
 *   - PAYMENT_PENDING → AWAITING_PAYMENT (payment initiated but not confirmed)
 *   - MARKED_AS_PAID → NEEDS_REVIEW (manually recorded, not PayPal-verified)
 *   - REFUNDED / PARTIALLY_REFUNDED → NEEDS_REVIEW (requires attention)
 *   - Any unknown string → NEEDS_REVIEW
 */
const PAYPAL_TO_CASHPILOT_STATUS: Readonly<
  Record<PayPalInvoiceStatus, CashPilotStatus>
> = {
  DRAFT: CashPilotStatus.DRAFT,
  SCHEDULED: CashPilotStatus.AWAITING_PAYMENT,
  SENT: CashPilotStatus.AWAITING_PAYMENT,
  PARTIALLY_PAID: CashPilotStatus.NEEDS_REVIEW,
  PAYMENT_PENDING: CashPilotStatus.AWAITING_PAYMENT,
  PAID: CashPilotStatus.PAID,
  MARKED_AS_PAID: CashPilotStatus.NEEDS_REVIEW, // manually recorded ≠ PayPal-verified
  CANCELLED: CashPilotStatus.CANCELLED,
  REFUNDED: CashPilotStatus.NEEDS_REVIEW,
  PARTIALLY_REFUNDED: CashPilotStatus.NEEDS_REVIEW,
  MARKED_AS_REFUNDED: CashPilotStatus.NEEDS_REVIEW,
  UNPAID: CashPilotStatus.AWAITING_PAYMENT,
  PAYMENT_DUE: CashPilotStatus.AWAITING_PAYMENT,
  VOIDED: CashPilotStatus.CANCELLED,
};

export interface StatusMappingResult {
  cashpilotStatus: CashPilotStatus;
  rawPaypalStatus: string;
  isKnownStatus: boolean;
  requiresReview: boolean;
}

/**
 * Map a raw PayPal status string to CashPilot's normalized status.
 *
 * @param rawStatus - The raw status string from PayPal API response
 * @param dueDateUtc - Due date for computing DUE_SOON / OVERDUE
 * @param nowUtc - Current time (injectable for testing)
 */
export function mapPayPalStatusToCashPilot(
  rawStatus: string | null | undefined,
  dueDateUtc: Date,
  nowUtc: Date = new Date()
): StatusMappingResult {
  if (!rawStatus) {
    // No provider status available → cannot infer state
    return {
      cashpilotStatus: CashPilotStatus.NEEDS_REVIEW,
      rawPaypalStatus: rawStatus ?? "UNKNOWN",
      isKnownStatus: false,
      requiresReview: true,
    };
  }

  const normalized = rawStatus.trim().toUpperCase() as PayPalInvoiceStatus;
  const mapped = PAYPAL_TO_CASHPILOT_STATUS[normalized];

  if (!mapped) {
    // Unknown/unmapped status → NEEDS_REVIEW, never silently treat as Paid
    return {
      cashpilotStatus: CashPilotStatus.NEEDS_REVIEW,
      rawPaypalStatus: rawStatus,
      isKnownStatus: false,
      requiresReview: true,
    };
  }

  // Refine AWAITING_PAYMENT into DUE_SOON or OVERDUE based on due date
  let finalStatus = mapped;
  if (mapped === CashPilotStatus.AWAITING_PAYMENT) {
    const msUntilDue = dueDateUtc.getTime() - nowUtc.getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    if (msUntilDue < 0) {
      finalStatus = CashPilotStatus.OVERDUE;
    } else if (msUntilDue <= sevenDaysMs) {
      finalStatus = CashPilotStatus.DUE_SOON;
    }
  }

  return {
    cashpilotStatus: finalStatus,
    rawPaypalStatus: rawStatus,
    isKnownStatus: true,
    requiresReview: finalStatus === CashPilotStatus.NEEDS_REVIEW,
  };
}

/**
 * Determine the appropriate CashPilot status for a local draft invoice
 * (before any PayPal interaction), based on due date alone.
 */
export function getLocalDraftStatus(): CashPilotStatus {
  return CashPilotStatus.DRAFT;
}

/**
 * Type guard: is this status one that permits sending to PayPal?
 * Only DRAFT invoices can be sent.
 */
export function canSendToPayPal(status: CashPilotStatus): boolean {
  return status === CashPilotStatus.DRAFT;
}

/**
 * Type guard: is this status one that permits sending a payment reminder?
 * Only AWAITING_PAYMENT, DUE_SOON, or OVERDUE invoices can receive reminders.
 */
export function canSendReminder(status: CashPilotStatus): boolean {
  return (
    status === CashPilotStatus.AWAITING_PAYMENT ||
    status === CashPilotStatus.DUE_SOON ||
    status === CashPilotStatus.OVERDUE
  );
}

/**
 * Type guard: is this status one that permits cancelling the invoice on PayPal?
 * Only sent, unpaid invoices (AWAITING_PAYMENT, DUE_SOON, OVERDUE) can be cancelled.
 * Drafts, Paid, Cancelled, and Needs Review invoices cannot be cancelled.
 */
export function canCancelInvoice(
  status: CashPilotStatus,
  paypalStatus?: string | null
): boolean {
  if (
    status !== CashPilotStatus.AWAITING_PAYMENT &&
    status !== CashPilotStatus.DUE_SOON &&
    status !== CashPilotStatus.OVERDUE
  ) {
    return false;
  }
  if (!paypalStatus) {
    return false;
  }
  const norm = paypalStatus.trim().toUpperCase();
  if (
    norm === "PAID" ||
    norm === "MARKED_AS_PAID" ||
    norm === "PARTIALLY_PAID" ||
    norm === "CANCELLED" ||
    norm === "VOIDED" ||
    norm === "DRAFT"
  ) {
    return false;
  }
  return true;
}

