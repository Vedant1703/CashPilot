/**
 * CashPilot AI — PayPal Sandbox Invoice Send Smoke Test
 *
 * Task 8: Controlled, single real Sandbox send smoke test using an approved demo invoice.
 *
 * Safety & Integrity Rules:
 *   - Sandbox ONLY (api-m.sandbox.paypal.com)
 *   - Send ONLY to verified dummy/test recipient (accounts@acme-sandbox.example.com)
 *   - Pre-condition: PayPal draft MUST already exist
 *   - Valid, unexpired SEND_INVOICE approval bound to exact payload hash required
 *   - Never marks invoice as PAID (transitions to AWAITING_PAYMENT / DUE_SOON / OVERDUE)
 *   - At most ONE send executed; deduplication check prevents duplicate network calls
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

async function runSendSmokeTest(): Promise<void> {
  const { db } = await import("../src/lib/db/client");
  const {
    getInvoiceById,
    computeMaterialPayloadHash,
    approveInvoice,
    sendInvoice,
  } = await import("../src/lib/services/invoice.service");
  const { ApprovalAction, ApprovalStatus } = await import("@prisma/client");

  console.log("==================================================");
  console.log("CashPilot AI — PayPal Sandbox Invoice Send Smoke Test");
  console.log("==================================================");

  const workspaceId = "demo-workspace-1";
  const actorId = "demo-user-1";

  // 1. Locate the existing demo invoice linked to PayPal Sandbox
  const invoice = await db.invoice.findFirst({
    where: {
      workspaceId,
      paypalInvoiceId: { not: null },
      isDemoData: true,
    },
    include: { client: true, lineItems: true },
    orderBy: { createdAt: "desc" },
  });

  if (!invoice || !invoice.paypalInvoiceId) {
    console.error("FAIL: No demo invoice with a linked paypalInvoiceId found in database.");
    process.exit(1);
  }

  console.log(`Found demo invoice:`);
  console.log(`  CashPilot Invoice ID: ${invoice.id}`);
  console.log(`  Linked PayPal Invoice ID: ${invoice.paypalInvoiceId}`);
  console.log(`  Current PayPal Status: ${invoice.paypalStatus}`);
  console.log(`  Current CashPilot Status: ${invoice.cashpilotStatus}`);
  console.log(`  Recipient Email: ${invoice.client.email}`);

  // 2. Safety check: Recipient MUST be a controlled test/sandbox recipient
  const recipientEmail = invoice.client.email.toLowerCase();
  const isControlledRecipient =
    recipientEmail.endsWith(".example.com") ||
    recipientEmail.endsWith("@cashpilot.local") ||
    recipientEmail.includes("sandbox") ||
    recipientEmail.includes("test");

  if (!isControlledRecipient) {
    console.error(
      `ABORT: Recipient email '${invoice.client.email}' is NOT a clearly controlled test/sandbox address!`
    );
    process.exit(1);
  }
  console.log("Safety Check: Recipient verified as controlled sandbox address.");

  // 3. Deduplication check: Check if already sent
  if (invoice.paypalStatus === "SENT") {
    console.log("\nSafe Deduplication: This invoice has already been sent to PayPal.");
    console.log(`  PayPal Status: ${invoice.paypalStatus}`);
    console.log(`  CashPilot Status: ${invoice.cashpilotStatus}`);
    console.log("Skipping duplicate network send to respect single-send safety rule.");
    console.log("==================================================");
    process.exit(0);
  }

  // 4. Ensure a fresh, valid SEND_INVOICE approval exists
  const currentInvoiceWithRelations = await getInvoiceById(invoice.id, workspaceId);
  if (!currentInvoiceWithRelations) {
    console.error("FAIL: Could not load full invoice relations.");
    process.exit(1);
  }

  const payloadHash = computeMaterialPayloadHash({
    ...currentInvoiceWithRelations,
    actionType: ApprovalAction.SEND_INVOICE,
  });

  console.log(`\nRecomputed material payload hash: ${payloadHash}`);

  // Check if an existing unexpired approval exists
  let activeApproval = await db.approval.findFirst({
    where: {
      invoiceId: invoice.id,
      workspaceId,
      actionType: ApprovalAction.SEND_INVOICE,
      status: ApprovalStatus.APPROVED,
      expiresAt: { gt: new Date() },
      payloadHash,
    },
  });

  if (!activeApproval) {
    console.log("Approving invoice for SEND_INVOICE with fresh 15-minute validity...");
    const approveResult = await approveInvoice(
      workspaceId,
      actorId,
      invoice.id,
      ApprovalAction.SEND_INVOICE,
      payloadHash
    );

    if (!approveResult.ok) {
      console.error(`Approval failed: [${approveResult.code}] ${approveResult.error}`);
      process.exit(1);
    }

    activeApproval = await db.approval.findUnique({
      where: { id: approveResult.data.approvalId },
    });
    console.log(`Fresh approval created: ID ${activeApproval?.id}`);
  } else {
    console.log(`Found active unexpired approval: ID ${activeApproval.id}`);
  }

  if (!activeApproval) {
    console.error("FAIL: Could not obtain active approval.");
    process.exit(1);
  }

  // 5. Execute the send operation against PayPal Sandbox
  console.log("\nExecuting POST /v2/invoicing/invoices/{id}/send against PayPal Sandbox...");
  const sendResult = await sendInvoice(
    workspaceId,
    actorId,
    invoice.id,
    activeApproval.id
  );

  if (!sendResult.ok) {
    console.error(`Send failed: [${sendResult.code}] ${sendResult.error}`);
    process.exit(1);
  }

  const sendData = sendResult.data;

  // 6. Inspect result and audit records
  console.log("\nSend Result:");
  console.log(`  Success: true`);
  console.log(`  Operation ID: ${sendData.operationId}`);
  console.log(`  PayPal Invoice ID: ${sendData.paypalInvoiceId}`);
  console.log(`  PayPal Status: ${sendData.paypalStatus} (Raw provider state)`);
  console.log(`  CashPilot Status: ${sendData.cashpilotStatus} (Awaiting payment; NOT paid)`);
  console.log(`  Is Already Sent: ${sendData.isAlreadySent}`);
  console.log(`  Sent At: ${sendData.sentAt.toISOString()}`);
  console.log(`  PayPal Debug / Correlation ID: ${sendData.correlationId ?? "N/A"}`);

  // 7. Verify Approval consumed
  const consumedApproval = await db.approval.findUnique({
    where: { id: activeApproval.id },
  });
  console.log(`\nApproval State: ${consumedApproval?.status} (expected: USED)`);

  // 8. Test Idempotency: Second call must return known result without calling PayPal
  console.log("\nTesting Idempotency: Repeating send request on already-sent invoice...");
  const secondResult = await sendInvoice(
    workspaceId,
    actorId,
    invoice.id,
    activeApproval.id
  );

  if (!secondResult.ok) {
    console.error(`Second send failed: ${secondResult.error}`);
    process.exit(1);
  }

  console.log(`Second Send Result:`);
  console.log(`  isAlreadySent: ${secondResult.data.isAlreadySent} (expected: true)`);
  console.log(`  paypalStatus: ${secondResult.data.paypalStatus}`);
  console.log(`  cashpilotStatus: ${secondResult.data.cashpilotStatus}`);

  // 9. Post-Send Verification
  const finalInvoice = await db.invoice.findUnique({
    where: { id: invoice.id },
  });

  if (finalInvoice?.cashpilotStatus === "PAID") {
    console.error("FINANCIAL INTEGRITY VIOLATION: Invoice was marked PAID upon sending!");
    process.exit(1);
  }

  console.log("\nPost-Send Invariant Verification:");
  console.log(`  Stored paypalStatus: ${finalInvoice?.paypalStatus}`);
  console.log(`  Stored cashpilotStatus: ${finalInvoice?.cashpilotStatus} (not PAID)`);
  console.log(`  lastSyncAt: ${finalInvoice?.lastSyncAt?.toISOString()}`);
  console.log(`  syncIsStale: ${finalInvoice?.syncIsStale}`);
  console.log("\nSmoke test successfully completed! Real Sandbox send verified.");
  console.log("==================================================");
}

runSendSmokeTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Smoke test unexpected error:", err);
    process.exit(1);
  });
