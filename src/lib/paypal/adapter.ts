/**
 * CashPilot AI — PayPal API Adapter
 *
 * SRS §4: PayPal integration
 * AGENTS.md §7: PayPal integration
 *
 * Key invariants:
 *   - All PayPal calls MUST go through this adapter (never from client components)
 *   - OAuth tokens are acquired and held in memory only — never logged or persisted
 *   - All credentials come from server-side environment variables only
 *   - Finite timeouts on every external call
 *   - Timed-out writes return isOutcomeUnknown: true — caller must reconcile
 *   - Never claim success without observed provider evidence
 *   - Sandbox ONLY — production mode is disabled at the env validation level
 */

import { getServerEnv, isPayPalConfigured } from "@/lib/env";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PayPalTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface PayPalInvoiceLineItem {
  name: string;
  description?: string;
  quantity: string;       // PayPal API uses string quantities
  unit_amount: {
    currency_code: string;
    value: string;         // decimal string, e.g. "150.00"
  };
}

export interface PayPalInvoicePayload {
  detail: {
    invoice_number?: string;
    invoice_date?: string;  // YYYY-MM-DD
    currency_code: string;
    note?: string;
    term?: string;
    payment_term?: {
      term_type: string;
      due_date?: string;    // YYYY-MM-DD
    };
  };
  invoicer?: {
    name?: { given_name?: string; surname?: string };
    email_address?: string;
  };
  primary_recipients: Array<{
    billing_info: {
      email_address: string;
      name?: { given_name?: string; surname?: string };
    };
  }>;
  items: PayPalInvoiceLineItem[];
  configuration?: {
    allow_tip?: boolean;
    tax_calculated_after_discount?: boolean;
  };
}

export interface PayPalInvoiceResponse {
  id: string;
  status: string;
  detail: {
    invoice_number?: string;
    currency_code: string;
    metadata?: {
      recipient_view_url?: string;
      invoicer_view_url?: string;
      create_time?: string;
      last_update_time?: string;
    };
  };
  amount?: {
    currency_code: string;
    value: string;
  };
  links?: Array<{ rel: string; href: string; method: string }>;
}

export type PayPalApiResult<T> =
  | { success: true; data: T; correlationId?: string }
  | { success: false; error: PayPalApiError; correlationId?: string }
  | { success: false; isOutcomeUnknown: true; error: PayPalApiError; correlationId?: string };

export interface PayPalApiError {
  code: string;
  message: string; // sanitized — no secrets
  httpStatus?: number;
  details?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payer View Link Extraction & Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that a URL is a genuine HTTPS PayPal URL.
 * Safety requirement: Never invent or accept unauthorized external URLs.
 */
export function isValidPayPalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "www.sandbox.paypal.com" ||
      hostname === "sandbox.paypal.com" ||
      hostname === "www.paypal.com" ||
      hostname === "paypal.com"
    );
  } catch {
    return false;
  }
}

/**
 * Safely extract the PayPal payer-view URL from a provider response payload.
 *
 * Checks:
 *   1. Single link response: { href: "...", rel: "payer-view" } (returned by POST .../send)
 *   2. Links array: { links: [ { href: "...", rel: "payer-view" } ] }
 *   3. Metadata URL: detail.metadata.recipient_view_url (returned by GET .../invoices/{id})
 *
 * Safety requirements:
 *   - Strictly validates that the URL is a valid HTTPS PayPal URL.
 *   - Never invents a payer URL.
 *   - Returns null if missing or invalid.
 */
export function extractPayerViewUrl(responseData: unknown): string | null {
  if (!responseData || typeof responseData !== "object") return null;

  const data = responseData as Record<string, unknown>;

  // Case 1: Single HATEOAS link object directly returned by POST .../send
  if (
    typeof data.href === "string" &&
    (data.rel === "payer-view" || data.rel === "payer_view")
  ) {
    return isValidPayPalUrl(data.href) ? data.href : null;
  }

  // Case 2: Links array
  if (Array.isArray(data.links)) {
    const link = data.links.find(
      (l) =>
        l &&
        typeof l === "object" &&
        ("rel" in l) &&
        (l.rel === "payer-view" || l.rel === "payer_view") &&
        ("href" in l) &&
        typeof l.href === "string"
    );
    if (link && typeof link.href === "string" && isValidPayPalUrl(link.href)) {
      return link.href;
    }
  }

  // Case 3: detail.metadata.recipient_view_url (from GET /invoices/{id})
  if (
    data.detail &&
    typeof data.detail === "object" &&
    "metadata" in data.detail &&
    data.detail.metadata &&
    typeof data.detail.metadata === "object" &&
    "recipient_view_url" in data.detail.metadata &&
    typeof data.detail.metadata.recipient_view_url === "string"
  ) {
    const url = data.detail.metadata.recipient_view_url;
    if (isValidPayPalUrl(url)) {
      return url;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Cache (in-memory only, never persisted or logged)
// ─────────────────────────────────────────────────────────────────────────────

interface TokenCache {
  accessToken: string;
  expiresAt: number; // Unix timestamp ms
}

let _tokenCache: TokenCache | null = null;

function isCacheValid(cache: TokenCache): boolean {
  // Subtract 60s buffer to avoid using an almost-expired token
  return Date.now() < cache.expiresAt - 60_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core HTTP Helper
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000; // 15 seconds

/**
 * Fetch with finite timeout. Returns { timedOut: true } if AbortSignal fires.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit
): Promise<{ response: Response; timedOut: false } | { timedOut: true }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return { response, timedOut: false };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { timedOut: true };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth Token Acquisition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acquire a PayPal OAuth access token using client credentials flow.
 * Token is cached in memory; credentials are never logged.
 *
 * Returns null if PayPal is not configured with real credentials.
 */
export async function getPayPalAccessToken(): Promise<string | null> {
  const env = getServerEnv();

  if (!isPayPalConfigured(env)) {
    return null; // Placeholder credentials — caller handles gracefully
  }

  if (_tokenCache && isCacheValid(_tokenCache)) {
    return _tokenCache.accessToken;
  }

  const tokenUrl = `${env.PAYPAL_BASE_URL}/v1/oauth2/token`;

  // Build Basic auth — credentials are NOT logged
  const credentials = Buffer.from(
    `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const fetchResult = await fetchWithTimeout(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });

  if (fetchResult.timedOut) {
    throw new Error("PayPal OAuth token request timed out");
  }

  const { response } = fetchResult;

  if (!response.ok) {
    // Do NOT log the credentials or authorization header
    throw new Error(
      `PayPal OAuth failed: ${response.status} ${response.statusText}`
    );
  }

  const data: PayPalTokenResponse = await response.json();

  // Cache token — access_token is intentionally NOT logged
  _tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return _tokenCache.accessToken;
}

// ─────────────────────────────────────────────────────────────────────────────
// PayPal Invoice API Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a draft invoice in PayPal Sandbox.
 * SRS §4: Separate draft creation, sending, and status retrieval.
 *
 * @returns PayPalApiResult with the new provider invoice ID on success
 */
export async function createPayPalDraftInvoice(
  payload: PayPalInvoicePayload,
  requestId?: string
): Promise<PayPalApiResult<PayPalInvoiceResponse>> {
  const env = getServerEnv();
  const token = await getPayPalAccessToken();

  if (!token) {
    return {
      success: false,
      error: {
        code: "PAYPAL_NOT_CONFIGURED",
        message: "PayPal Sandbox credentials are not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
      },
    };
  }

  const url = `${env.PAYPAL_BASE_URL}/v2/invoicing/invoices`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "return=representation",
  };

  if (requestId) {
    headers["PayPal-Request-Id"] = requestId;
  }

  const fetchResult = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (fetchResult.timedOut) {
    // SRS §4: A timeout is an UNKNOWN outcome — must reconcile before retry
    return {
      success: false,
      isOutcomeUnknown: true,
      error: {
        code: "TIMEOUT",
        message: "PayPal draft creation timed out. The outcome is unknown. Reconcile before retrying.",
      },
    };
  }

  const { response } = fetchResult;
  const correlationId = response.headers.get("paypal-debug-id") ?? undefined;

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    return {
      success: false,
      correlationId,
      error: {
        code: errorBody.name ?? "PAYPAL_API_ERROR",
        message: errorBody.message ?? `PayPal API error: ${response.status}`,
        httpStatus: response.status,
        details: errorBody.details,
      },
    };
  }

  const data: PayPalInvoiceResponse = await response.json();
  return { success: true, data, correlationId };
}

/**
 * Send a PayPal draft invoice to the customer.
 * SRS §4: Only permitted after valid server-side approval.
 *
 * IMPORTANT: A successful send does NOT mean payment has occurred.
 * Never transition to PAID based on this response.
 */
export async function sendPayPalInvoice(
  paypalInvoiceId: string,
  requestId?: string
): Promise<PayPalApiResult<{ sent: true; payerViewUrl?: string | null }>> {
  const env = getServerEnv();
  const token = await getPayPalAccessToken();

  if (!token) {
    return {
      success: false,
      error: {
        code: "PAYPAL_NOT_CONFIGURED",
        message: "PayPal Sandbox credentials are not configured.",
      },
    };
  }

  const url = `${env.PAYPAL_BASE_URL}/v2/invoicing/invoices/${paypalInvoiceId}/send`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (requestId) {
    headers["PayPal-Request-Id"] = requestId;
  }

  const fetchResult = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ send_to_invoicer: true, send_to_recipient: true }),
  });

  if (fetchResult.timedOut) {
    return {
      success: false,
      isOutcomeUnknown: true,
      error: {
        code: "TIMEOUT",
        message: "PayPal send timed out. The outcome is unknown. Reconcile before retrying.",
      },
    };
  }

  const { response } = fetchResult;
  const correlationId = response.headers.get("paypal-debug-id") ?? undefined;

  // PayPal returns 200 OK, 202 Accepted, or 204 No Content for successful sends
  if (response.status === 202 || response.status === 200 || response.status === 204) {
    let payerViewUrl: string | null = null;
    try {
      const responseBody = await response.json().catch(() => null);
      payerViewUrl = extractPayerViewUrl(responseBody);
    } catch {
      payerViewUrl = null;
    }
    return { success: true, data: { sent: true, payerViewUrl }, correlationId };
  }

  const errorBody = await response.json().catch(() => ({}));
  return {
    success: false,
    correlationId,
    error: {
      code: errorBody.name ?? "PAYPAL_SEND_ERROR",
      message: errorBody.message ?? `PayPal send error: ${response.status}`,
      httpStatus: response.status,
      details: errorBody.details,
    },
  };
}

/**
 * Retrieve current invoice status from PayPal.
 * SRS §4: Retrieve provider state to reconcile local views.
 *
 * Used for status refresh and reconciliation after timeouts.
 */
export async function getPayPalInvoiceStatus(
  paypalInvoiceId: string
): Promise<PayPalApiResult<PayPalInvoiceResponse>> {
  const env = getServerEnv();
  const token = await getPayPalAccessToken();

  if (!token) {
    return {
      success: false,
      error: {
        code: "PAYPAL_NOT_CONFIGURED",
        message: "PayPal Sandbox credentials are not configured.",
      },
    };
  }

  const url = `${env.PAYPAL_BASE_URL}/v2/invoicing/invoices/${paypalInvoiceId}`;

  const fetchResult = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  if (fetchResult.timedOut) {
    return {
      success: false,
      isOutcomeUnknown: true,
      error: {
        code: "TIMEOUT",
        message: "PayPal status retrieval timed out. Last known status preserved.",
      },
    };
  }

  const { response } = fetchResult;
  const correlationId = response.headers.get("paypal-debug-id") ?? undefined;

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    return {
      success: false,
      correlationId,
      error: {
        code: errorBody.name ?? "PAYPAL_GET_ERROR",
        message: errorBody.message ?? `PayPal get error: ${response.status}`,
        httpStatus: response.status,
      },
    };
  }

  const data: PayPalInvoiceResponse = await response.json();
  return { success: true, data, correlationId };
}

export interface PayPalReminderOptions {
  subject?: string;
  note?: string;
  sendToInvoicer?: boolean;
  sendToRecipient?: boolean;
  requestId?: string;
}

/**
 * Send a payment reminder for an invoice.
 * SRS §4: Only where provider/account/invoice state supports it.
 */
export async function sendPayPalReminder(
  paypalInvoiceId: string,
  noteOrOptions?: string | PayPalReminderOptions,
  requestIdParam?: string
): Promise<PayPalApiResult<{ reminded: true }>> {
  const env = getServerEnv();
  const token = await getPayPalAccessToken();

  if (!token) {
    return {
      success: false,
      error: {
        code: "PAYPAL_NOT_CONFIGURED",
        message: "PayPal Sandbox credentials are not configured.",
      },
    };
  }

  const url = `${env.PAYPAL_BASE_URL}/v2/invoicing/invoices/${paypalInvoiceId}/remind`;

  const isString = typeof noteOrOptions === "string";
  const note = isString ? noteOrOptions : noteOrOptions?.note;
  const subject = isString ? undefined : noteOrOptions?.subject;
  const sendToRecipient = isString ? true : (noteOrOptions?.sendToRecipient ?? true);
  const sendToInvoicer = isString ? false : (noteOrOptions?.sendToInvoicer ?? false);
  const requestId = isString ? requestIdParam : (noteOrOptions?.requestId ?? requestIdParam);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  if (requestId) {
    headers["PayPal-Request-Id"] = requestId;
  }

  const payload: Record<string, unknown> = {
    send_to_recipient: sendToRecipient,
    send_to_invoicer: sendToInvoicer,
  };
  if (note) {
    payload.note = note;
  }
  if (subject) {
    payload.subject = subject;
  }

  const fetchResult = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (fetchResult.timedOut) {
    return {
      success: false,
      isOutcomeUnknown: true,
      error: {
        code: "TIMEOUT",
        message: "PayPal reminder timed out. Reconcile before retrying.",
      },
    };
  }

  const { response } = fetchResult;
  const correlationId = response.headers.get("paypal-debug-id") ?? undefined;

  if (response.status === 204 || response.status === 200 || response.status === 202) {
    return { success: true, data: { reminded: true }, correlationId };
  }

  const errorBody = await response.json().catch(() => ({}));
  return {
    success: false,
    correlationId,
    error: {
      code: errorBody.name ?? "PAYPAL_REMINDER_ERROR",
      message: errorBody.message ?? `PayPal reminder error: ${response.status}`,
      httpStatus: response.status,
      details: errorBody.details,
    },
  };
}

export interface PayPalCancelOptions {
  subject?: string;
  note?: string;
  sendToInvoicer?: boolean;
  sendToRecipient?: boolean;
  requestId?: string;
}

/**
 * Cancel a sent PayPal invoice.
 *
 * SRS §4 & Financial Integrity Rules:
 *   - Provider endpoint: POST /v2/invoicing/invoices/{invoice_id}/cancel
 *   - Only sent, unpaid invoices can be cancelled
 *   - Returns 204 No Content on success (no JSON response body)
 *   - Timeout handling flags outcome as UNKNOWN
 */
export async function cancelPayPalInvoice(
  paypalInvoiceId: string,
  options?: PayPalCancelOptions
): Promise<PayPalApiResult<{ cancelled: true }>> {
  const env = getServerEnv();
  const token = await getPayPalAccessToken();

  if (!token) {
    return {
      success: false,
      error: {
        code: "PAYPAL_NOT_CONFIGURED",
        message: "PayPal Sandbox credentials are not configured.",
      },
    };
  }

  const url = `${env.PAYPAL_BASE_URL}/v2/invoicing/invoices/${paypalInvoiceId}/cancel`;

  const note = options?.note;
  const subject = options?.subject;
  const sendToRecipient = options?.sendToRecipient ?? true;
  const sendToInvoicer = options?.sendToInvoicer ?? false;
  const requestId = options?.requestId;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  if (requestId) {
    headers["PayPal-Request-Id"] = requestId;
  }

  const payload: Record<string, unknown> = {
    send_to_recipient: sendToRecipient,
    send_to_invoicer: sendToInvoicer,
  };
  if (note) {
    payload.note = note;
  }
  if (subject) {
    payload.subject = subject;
  }

  const fetchResult = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (fetchResult.timedOut) {
    return {
      success: false,
      isOutcomeUnknown: true,
      error: {
        code: "TIMEOUT",
        message: "PayPal cancellation timed out. Reconcile before retrying.",
      },
    };
  }

  const { response } = fetchResult;
  const correlationId = response.headers.get("paypal-debug-id") ?? undefined;

  // PayPal cancel endpoint returns 204 No Content (or 200) on confirmed success
  if (response.status === 204 || response.status === 200) {
    return { success: true, data: { cancelled: true }, correlationId };
  }

  const errorBody = await response.json().catch(() => ({}));
  return {
    success: false,
    correlationId,
    error: {
      code: errorBody.name ?? "PAYPAL_CANCEL_ERROR",
      message: errorBody.message ?? `PayPal invoice cancellation failed with HTTP ${response.status}`,
      httpStatus: response.status,
      details: errorBody.details,
    },
  };
}

