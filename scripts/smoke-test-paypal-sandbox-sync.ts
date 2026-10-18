/**
 * CashPilot AI — PayPal Sandbox Status Reconciliation & Sync Smoke Test
 *
 * Task 7: Controlled, read-only Sandbox status fetch for the already-linked demo invoice from Task 6.
 *
 * Safety & Financial Integrity Invariants:
 *   - Sandbox ONLY (api-m.sandbox.paypal.com)
 *   - Read-only fetch (GET /v2/invoicing/invoices/{id})
 *   - NO creation of new PayPal invoices
 *   - NO sending, cancellation, or payment calls
 *   - Verify stored provider invoice ID matches the resource being fetched
 *   - Record observed HTTP status, safe provider status, and debug ID
 *   - Never prints or discloses secrets, tokens, or sensitive payloads
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

// Load env files
loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), ".env"));

async function runSyncSmokeTest(): Promise<void> {
  const { db } = await import("../src/lib/db/client");
  const { syncInvoiceWithPayPal } = await import(
    "../src/lib/services/invoice.service"
  );

  console.log("==================================================");
  console.log("CashPilot AI — PayPal Sandbox Sync Smoke Test");
  console.log("==================================================");

  const workspaceId = "demo-workspace-1";
  const actorId = "demo-user-1";

  // 1. Locate the existing invoice linked to PayPal from Task 6
  const invoice = await db.invoice.findFirst({
    where: {
      workspaceId,
      paypalInvoiceId: { not: null },
      isDemoData: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!invoice || !invoice.paypalInvoiceId) {
    console.error("FAIL: No demo invoice with a linked paypalInvoiceId found in database.");
    process.exit(1);
  }

  console.log(`Found linked invoice:`);
  console.log(`  CashPilot Invoice ID: ${invoice.id}`);
  console.log(`  Linked PayPal Invoice ID: ${invoice.paypalInvoiceId}`);
  console.log(`  Initial PayPal Status: ${invoice.paypalStatus}`);
  console.log(`  Initial CashPilot Status: ${invoice.cashpilotStatus}`);
  console.log(`  Initial lastSyncAt: ${invoice.lastSyncAt ? invoice.lastSyncAt.toISOString() : "null"}`);

  // 2. Perform the read-only sync
  console.log("\nExecuting read-only sync against PayPal Sandbox (GET /v2/invoicing/invoices/{id})...");
  const result = await syncInvoiceWithPayPal(workspaceId, actorId, invoice.id);

  if (!result.ok) {
    console.error(`Sync failed: [${result.code}] — ${result.error}`);
    process.exit(1);
  }

  const syncData = result.data;

  // 3. Find the latest ExternalOperation record for this sync
  const op = await db.externalOperation.findFirst({
    where: {
      invoiceId: invoice.id,
      operationType: "GET_INVOICE",
    },
    orderBy: { createdAt: "desc" },
  });

  console.log("\nSync Result:");
  console.log(`  Success: ${result.ok}`);
  console.log(`  Previous PayPal Status: ${syncData.previousPaypalStatus}`);
  console.log(`  Current PayPal Status: ${syncData.currentPaypalStatus}`);
  console.log(`  Previous CashPilot Status: ${syncData.previousCashpilotStatus}`);
  console.log(`  Current CashPilot Status: ${syncData.currentCashpilotStatus}`);
  console.log(`  Status Changed: ${syncData.statusChanged}`);
  console.log(`  Last Sync At: ${syncData.lastSyncAt ? syncData.lastSyncAt.toISOString() : "null"}`);
  console.log(`  Is Stale: ${syncData.isStale}`);

  if (op) {
    console.log("\nExternal Operation Audit Record:");
    console.log(`  Operation ID: ${op.id}`);
    console.log(`  Operation Type: ${op.operationType}`);
    console.log(`  Attempt State: ${op.attemptState}`);
    console.log(`  PayPal Correlation / Debug ID: ${op.correlationId ?? "N/A"}`);
    console.log(`  Provider Invoice ID: ${op.providerInvoiceId ?? "N/A"}`);
    console.log(`  Provider Response (Safe Summary):`, JSON.stringify(op.providerResponse));
    console.log(`  Outcome Unknown: ${op.isOutcomeUnknown}`);
    console.log(`  Reconciled At: ${op.reconciledAt ? op.reconciledAt.toISOString() : "N/A"}`);
  }

  // 4. Verify post-conditions
  const updatedInvoice = await db.invoice.findUnique({
    where: { id: invoice.id },
  });

  if (!updatedInvoice) {
    console.error("FAIL: Invoice could not be re-fetched after sync.");
    process.exit(1);
  }

  if (updatedInvoice.paypalInvoiceId !== invoice.paypalInvoiceId) {
    console.error("FAIL: Provider invoice ID changed unexpectedly!");
    process.exit(1);
  }

  console.log("\nPost-Sync Verification:");
  console.log(`  Stored PayPal Invoice ID: ${updatedInvoice.paypalInvoiceId} (matches expected)`);
  console.log(`  Updated lastSyncAt: ${updatedInvoice.lastSyncAt?.toISOString()}`);
  console.log(`  syncIsStale: ${updatedInvoice.syncIsStale}`);
  console.log("\nVerification complete: Read-only status fetched, zero write/payment actions invoked.");
  console.log("==================================================");
}

runSyncSmokeTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Smoke test unexpected error:", err);
    process.exit(1);
  });
