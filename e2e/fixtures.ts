import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { db } from "@/lib/db/client";
import { CashPilotStatus, OperationType, OperationAttemptState } from "@prisma/client";

export const E2E_WORKSPACE_ID = "demo-workspace-1";
export const E2E_CLIENT_ID = "demo-client-1";

export const E2E_SEND_INVOICE_ID = "e2e-test-send-invoice";
export const E2E_REMIND_CANCEL_INVOICE_ID = "e2e-test-remind-cancel-invoice";

export async function setupSendTestInvoice() {
  // Ensure workspace and client exist
  await db.workspace.upsert({
    where: { id: E2E_WORKSPACE_ID },
    update: {},
    create: {
      id: E2E_WORKSPACE_ID,
      name: "Demo Studio",
      ownerId: "demo-user-1",
      isDemo: true,
    },
  });

  await db.client.upsert({
    where: { id: E2E_CLIENT_ID },
    update: {},
    create: {
      id: E2E_CLIENT_ID,
      workspaceId: E2E_WORKSPACE_ID,
      name: "Acme Studios Inc",
      email: "finance@acme-e2e.example.com",
      isDemo: true,
    },
  });

  // Delete existing test invoice if any to start fresh
  await db.activityEvent.deleteMany({ where: { invoiceId: E2E_SEND_INVOICE_ID } });
  await db.approval.deleteMany({ where: { invoiceId: E2E_SEND_INVOICE_ID } });
  await db.externalOperation.deleteMany({ where: { invoiceId: E2E_SEND_INVOICE_ID } });
  await db.invoiceLineItem.deleteMany({ where: { invoiceId: E2E_SEND_INVOICE_ID } });
  await db.invoice.deleteMany({ where: { id: E2E_SEND_INVOICE_ID } });

  const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  return db.invoice.create({
    data: {
      id: E2E_SEND_INVOICE_ID,
      workspaceId: E2E_WORKSPACE_ID,
      clientId: E2E_CLIENT_ID,
      number: "INV-E2E-SEND-01",
      title: "Website Overhaul Sprint 1",
      currency: "USD",
      subtotalMinorUnits: 50000,
      taxRateBasisPoints: 0,
      taxMinorUnits: 0,
      totalMinorUnits: 50000,
      dueDate,
      cashpilotStatus: CashPilotStatus.DRAFT,
      paypalInvoiceId: "INV2-E2E-DRAFT-SEND-01",
      paypalStatus: "DRAFT",
      isDemoData: true,
      lineItems: {
        create: [
          {
            description: "Frontend Core Modules",
            quantity: 1,
            unitPriceMinorUnits: 50000,
            totalMinorUnits: 50000,
            sortOrder: 0,
          },
        ],
      },
    },
  });
}

export async function setupRemindCancelTestInvoice(options: { withCooldown?: boolean } = {}) {
  await db.workspace.upsert({
    where: { id: E2E_WORKSPACE_ID },
    update: {},
    create: {
      id: E2E_WORKSPACE_ID,
      name: "Demo Studio",
      ownerId: "demo-user-1",
      isDemo: true,
    },
  });

  await db.client.upsert({
    where: { id: E2E_CLIENT_ID },
    update: {},
    create: {
      id: E2E_CLIENT_ID,
      workspaceId: E2E_WORKSPACE_ID,
      name: "Acme Studios Inc",
      email: "finance@acme-e2e.example.com",
      isDemo: true,
    },
  });

  // Clean prior records
  await db.activityEvent.deleteMany({ where: { invoiceId: E2E_REMIND_CANCEL_INVOICE_ID } });
  await db.approval.deleteMany({ where: { invoiceId: E2E_REMIND_CANCEL_INVOICE_ID } });
  await db.externalOperation.deleteMany({ where: { invoiceId: E2E_REMIND_CANCEL_INVOICE_ID } });
  await db.invoiceLineItem.deleteMany({ where: { invoiceId: E2E_REMIND_CANCEL_INVOICE_ID } });
  await db.invoice.deleteMany({ where: { id: E2E_REMIND_CANCEL_INVOICE_ID } });

  const dueDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

  const invoice = await db.invoice.create({
    data: {
      id: E2E_REMIND_CANCEL_INVOICE_ID,
      workspaceId: E2E_WORKSPACE_ID,
      clientId: E2E_CLIENT_ID,
      number: "INV-E2E-SENT-02",
      title: "Mobile App Consulting",
      currency: "USD",
      subtotalMinorUnits: 75000,
      taxRateBasisPoints: 0,
      taxMinorUnits: 0,
      totalMinorUnits: 75000,
      dueDate,
      cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
      paypalInvoiceId: "INV2-E2E-SENT-02",
      paypalStatus: "SENT",
      syncIsStale: false,
      lastSyncAt: new Date(),
      isDemoData: true,
      lineItems: {
        create: [
          {
            description: "Architecture Assessment",
            quantity: 1,
            unitPriceMinorUnits: 75000,
            totalMinorUnits: 75000,
            sortOrder: 0,
          },
        ],
      },
    },
  });

  if (options.withCooldown) {
    await db.externalOperation.create({
      data: {
        workspaceId: E2E_WORKSPACE_ID,
        invoiceId: E2E_REMIND_CANCEL_INVOICE_ID,
        operationType: OperationType.SEND_REMINDER,
        attemptState: OperationAttemptState.SUCCESS,
        attemptedAt: new Date(Date.now() - 3600000), // 1 hour ago
        completedAt: new Date(Date.now() - 3600000),
        idempotencyKey: `remind-cooldown-${Date.now()}`,
      },
    });
  }

  return invoice;
}

export async function deleteInvoiceById(id: string) {
  if (!id) return;
  await db.activityEvent.deleteMany({ where: { invoiceId: id } }).catch(() => {});
  await db.approval.deleteMany({ where: { invoiceId: id } }).catch(() => {});
  await db.externalOperation.deleteMany({ where: { invoiceId: id } }).catch(() => {});
  await db.invoiceLineItem.deleteMany({ where: { invoiceId: id } }).catch(() => {});
  await db.invoice.deleteMany({ where: { id: id } }).catch(() => {});
}

export async function cleanupE2EInvoices() {
  for (const id of [E2E_SEND_INVOICE_ID, E2E_REMIND_CANCEL_INVOICE_ID]) {
    await db.activityEvent.deleteMany({ where: { invoiceId: id } }).catch(() => {});
    await db.approval.deleteMany({ where: { invoiceId: id } }).catch(() => {});
    await db.externalOperation.deleteMany({ where: { invoiceId: id } }).catch(() => {});
    await db.invoiceLineItem.deleteMany({ where: { invoiceId: id } }).catch(() => {});
    await db.invoice.deleteMany({ where: { id } }).catch(() => {});
  }
}
