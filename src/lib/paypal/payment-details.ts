/**
 * CashPilot AI — PayPal Payment Details Extraction & Formatting
 *
 * SRS §4, §5 & Financial Integrity Rules:
 *   - Grounded exclusively in verified provider response data (`paypalStatusRaw`).
 *   - Strictly displays actual amounts reported by PayPal; never calculates paid
 *     amount from invoice total alone.
 *   - Strictly retains currency alongside all monetary amounts.
 *   - Never invents transaction IDs, payment dates, paid amounts, or settlement details.
 *   - Handles missing, malformed, or partial provider responses safely and gracefully.
 *   - Keeps partial payments and refunds visually and semantically distinct from full payment.
 */

import { parseMoneyToMinorUnits, formatMoney } from "@/lib/money";

export interface PayPalTransactionDetail {
  id?: string;
  type?: string;
  date?: string;
  formattedDate?: string;
  method?: string;
  amountFormatted?: string;
  amountValue?: string;
  currency?: string;
  note?: string;
}

export interface PayPalPaymentSummary {
  // Status flags
  isPaid: boolean;
  isPartiallyPaid: boolean;
  isRefunded: boolean;
  isPartiallyRefunded: boolean;
  isCancelled: boolean;
  requiresReview: boolean;
  hasPaymentData: boolean;
  rawStatus: string | null;

  // Paid amount (amount received)
  paidAmountFormatted: string | null;
  paidAmountValue: string | null;
  paidAmountCurrency: string | null;

  // Due / Outstanding balance
  dueAmountFormatted: string | null;
  dueAmountValue: string | null;
  dueAmountCurrency: string | null;

  // Refunded amount
  refundedAmountFormatted: string | null;
  refundedAmountValue: string | null;
  refundedAmountCurrency: string | null;

  // Primary payment transaction (first / main transaction if available)
  primaryTransactionId: string | null;
  primaryPaymentDate: string | null;
  primaryPaymentMethod: string | null;

  // Transaction histories
  paymentTransactions: PayPalTransactionDetail[];
  refundTransactions: PayPalTransactionDetail[];

  // Provider verification flag
  isPayPalVerified: boolean;
}

/**
 * Format a PayPal decimal amount string (e.g. "120.00") with currency using integer minor units.
 * Returns null if the value is missing or unparseable.
 */
export function formatPayPalAmount(
  value: string | number | undefined | null,
  currencyCode: string | undefined | null
): string | null {
  if (value === undefined || value === null) return null;
  const strVal = String(value).trim();
  if (!strVal) return null;

  const minorUnits = parseMoneyToMinorUnits(strVal);
  if (minorUnits === null) return null;

  const currency = currencyCode?.trim().toUpperCase() || "USD";
  return `${formatMoney(minorUnits, currency)} ${currency}`;
}

/**
 * Safely format a date string returned by PayPal API.
 * PayPal returns dates in ISO 8601 ("2026-10-31T15:30:00Z"),
 * PayPal date-time format ("2026-10-31 08:30:00 PST"), or date-only ("2026-10-31").
 */
export function formatPayPalDate(rawDate?: string | null): string | null {
  if (!rawDate || typeof rawDate !== "string" || !rawDate.trim()) return null;
  const trimmed = rawDate.trim();

  // If date-only "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split("-").map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d));
    if (!isNaN(dateObj.getTime())) {
      return dateObj.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    }
  }

  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) {
    // If Date constructor cannot parse (e.g., custom timezone notation), return the raw string safely
    return trimmed;
  }

  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * Extracts and normalizes reliable payment and refund information from raw PayPal status data.
 *
 * @param paypalStatusRaw Persisted JSON response from PayPal Invoicing API
 * @param fallbackStatus Current invoice.paypalStatus or cashpilotStatus
 * @param defaultCurrency Default invoice currency (e.g., "USD")
 */
export function extractPayPalPaymentDetails(
  paypalStatusRaw: unknown,
  fallbackStatus?: string | null,
  defaultCurrency: string = "USD"
): PayPalPaymentSummary {
  // Normalize raw object
  let raw: Record<string, unknown> = {};
  if (paypalStatusRaw && typeof paypalStatusRaw === "object") {
    raw = paypalStatusRaw as Record<string, unknown>;
  } else if (typeof paypalStatusRaw === "string") {
    try {
      const parsed = JSON.parse(paypalStatusRaw);
      if (parsed && typeof parsed === "object") {
        raw = parsed;
      }
    } catch {
      raw = {};
    }
  }

  // Determine provider status
  const rawStatus = (
    (typeof raw.status === "string" ? raw.status : null) ??
    fallbackStatus ??
    ""
  )
    .trim()
    .toUpperCase();

  const isPaid = rawStatus === "PAID" || rawStatus === "MARKED_AS_PAID";
  const isPartiallyPaid = rawStatus === "PARTIALLY_PAID";
  const isRefunded = rawStatus === "REFUNDED";
  const isPartiallyRefunded = rawStatus === "PARTIALLY_REFUNDED";
  const isCancelled = rawStatus === "CANCELLED" || rawStatus === "VOIDED";
  const requiresReview = isPartiallyPaid || isRefunded || isPartiallyRefunded;

  // Extract raw payments block
  const rawPayments =
    raw.payments && typeof raw.payments === "object"
      ? (raw.payments as Record<string, unknown>)
      : null;

  // Extract paid_amount
  let paidAmountVal: string | null = null;
  let paidAmountCurr: string | null = null;

  if (rawPayments?.paid_amount && typeof rawPayments.paid_amount === "object") {
    const pa = rawPayments.paid_amount as Record<string, unknown>;
    if (pa.value !== undefined && pa.value !== null) {
      paidAmountVal = String(pa.value);
      paidAmountCurr = (pa.currency_code as string) || defaultCurrency;
    }
  }

  // Extract raw due_amount
  let dueAmountVal: string | null = null;
  let dueAmountCurr: string | null = null;

  if (raw.due_amount && typeof raw.due_amount === "object") {
    const da = raw.due_amount as Record<string, unknown>;
    if (da.value !== undefined && da.value !== null) {
      dueAmountVal = String(da.value);
      dueAmountCurr = (da.currency_code as string) || defaultCurrency;
    }
  }

  // Extract raw refunds block
  const rawRefunds =
    raw.refunds && typeof raw.refunds === "object"
      ? (raw.refunds as Record<string, unknown>)
      : null;

  let refundedAmountVal: string | null = null;
  let refundedAmountCurr: string | null = null;

  if (rawRefunds?.refund_amount && typeof rawRefunds.refund_amount === "object") {
    const ra = rawRefunds.refund_amount as Record<string, unknown>;
    if (ra.value !== undefined && ra.value !== null) {
      refundedAmountVal = String(ra.value);
      refundedAmountCurr = (ra.currency_code as string) || defaultCurrency;
    }
  }

  // Parse payment transactions list
  const paymentTransactions: PayPalTransactionDetail[] = [];
  if (Array.isArray(rawPayments?.transactions)) {
    for (const item of rawPayments.transactions) {
      if (!item || typeof item !== "object") continue;
      const tx = item as Record<string, unknown>;

      let txVal: string | undefined;
      let txCurr: string | undefined;

      if (tx.amount && typeof tx.amount === "object") {
        const amt = tx.amount as Record<string, unknown>;
        if (amt.value !== undefined && amt.value !== null) {
          txVal = String(amt.value);
          txCurr = (amt.currency_code as string) || defaultCurrency;
        }
      } else if (typeof tx.amount === "string" || typeof tx.amount === "number") {
        txVal = String(tx.amount);
        txCurr = defaultCurrency;
      }

      const txDate = typeof tx.payment_date === "string" ? tx.payment_date : undefined;
      const txId = typeof tx.payment_id === "string" ? tx.payment_id : undefined;
      const txType = typeof tx.type === "string" ? tx.type : undefined;
      const txMethod = typeof tx.method === "string" ? tx.method : undefined;
      const txNote = typeof tx.note === "string" ? tx.note : undefined;

      paymentTransactions.push({
        id: txId,
        type: txType,
        date: txDate,
        formattedDate: formatPayPalDate(txDate) ?? undefined,
        method: txMethod,
        amountValue: txVal,
        amountFormatted: formatPayPalAmount(txVal, txCurr) ?? undefined,
        currency: txCurr,
        note: txNote,
      });
    }
  }

  // Parse refund transactions list
  const refundTransactions: PayPalTransactionDetail[] = [];
  if (Array.isArray(rawRefunds?.transactions)) {
    for (const item of rawRefunds.transactions) {
      if (!item || typeof item !== "object") continue;
      const tx = item as Record<string, unknown>;

      let txVal: string | undefined;
      let txCurr: string | undefined;

      if (tx.amount && typeof tx.amount === "object") {
        const amt = tx.amount as Record<string, unknown>;
        if (amt.value !== undefined && amt.value !== null) {
          txVal = String(amt.value);
          txCurr = (amt.currency_code as string) || defaultCurrency;
        }
      } else if (typeof tx.amount === "string" || typeof tx.amount === "number") {
        txVal = String(tx.amount);
        txCurr = defaultCurrency;
      }

      const txDate = typeof tx.refund_date === "string" ? tx.refund_date : undefined;
      const txId = typeof tx.refund_id === "string" ? tx.refund_id : undefined;
      const txType = typeof tx.type === "string" ? tx.type : undefined;
      const txMethod = typeof tx.method === "string" ? tx.method : undefined;
      const txNote = typeof tx.note === "string" ? tx.note : undefined;

      refundTransactions.push({
        id: txId,
        type: txType,
        date: txDate,
        formattedDate: formatPayPalDate(txDate) ?? undefined,
        method: txMethod,
        amountValue: txVal,
        amountFormatted: formatPayPalAmount(txVal, txCurr) ?? undefined,
        currency: txCurr,
        note: txNote,
      });
    }
  }

  // If paidAmountVal was not in payments.paid_amount, check if there's a single transaction with an amount
  if (!paidAmountVal && paymentTransactions.length === 1 && paymentTransactions[0].amountValue) {
    paidAmountVal = paymentTransactions[0].amountValue;
    paidAmountCurr = paymentTransactions[0].currency ?? defaultCurrency;
  }

  // Derive primary transaction details
  const primaryTx = paymentTransactions[0] ?? null;
  const primaryTransactionId = primaryTx?.id ?? null;
  const primaryPaymentDate = primaryTx?.formattedDate ?? formatPayPalDate(primaryTx?.date);
  const primaryPaymentMethod = primaryTx?.method ?? null;

  // Format monetary amounts safely
  const paidAmountFormatted = formatPayPalAmount(paidAmountVal, paidAmountCurr);
  const dueAmountFormatted = formatPayPalAmount(dueAmountVal, dueAmountCurr);
  const refundedAmountFormatted = formatPayPalAmount(refundedAmountVal, refundedAmountCurr);

  const hasPaymentData = Boolean(
    isPaid ||
    isPartiallyPaid ||
    isRefunded ||
    isPartiallyRefunded ||
    paidAmountFormatted !== null ||
    paymentTransactions.length > 0 ||
    refundTransactions.length > 0
  );

  return {
    isPaid,
    isPartiallyPaid,
    isRefunded,
    isPartiallyRefunded,
    isCancelled,
    requiresReview,
    hasPaymentData,
    rawStatus: rawStatus || null,

    paidAmountFormatted,
    paidAmountValue: paidAmountVal,
    paidAmountCurrency: paidAmountCurr,

    dueAmountFormatted,
    dueAmountValue: dueAmountVal,
    dueAmountCurrency: dueAmountCurr,

    refundedAmountFormatted,
    refundedAmountValue: refundedAmountVal,
    refundedAmountCurrency: refundedAmountCurr,

    primaryTransactionId,
    primaryPaymentDate,
    primaryPaymentMethod,

    paymentTransactions,
    refundTransactions,

    isPayPalVerified: isPaid || isPartiallyPaid || isRefunded || isPartiallyRefunded,
  };
}
