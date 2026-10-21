import { describe, it, expect } from "vitest";
import { getDashboardData } from "@/lib/services/dashboard.service";
import { db } from "@/lib/db/client";

describe("Dashboard Data Service Tests", () => {
  it("authorizes and loads dashboard data for existing demo workspace", async () => {
    const result = await getDashboardData("demo-workspace-1", "demo-user-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.workspace.id).toBe("demo-workspace-1");
    expect(result.data.workspace.name).toBe("My Freelance Studio");
    expect(result.data.invoices).toBeInstanceOf(Array);
    expect(result.data.invoices.length).toBeGreaterThan(0);

    // Verify metrics are computed
    expect(result.data.metrics).toBeDefined();
    expect(result.data.metrics.outstanding).toBeDefined();
    expect(typeof result.data.metrics.outstanding.amountMinorUnits).toBe("number");
    expect(result.data.metrics.overdue).toBeDefined();
    expect(result.data.metrics.dueSoon).toBeDefined();
    expect(result.data.metrics.paidThisMonth).toBeDefined();

    // Verify collections are grouped
    expect(result.data.collections.columns.draft).toBeDefined();
    expect(result.data.collections.columns.awaitingPayment).toBeDefined();
    expect(result.data.collections.columns.dueSoon).toBeDefined();
    expect(result.data.collections.columns.overdue).toBeDefined();
    expect(result.data.collections.columns.paid).toBeDefined();
    expect(result.data.collections.tray.needsReview).toBeDefined();
    expect(result.data.collections.tray.cancelled).toBeDefined();
  });

  it("returns 404 for non-existent workspace", async () => {
    const result = await getDashboardData("non-existent-workspace-999", "demo-user-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.status).toBe(404);
    expect(result.error).toContain("Workspace not found");
  });

  it("is strictly read-only: does not create or mutate invoices or operations", async () => {
    const initialOperationsCount = await db.externalOperation.count({
      where: { workspaceId: "demo-workspace-1" },
    });

    const result = await getDashboardData("demo-workspace-1", "demo-user-1");
    expect(result.ok).toBe(true);

    const finalOperationsCount = await db.externalOperation.count({
      where: { workspaceId: "demo-workspace-1" },
    });

    // Zero external operations created during dashboard read
    expect(finalOperationsCount).toBe(initialOperationsCount);
  });
});
