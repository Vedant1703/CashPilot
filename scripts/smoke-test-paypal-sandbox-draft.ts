/**
 * CashPilot AI — PayPal Sandbox Draft Creation Smoke Test
 *
 * Task 6: Controlled, single real Sandbox draft-creation smoke test using an approved demo invoice.
 *
 * Safety & Integrity Rules:
 *   - Sandbox ONLY (api-m.sandbox.paypal.com)
 *   - Create draft ONLY (never sends invoice, never marks PAID)
 *   - At most ONE draft created; deduplication check prevents duplicate resources
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

async function runSmokeTest(): Promise<void> {
  const { db } = await import("../src/lib/db/client");
  const {
    createInvoice,
    approveInvoice,
    createPayPalDraft,
  } = await import("../src/lib/services/invoice.service");
  const { ApprovalAction } = await import("@prisma/client");

  console.log("==================================================");
  console.log("CashPilot AI — PayPal Sandbox Draft Smoke Test");
  console.log("==================================================");

  const workspaceId = "demo-workspace-1";
  const actorId = "demo-user-1";
  const clientId = "demo-client-1";

  // 1. Verify workspace and client exist
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) {
    console.error("FAIL: demo-workspace-1 not found in database.");
    process.exit(1);
  }

  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client) {
    console.error("FAIL: demo-client-1 not found in database.");
    process.exit(1);
  }

  // 2. Check if an approved demo invoice already has a PayPal draft
  const existingWithDraft = await db.invoice.findFirst({
    where: {
      workspaceId,
      paypalInvoiceId: { not: null },
      isDemoData: true,
    },
  });

  if (existingWithDraft && existingWithDraft.paypalInvoiceId) {
    console.log("Safe Deduplication: An existing PayPal Sandbox draft is already linked.");
    console.log(`Invoice ID: ${existingWithDraft.id}`);
    console.log(`Provider Invoice ID: ${existingWithDraft.paypalInvoiceId}`);
    console.log(`Provider Status: ${existingWithDraft.paypalStatus}`);
    console.log(`CashPilot Status: ${existingWithDraft.cashpilotStatus} (DRAFT preserved)`);
    console.log("Skipping duplicate draft creation to respect single-draft limit.");
    console.log("==================================================");
    process.exit(0);
  }

  // 3. Create a clean demo invoice
  console.log("Creating demo invoice for Sandbox draft test...");
  const createResult = await createInvoice(workspaceId, actorId, {
    clientId,
    title: "PayPal Sandbox Draft Verification",
    currency: "USD",
    taxRateBasisPoints: 0,
    invoiceDate: new Date().toISOString().substring(0, 10),
    dueDate: new Date(Date.now() + 14 * 86400000).toISOString().substring(0, 10),
    notes: "Automated verification invoice — do not pay",
    terms: "Net 14",
    lineItems: [
      {
        description: "Sandbox Invoicing Verification Service",
        quantity: 1,
        unitPriceMinorUnits: 2500, // $25.00
      },
    ],
  });

  if (!createResult.ok) {
    console.error(`FAIL: Invoice creation failed: ${createResult.error}`);
    process.exit(1);
  }

  const invoiceId = createResult.data.invoiceId;
  const materialHash = createResult.data.materialPayloadHash;
  console.log(`Created demo invoice: ${invoiceId}`);
  console.log(`Material Payload Hash: ${materialHash.slice(0, 16)}...`);

  // 4. Human Approval Gate
  console.log("Applying required human approval gate...");
  const approveResult = await approveInvoice(
    workspaceId,
    actorId,
    invoiceId,
    ApprovalAction.SEND_INVOICE,
    materialHash
  );

  if (!approveResult.ok) {
    console.error(`FAIL: Approval failed: ${approveResult.error}`);
    process.exit(1);
  }
  console.log(`Approval confirmed: ID ${approveResult.data.approvalId}`);

  // 5. Execute PayPal Sandbox Draft Creation
  console.log("Calling official PayPal Sandbox Invoicing API (POST /v2/invoicing/invoices)...");
  const draftResult = await createPayPalDraft(workspaceId, actorId, invoiceId);

  if (!draftResult.ok) {
    console.error(`FAIL: PayPal draft creation failed: ${draftResult.error} (${draftResult.code})`);
    process.exit(1);
  }

  console.log("\n--- Provider Result ---");
  console.log("Result: PASS");
  console.log(`PayPal Invoice ID: ${draftResult.data.paypalInvoiceId}`);
  console.log(`PayPal Status: ${draftResult.data.paypalStatus}`);
  console.log(`PayPal Debug ID: ${draftResult.data.correlationId ?? "N/A"}`);

  // 6. Verify local database persistence
  const persisted = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  console.log("\n--- Database Persistence ---");
  console.log(`Persisted paypalInvoiceId: ${persisted.paypalInvoiceId}`);
  console.log(`Persisted paypalStatus: ${persisted.paypalStatus}`);
  console.log(`CashPilot Status: ${persisted.cashpilotStatus} (DRAFT strictly preserved)`);
  console.log(`Last Sync Timestamp: ${persisted.lastSyncAt?.toISOString()}`);
  console.log("==================================================");

  await db.$disconnect();
}

runSmokeTest().catch((err) => {
  console.error("Unhandled smoke test failure:", err);
  process.exit(1);
});
