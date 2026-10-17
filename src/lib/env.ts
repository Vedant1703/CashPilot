/**
 * CashPilot AI — Environment Variable Validation
 *
 * Validates all required environment variables at startup.
 * Fails loudly on missing or obviously invalid config.
 * NEVER logs or exposes secret values.
 *
 * SRS §7: Security — credentials server-side only, do not commit secrets
 */

import { z } from "zod";

const serverEnvSchema = z.object({
  // ── Application ────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),

  // ── Database ───────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((s) => s.startsWith("postgresql://") || s.startsWith("postgres://"), {
      message: "DATABASE_URL must be a PostgreSQL connection string",
    }),

  // ── PayPal Sandbox ─────────────────────────────────────────────────────────
  PAYPAL_ENV: z
    .enum(["sandbox"])
    .default("sandbox")
    .refine((v) => v === "sandbox", {
      message: "PAYPAL_ENV must be 'sandbox'. Production mode is disabled.",
    }),
  PAYPAL_CLIENT_ID: z
    .string()
    .min(1, "PAYPAL_CLIENT_ID is required for PayPal integration"),
  PAYPAL_CLIENT_SECRET: z
    .string()
    .min(1, "PAYPAL_CLIENT_SECRET is required for PayPal integration"),
  PAYPAL_BASE_URL: z
    .string()
    .url()
    .default("https://api-m.sandbox.paypal.com")
    .refine((u) => u.includes("sandbox"), {
      message: "PAYPAL_BASE_URL must be a Sandbox URL",
    }),

  // ── AI Provider ───────────────────────────────────────────────────────────
  AI_PROVIDER: z
    .enum(["google", "anthropic", "openai"])
    .default("google"),
  AI_API_KEY: z.string().min(1, "AI_API_KEY is required for AI features"),
  AI_MODEL: z.string().default("gemini-1.5-pro"),

  // ── Session / Security ───────────────────────────────────────────────────
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
});

// Public env (safe to expose to browser)
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
});

export function getPublicEnv(): PublicEnv {
  return publicEnvSchema.parse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
}

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type PublicEnv = z.infer<typeof publicEnvSchema>;

let _serverEnv: ServerEnv | null = null;

/**
 * Validate and return server environment variables.
 * Call once at app startup or in Server Components.
 * NEVER call on the client side.
 */
export function getServerEnv(): ServerEnv {
  if (_serverEnv) return _serverEnv;

  const result = serverEnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    // Do NOT log the actual env values — only field names and messages
    throw new Error(
      `\n\n❌ CashPilot environment configuration error:\n${errors}\n\n` +
        `Copy .env.example to .env.local and fill in the required values.\n`
    );
  }

  _serverEnv = result.data;
  return _serverEnv;
}

/**
 * Check whether PayPal credentials appear configured (non-placeholder).
 * Does NOT validate credentials against the API — only local presence.
 */
export function isPayPalConfigured(env: ServerEnv): boolean {
  return (
    !env.PAYPAL_CLIENT_ID.startsWith("placeholder") &&
    !env.PAYPAL_CLIENT_SECRET.startsWith("placeholder") &&
    env.PAYPAL_CLIENT_ID.length > 10 &&
    env.PAYPAL_CLIENT_SECRET.length > 10
  );
}

/**
 * Check whether AI credentials appear configured (non-placeholder).
 */
export function isAiConfigured(env: ServerEnv): boolean {
  return (
    !env.AI_API_KEY.startsWith("placeholder") &&
    env.AI_API_KEY.length > 10
  );
}
