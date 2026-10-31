import { NextRequest, NextResponse } from "next/server";
import { authorizeWorkspaceAccess } from "@/lib/auth/guard";
import {
  getWorkspaceActivityFeed,
  getInvoiceEndToEndTrace,
  getWorkspaceInvoicesForActivitySelector,
  type ActivityFilterOptions,
} from "@/lib/services/activity.service";

/**
 * GET /api/activity
 *
 * Retrieves the append-only activity and audit feed for the caller's workspace.
 *
 * Invariants (SRS §4, §5 & UI Design Reference Page 15):
 *   - Server-side authorization guard: Enforces workspace boundary; prevents cross-workspace inspection (403 Forbidden).
 *   - Append-only integrity: Read-only access to persisted activity events.
 *   - Zero-secret privacy: Never returns tokens, passwords, or payment credentials.
 *   - Dual-mode auditing: Returns the date-grouped activity stream plus optional 5-step invoice trace.
 */
export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const requestedWorkspaceId = url.searchParams.get("workspaceId");

    // 1. Enforce server-side authorization guard
    const auth = await authorizeWorkspaceAccess(req, requestedWorkspaceId);
    if (!auth.authorized) {
      return NextResponse.json(
        { success: false, error: auth.error, code: auth.code },
        { status: auth.status }
      );
    }

    const workspaceId = auth.context.workspaceId;
    const actorId = auth.context.actorId;

    // 2. Parse query parameters
    const invoiceId = url.searchParams.get("invoiceId") || undefined;
    const typeParam = url.searchParams.get("type");
    const resultParam = url.searchParams.get("result");
    const search = url.searchParams.get("search") || undefined;
    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");

    const limit = limitParam ? parseInt(limitParam, 10) : 50;
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

    const filterOptions: ActivityFilterOptions = {
      invoiceId,
      search,
      limit: isNaN(limit) ? 50 : Math.min(Math.max(limit, 1), 100),
      offset: isNaN(offset) ? 0 : Math.max(offset, 0),
    };

    if (
      typeParam &&
      ["all", "ai", "approval", "operation", "sync", "security"].includes(typeParam)
    ) {
      filterOptions.type = typeParam as ActivityFilterOptions["type"];
    }

    if (
      resultParam &&
      ["all", "confirmed", "approved", "proposed", "partial", "rejected", "unknown"].includes(
        resultParam
      )
    ) {
      filterOptions.result = resultParam as ActivityFilterOptions["result"];
    }

    // 3. Query feed, selector options, and optional invoice trace in parallel
    const [feedResult, selectorOptions] = await Promise.all([
      getWorkspaceActivityFeed(workspaceId, actorId, filterOptions),
      getWorkspaceInvoicesForActivitySelector(workspaceId),
    ]);

    // Target invoice for trace: explicit param, or first option in selector
    const targetInvoiceId = invoiceId || selectorOptions[0]?.id;
    let invoiceTrace = null;
    if (targetInvoiceId) {
      invoiceTrace = await getInvoiceEndToEndTrace(workspaceId, targetInvoiceId);
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          items: feedResult.items,
          totalCount: feedResult.totalCount,
          hasMore: feedResult.hasMore,
          invoiceTrace,
          selectorOptions,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
        code: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
