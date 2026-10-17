/**
 * CashPilot AI — Database Seed Script
 *
 * Creates clearly labeled demo/fixture data for development and demo purposes.
 * SRS §4: Small seed/demo dataset clearly distinguishable from provider-confirmed records.
 *
 * Run with: npm run db:seed
 */

import { PrismaClient, CashPilotStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding CashPilot demo data...");

  // ── Demo Workspace ─────────────────────────────────────────────────────────
  const workspace = await prisma.workspace.upsert({
    where: { id: "demo-workspace-1" },
    update: {},
    create: {
      id: "demo-workspace-1",
      name: "My Freelance Studio",
      ownerId: "demo-user-1",
      isDemo: true,
    },
  });

  console.log(`✅ Workspace: ${workspace.name} (${workspace.id})`);

  // ── Demo Clients ──────────────────────────────────────────────────────────
  const clients = await Promise.all([
    prisma.client.upsert({
      where: { id: "demo-client-1" },
      update: {},
      create: {
        id: "demo-client-1",
        workspaceId: workspace.id,
        name: "Acme Corporation",
        email: "accounts@acme-sandbox.example.com",
        company: "Acme Corp",
        isDemo: true,
      },
    }),
    prisma.client.upsert({
      where: { id: "demo-client-2" },
      update: {},
      create: {
        id: "demo-client-2",
        workspaceId: workspace.id,
        name: "Jane Smith",
        email: "jane.smith-sandbox@example.com",
        company: "Smith & Associates",
        isDemo: true,
      },
    }),
    prisma.client.upsert({
      where: { id: "demo-client-3" },
      update: {},
      create: {
        id: "demo-client-3",
        workspaceId: workspace.id,
        name: "TechStart Inc",
        email: "billing-sandbox@techstart.example.com",
        company: "TechStart Inc",
        isDemo: true,
      },
    }),
  ]);

  console.log(`✅ Clients: ${clients.map((c) => c.name).join(", ")}`);

  // ── Demo Invoices ─────────────────────────────────────────────────────────
  // Invoice totals are COMPUTED in seed, not arbitrary — matches money.ts rules.
  // All financial values are integer minor units (cents).

  const today = new Date();
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
  const subtractDays = (d: Date, n: number) => addDays(d, -n);

  const demoInvoices = [
    {
      id: "demo-invoice-1",
      clientId: clients[0].id,
      title: "UX Design Services — Q4 2026",
      currency: "USD",
      lineItems: [
        { description: "UX Research and Wireframes", quantity: 20, unitPriceMinorUnits: 15000 },
        { description: "Prototype Design", quantity: 15, unitPriceMinorUnits: 17500 },
      ],
      taxRateBasisPoints: 0,
      dueDate: addDays(today, 14),
      cashpilotStatus: CashPilotStatus.DRAFT,
      isDemoData: true,
    },
    {
      id: "demo-invoice-2",
      clientId: clients[1].id,
      title: "Brand Strategy Consulting",
      currency: "USD",
      lineItems: [
        { description: "Brand Identity Workshop", quantity: 8, unitPriceMinorUnits: 25000 },
        { description: "Style Guide Document", quantity: 1, unitPriceMinorUnits: 150000 },
      ],
      taxRateBasisPoints: 0,
      dueDate: addDays(today, 5), // DUE_SOON
      cashpilotStatus: CashPilotStatus.DUE_SOON,
      paypalStatus: "SENT",
      isDemoData: true,
    },
    {
      id: "demo-invoice-3",
      clientId: clients[2].id,
      title: "Web Development — Sprint 3",
      currency: "USD",
      lineItems: [
        { description: "Frontend Development", quantity: 40, unitPriceMinorUnits: 12500 },
        { description: "Code Review & Testing", quantity: 10, unitPriceMinorUnits: 10000 },
      ],
      taxRateBasisPoints: 0,
      dueDate: subtractDays(today, 15), // OVERDUE
      cashpilotStatus: CashPilotStatus.OVERDUE,
      paypalStatus: "SENT",
      isDemoData: true,
    },
    {
      id: "demo-invoice-4",
      clientId: clients[0].id,
      title: "Logo Design Package",
      currency: "USD",
      lineItems: [
        { description: "Logo Design (3 concepts)", quantity: 1, unitPriceMinorUnits: 250000 },
        { description: "Final Files & Brand Kit", quantity: 1, unitPriceMinorUnits: 75000 },
      ],
      taxRateBasisPoints: 0,
      dueDate: subtractDays(today, 30),
      cashpilotStatus: CashPilotStatus.PAID, // Only pre-seeded as PAID — labeled as fixture
      paypalStatus: "PAID",
      isDemoData: true,
      notes: "[DEMO DATA] This invoice is a fixture record, not PayPal-verified.",
    },
  ];

  for (const inv of demoInvoices) {
    // Compute totals deterministically
    const lineItemTotals = inv.lineItems.map(
      (li) => li.quantity * li.unitPriceMinorUnits
    );
    const subtotalMinorUnits = lineItemTotals.reduce((a, b) => a + b, 0);
    const taxMinorUnits = Math.round(
      (subtotalMinorUnits * inv.taxRateBasisPoints) / 10000
    );
    const totalMinorUnits = subtotalMinorUnits + taxMinorUnits;

    const invoice = await prisma.invoice.upsert({
      where: { id: inv.id },
      update: {},
      create: {
        id: inv.id,
        workspaceId: workspace.id,
        clientId: inv.clientId,
        title: inv.title,
        currency: inv.currency,
        taxRateBasisPoints: inv.taxRateBasisPoints,
        subtotalMinorUnits,
        taxMinorUnits,
        totalMinorUnits,
        dueDate: inv.dueDate,
        cashpilotStatus: inv.cashpilotStatus,
        paypalStatus: inv.paypalStatus ?? null,
        isDemoData: inv.isDemoData,
        notes: inv.notes ?? null,
        lineItems: {
          create: inv.lineItems.map((li, idx) => ({
            description: li.description,
            quantity: li.quantity,
            unitPriceMinorUnits: li.unitPriceMinorUnits,
            totalMinorUnits: lineItemTotals[idx],
            sortOrder: idx,
          })),
        },
      },
    });

    console.log(
      `✅ Invoice: ${invoice.title} — $${(totalMinorUnits / 100).toFixed(2)} (${inv.cashpilotStatus})`
    );
  }

  // ── Seed activity events for demo invoices ────────────────────────────────
  await prisma.activityEvent.createMany({
    data: [
      {
        workspaceId: workspace.id,
        invoiceId: "demo-invoice-2",
        eventType: "OPERATION_SUCCEEDED",
        actorType: "SYSTEM",
        actorId: "seed",
        description: "[DEMO] Invoice sent via PayPal Sandbox (fixture record)",
        metadata: { isDemoData: true },
      },
      {
        workspaceId: workspace.id,
        invoiceId: "demo-invoice-3",
        eventType: "INVOICE_STATUS_CHANGED",
        actorType: "SYSTEM",
        actorId: "seed",
        description: "[DEMO] Invoice moved to OVERDUE (fixture record)",
        metadata: { isDemoData: true, from: "DUE_SOON", to: "OVERDUE" },
      },
    ],
    skipDuplicates: true,
  });

  console.log("\n✅ Demo seed complete.");
  console.log(`⚠️  All seeded data is FIXTURE DATA — not PayPal-verified.`);
  console.log(`   Workspace ID: ${workspace.id}`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
