/**
 * CashPilot AI — Client Validation Schemas
 *
 * Requirements:
 * - Trim all strings
 * - Validate email format
 * - Sensible length limits (name: 1-100, email: 1-255, company: 100, phone: 50, notes: 1000)
 * - Reject empty updates (at least one valid field must be present)
 */

import { z } from "zod";

/**
 * Creates client input validation schema.
 */
export const createClientSchema = z.object({
  name: z
    .string({ required_error: "Client name is required" })
    .trim()
    .min(1, "Client name is required")
    .max(100, "Client name must be 100 characters or fewer"),

  email: z
    .string({ required_error: "Email is required" })
    .trim()
    .min(1, "Email is required")
    .email("A valid email address is required")
    .max(255, "Email must be 255 characters or fewer"),

  company: z
    .string()
    .trim()
    .max(100, "Company name must be 100 characters or fewer")
    .optional()
    .nullable()
    .transform((val) => (val && val.length > 0 ? val : null)),

  phone: z
    .string()
    .trim()
    .max(50, "Phone number must be 50 characters or fewer")
    .optional()
    .nullable()
    .transform((val) => (val && val.length > 0 ? val : null)),

  notes: z
    .string()
    .trim()
    .max(1000, "Notes must be 1000 characters or fewer")
    .optional()
    .nullable()
    .transform((val) => (val && val.length > 0 ? val : null)),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;

/**
 * Updates client input validation schema.
 * Rejects empty updates (at least one valid field must be specified).
 */
export const updateClientSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Client name cannot be empty")
      .max(100, "Client name must be 100 characters or fewer")
      .optional(),

    email: z
      .string()
      .trim()
      .min(1, "Email cannot be empty")
      .email("A valid email address is required")
      .max(255, "Email must be 255 characters or fewer")
      .optional(),

    company: z
      .string()
      .trim()
      .max(100, "Company name must be 100 characters or fewer")
      .optional()
      .nullable()
      .transform((val) => (val === undefined ? undefined : val && val.length > 0 ? val : null)),

    phone: z
      .string()
      .trim()
      .max(50, "Phone number must be 50 characters or fewer")
      .optional()
      .nullable()
      .transform((val) => (val === undefined ? undefined : val && val.length > 0 ? val : null)),

    notes: z
      .string()
      .trim()
      .max(1000, "Notes must be 1000 characters or fewer")
      .optional()
      .nullable()
      .transform((val) => (val === undefined ? undefined : val && val.length > 0 ? val : null)),
  })
  .refine(
    (data) => {
      const keys = Object.keys(data) as Array<keyof typeof data>;
      return keys.some((k) => data[k] !== undefined);
    },
    {
      message: "At least one field must be provided for update",
    }
  );

export type UpdateClientInput = z.infer<typeof updateClientSchema>;

/**
 * Search/query schema for client listing.
 */
export const clientQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(100, "Search term must be 100 characters or fewer")
    .optional(),
});

export type ClientQueryInput = z.infer<typeof clientQuerySchema>;
