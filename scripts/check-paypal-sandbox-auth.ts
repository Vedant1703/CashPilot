/**
 * CashPilot AI — PayPal Sandbox OAuth Sanity Check
 *
 * Task 2: Isolated verification of PayPal Sandbox OAuth 2.0 access token acquisition.
 *
 * Security & Financial Invariants:
 * - Never log or persist client secrets, access tokens, or Authorization headers.
 * - Never print raw request or response payloads.
 * - Does NOT create, update, or delete any resources (read-only token check).
 * - Single request with finite timeout; no automated retries.
 */

import * as fs from "node:fs";
import * as path from "node:path";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// Load .env.local first (local overrides), then .env as fallback
loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), ".env"));

async function runOAuthCheck(): Promise<void> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const baseUrl =
    process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";

  console.log("==================================================");
  console.log("CashPilot AI — PayPal Sandbox OAuth Verification");
  console.log("==================================================");
  console.log(`Endpoint: ${baseUrl}/v1/oauth2/token`);

  if (!clientId || !clientSecret) {
    console.error("FAIL: Missing PayPal credentials in environment.");
    console.error(
      `PAYPAL_CLIENT_ID present: ${Boolean(clientId)}, PAYPAL_CLIENT_SECRET present: ${Boolean(clientSecret)}`
    );
    process.exit(1);
  }

  if (
    clientId.startsWith("your_") ||
    clientId.startsWith("placeholder") ||
    clientSecret.startsWith("your_") ||
    clientSecret.startsWith("placeholder")
  ) {
    console.error("FAIL: PayPal credentials contain placeholder values.");
    process.exit(1);
  }

  const tokenUrl = `${baseUrl}/v1/oauth2/token`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000); // 15-second finite timeout

  try {
    const startTime = Date.now();
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - startTime;
    const debugId = response.headers.get("paypal-debug-id") || "(none)";

    if (!response.ok) {
      console.log("\n--- Verification Result ---");
      console.log("Result: FAIL");
      console.log(`HTTP Status: ${response.status} ${response.statusText}`);
      console.log(`PayPal Debug ID: ${debugId}`);
      console.log(`Latency: ${latencyMs}ms`);

      let safeErrorMessage = "Authentication failed";
      try {
        const errJson = await response.json();
        safeErrorMessage =
          errJson.error_description ||
          errJson.error ||
          errJson.message ||
          "OAuth request rejected";
      } catch {
        // Response was not JSON; keep default safe error message
      }
      console.log(`Error Category: ${safeErrorMessage}`);
      process.exit(1);
    }

    const data = await response.json();
    const hasAccessToken =
      typeof data.access_token === "string" && data.access_token.length > 0;
    const tokenType = data.token_type || "(not specified)";
    const expiresIn =
      typeof data.expires_in === "number"
        ? `${data.expires_in} seconds`
        : "(not specified)";
    const appId = data.app_id ? `APP-${data.app_id.slice(-4)}` : "(present)";

    console.log("\n--- Verification Result ---");
    console.log("Result: PASS");
    console.log(`HTTP Status: ${response.status} ${response.statusText}`);
    console.log(`PayPal Debug ID: ${debugId}`);
    console.log(`Access Token Received: ${hasAccessToken}`);
    console.log(`Token Type: ${tokenType}`);
    console.log(`Expires In: ${expiresIn}`);
    console.log(`Application Reference: ${appId}`);
    console.log(`Latency: ${latencyMs}ms`);
    console.log("Token Persistence: None (in-memory test only)");
    console.log("Resource Mutations: None (read-only auth check)");
    console.log("==================================================");
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    console.log("\n--- Verification Result ---");
    console.log("Result: ERROR");
    if (err instanceof Error && err.name === "AbortError") {
      console.log("Error: Request timed out after 15,000ms");
    } else if (err instanceof Error) {
      console.log(`Error: ${err.message}`);
    } else {
      console.log("Error: Unknown network failure");
    }
    process.exit(1);
  }
}

runOAuthCheck();
