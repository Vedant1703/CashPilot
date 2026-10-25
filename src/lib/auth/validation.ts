/**
 * CashPilot AI — Authentication Input Validation & Reserved Domain Checks
 *
 * SRS § 7: Input Validation Boundaries & Identity Integrity
 */

import { z } from "zod";

// Non-routable and system-internal domains that cannot be claimed by real users
export const RESERVED_DOMAIN_PATTERNS = [
  /\.internal$/i,
  /\.local$/i,
  /\.test$/i,
  /\.invalid$/i,
  /\.example$/i,
  /\.localhost$/i,
];

/**
 * Checks whether an email address uses a reserved internal, testing, or synthetic domain.
 */
export function isReservedEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();

  // Reject synthetic legacy prefixes
  if (normalized.startsWith("legacy+") || normalized.startsWith("demo+")) {
    return true;
  }

  const atIndex = normalized.lastIndexOf("@");
  if (atIndex === -1) return false;

  const domain = normalized.slice(atIndex + 1);
  return RESERVED_DOMAIN_PATTERNS.some((pattern) => pattern.test(domain));
}

export const signupSchema = z.object({
  name: z
    .string({ required_error: "Full name is required" })
    .trim()
    .min(1, "Full name cannot be empty")
    .max(100, "Full name must not exceed 100 characters"),
  email: z
    .string({ required_error: "Email address is required" })
    .trim()
    .toLowerCase()
    .email("A valid email address is required")
    .max(255, "Email address must not exceed 255 characters")
    .refine((val) => !isReservedEmail(val), {
      message: "This email domain is reserved for internal system use.",
    }),
  password: z
    .string({ required_error: "Password is required" })
    .min(8, "Password must be at least 8 characters long")
    .max(128, "Password must not exceed 128 characters"),
  businessName: z
    .string()
    .trim()
    .max(100, "Business name must not exceed 100 characters")
    .optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z
    .string({ required_error: "Email address is required" })
    .trim()
    .toLowerCase()
    .email("A valid email address is required")
    .max(255),
  password: z
    .string({ required_error: "Password is required" })
    .min(1, "Password is required")
    .max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;
