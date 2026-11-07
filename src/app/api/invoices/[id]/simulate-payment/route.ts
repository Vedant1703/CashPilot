/**
 * CashPilot AI — Demo Payment Simulation Endpoint
 *
 * POST /api/invoices/[id]/simulate-payment
 *
 * Critical Financial Safety Invariants:
 * 1. Strictly restricted to Demo Workspace (demo-workspace-1) and demo user (demo-user-1).
 * 2. Strictly restricted to demo invoices (isDemoData: true).
 * 3. Non-demo workspaces and customer invoices are completely rejected (403 Forbidden).
 * 4. NEVER calls PayPal endpoints, alters paypalStatus, or fabricates PayPal evidence.
 * 5. Amount derived strictly from persisted invoice totals in the database.
 * 6. Disallows simulation for paid, cancelled, or refunded invoices; prevents duplicate simulations.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import {
  simulateDemoPayment,
  DEMO_WORKSPACE_ID,
  DEMO_USER_ID,
} from "@/lib/services/demo.service";
import { db } from "@/lib/db/client";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  if (!id || typeof id !== "string" || id.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: "Invoice ID is required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const invoiceId = id.trim();

  try {
    // 1. Session check
    const session = await getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: "Authentication required to simulate payment.",
          code: "UNAUTHORIZED",
        },
        { status: 401 }
      );
    }

    // 2. Strict actor check: Only demo-user-1 may simulate payment
    if (session.user.id !== DEMO_USER_ID) {
      return NextResponse.json(
        {
          success: false,
          error: "Access denied. Only the demo user may simulate payments.",
          code: "FORBIDDEN_DEMO_SIMULATION",
        },
        { status: 403 }
      );
    }

    // 3. Strict workspace boundary check
    if (!session.workspace || session.workspace.id !== DEMO_WORKSPACE_ID || !session.workspace.isDemo) {
      return NextResponse.json(
        {
          success: false,
          error: "Payment simulation is strictly confined to the Demo Workspace.",
          code: "FORBIDDEN_DEMO_SIMULATION",
        },
        { status: 403 }
      );
    }

    // 4. Verify target invoice exists and is genuine demo data
    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, workspaceId: true, isDemoData: true },
    });

    if (!invoice) {
      return NextResponse.json(
        { success: false, error: "Invoice not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    if (invoice.workspaceId !== DEMO_WORKSPACE_ID || !invoice.isDemoData) {
      return NextResponse.json(
        {
          success: false,
          error: "Payment simulation is strictly forbidden for non-demo invoices.",
          code: "NON_DEMO_INVOICE_REJECTED",
        },
        { status: 403 }
      );
    }

    // 5. Execute safe simulation service
    const result = await simulateDemoPayment({
      invoiceId,
      actorId: session.user.id,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          code: result.code,
        },
        { status: result.status }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: result.data,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Payment simulation endpoint error:", err);
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred while simulating payment.",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
