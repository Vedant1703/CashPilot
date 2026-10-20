/**
 * CashPilot AI — Invoice Validation Schemas
 *
 * SRS §4: Invoice drafting — validate all fields before persistence or provider calls
 * Uses Zod for runtime validation at all external input boundaries.
 * AI output, user input, and API payloads all go through these schemas.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Supported currencies for the MVP (single-currency assumption) */
export const SUPPORTED_CURRENCIES = ["USD"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** Maximum unit price: $999,999.99 = 99999999 cents */
export const MAX_UNIT_PRICE_MINOR_UNITS = 99_999_999;

/** Maximum line item quantity */
export const MAX_QUANTITY = 10_000;

/** Maximum line items per invoice */
export const MAX_LINE_ITEMS = 50;

/** Tax rate cap: 50% = 5000 basis points */
export const MAX_TAX_RATE_BASIS_POINTS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Line Item Schema
// ─────────────────────────────────────────────────────────────────────────────

export const lineItemInputSchema = z.object({
  description: z
    .string()
    .min(1, "Description is required")
    .max(1000, "Description must be 1000 characters or fewer"),

  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .max(MAX_QUANTITY, `Quantity cannot exceed ${MAX_QUANTITY}`),

  unitPriceMinorUnits: z
    .number()
    .int("Unit price must be in integer minor units (cents)")
    .min(0, "Unit price cannot be negative")
    .max(
      MAX_UNIT_PRICE_MINOR_UNITS,
      `Unit price cannot exceed ${MAX_UNIT_PRICE_MINOR_UNITS} minor units`
    ),
});

export type LineItemInput = z.infer<typeof lineItemInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Invoice Input Schema (user-supplied data)
// ─────────────────────────────────────────────────────────────────────────────

export const invoiceInputSchema = z.object({
  clientId: z.string().min(1, "Client ID is required"),

  title: z.string().max(200, "Title must be 200 characters or fewer").optional(),

  notes: z.string().max(2000, "Notes must be 2000 characters or fewer").optional(),

  terms: z.string().max(2000, "Terms must be 2000 characters or fewer").optional(),

  currency: z.enum(SUPPORTED_CURRENCIES, {
    errorMap: () => ({
      message: `Currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
    }),
  }),

  taxRateBasisPoints: z
    .number()
    .int("Tax rate basis points must be an integer")
    .min(0, "Tax rate cannot be negative")
    .max(MAX_TAX_RATE_BASIS_POINTS, `Tax rate cannot exceed ${MAX_TAX_RATE_BASIS_POINTS} basis points (50%)`),

  invoiceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invoice date must be YYYY-MM-DD")
    .optional(),

  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be YYYY-MM-DD"),

  lineItems: z
    .array(lineItemInputSchema)
    .min(1, "At least one line item is required")
    .max(MAX_LINE_ITEMS, `Cannot have more than ${MAX_LINE_ITEMS} line items`),

  // Optional client-supplied totals (UNTRUSTED: validated and overridden by server)
  subtotalMinorUnits: z.number().int().optional(),
  totalMinorUnits: z.number().int().optional(),
}).refine(
  (data) => {
    const dueDay = data.dueDate;
    const invoiceDay = data.invoiceDate || new Date().toISOString().substring(0, 10);
    return dueDay >= invoiceDay;
  },
  {
    message: "Due date must be on or after the invoice date",
    path: ["dueDate"],
  }
);

export type InvoiceInput = z.infer<typeof invoiceInputSchema>;

export const createDraftInvoiceSchema = invoiceInputSchema.and(
  z.object({
    workspaceId: z.string().min(1).optional(),
    actorId: z.string().min(1).optional(),
    isDemoData: z.boolean().optional(),
  })
);

export type CreateDraftInvoiceInput = z.infer<typeof createDraftInvoiceSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// AI Draft Output Schema
// SRS §4: Validate model output against strict server-side schemas
// Model output is UNTRUSTED INPUT — validate before using anything from it
// ─────────────────────────────────────────────────────────────────────────────

export const aiInvoiceDraftSchema = z.object({
  recipientEmail: z
    .string()
    .email("AI draft must include a valid recipient email")
    .optional(),

  clientName: z
    .string()
    .min(1, "Client name required")
    .max(200)
    .optional(),

  title: z.string().max(200).optional(),

  currency: z.enum(SUPPORTED_CURRENCIES).default("USD"),

  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be YYYY-MM-DD")
    .optional(),

  lineItems: z
    .array(
      z.object({
        description: z.string().min(1).max(1000),
        quantity: z.number().int().min(1).max(MAX_QUANTITY),
        // AI returns decimal price strings — we convert to minor units in service layer
        unitPriceDecimal: z.string().regex(/^\d+(\.\d{1,2})?$/, "Invalid price format"),
      })
    )
    .min(1)
    .max(MAX_LINE_ITEMS)
    .optional(),

  notes: z.string().max(2000).optional(),

  missingFields: z
    .array(z.string())
    .optional()
    .describe("Fields AI needs clarification on"),

  clarificationRequired: z.boolean().default(false),
});

export type AiInvoiceDraft = z.infer<typeof aiInvoiceDraftSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Approval Payload Schema
// SRS §4: Bind approval to exact material payload
// ─────────────────────────────────────────────────────────────────────────────

export const approvalPayloadSchema = z.object({
  invoiceId: z.string().min(1),
  workspaceId: z.string().min(1),
  actionType: z.enum(["SEND_INVOICE", "SEND_REMINDER", "CANCEL_INVOICE"]),

  // Material fields for SEND_INVOICE
  recipientEmail: z.string().email().optional(),
  totalMinorUnits: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  dueDate: z.string().optional(),

  // Version binding — hash of the invoice's material state
  invoiceVersion: z.string().optional(),

  timestamp: z.string().datetime().optional(),
});

export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;

export const approveInvoiceRequestSchema = z.object({
  actionType: z
    .enum(["SEND_INVOICE", "SEND_REMINDER", "CANCEL_INVOICE"])
    .default("SEND_INVOICE"),
  reviewedPayloadHash: z
    .string({ required_error: "Reviewed payload hash is required" })
    .length(64, "Reviewed payload hash must be a 64-character SHA-256 hex string")
    .regex(/^[a-f0-9]{64}$/, "Reviewed payload hash must be a valid 64-character hex string"),
});

export type ApproveInvoiceRequest = z.infer<typeof approveInvoiceRequestSchema>;

export const createPayPalDraftRequestSchema = z
  .object({
    approvalId: z.string().min(1).optional(),
  })
  .optional()
  .default({});

export type CreatePayPalDraftRequest = z.infer<typeof createPayPalDraftRequestSchema>;

export const sendInvoiceRequestSchema = z
  .object({
    approvalId: z.string().min(1, "Approval ID must not be empty").optional(),
  })
  .optional()
  .default({});

export type SendInvoiceRequest = z.infer<typeof sendInvoiceRequestSchema>;

