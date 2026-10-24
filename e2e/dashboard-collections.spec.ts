import { test, expect } from "@playwright/test";

test.describe("Journey A: Dashboard and Collections", () => {
  test("loads dashboard, renders metrics, and navigates to collections", async ({
    page,
    isMobile,
  }) => {
    // 1. Visit Dashboard
    await page.goto("/");
    await expect(page).toHaveTitle(/CashPilot/i);

    // Verify Navi Greeting Callout
    const naviGreeting = page.locator("section[aria-label='Navi AI Assistant Overview']");
    await expect(naviGreeting).toBeVisible();

    // Verify 4 primary metric cards
    const metricsSection = page.locator("section[aria-label='Receivables Metrics']");
    await expect(metricsSection).toBeVisible();
    await expect(metricsSection).toContainText("Outstanding");
    await expect(metricsSection).toContainText("Overdue");
    await expect(metricsSection).toContainText("Due Soon");
    await expect(metricsSection).toContainText("Paid");

    // 2. Navigate to Collections
    if (isMobile) {
      await page.goto("/collections");
    } else {
      await page.locator("a[href='/collections']").first().click();
    }
    await expect(page).toHaveURL(/\/collections/);
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();

    // Collections is board-only — verify Kanban columns are rendered
    await expect(page.getByText("Awaiting Payment", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Overdue", { exact: false }).first()).toBeVisible();
  });

  test("maintains responsive usability on mobile viewport", async ({ page, isMobile }) => {
    await page.goto("/");
    await expect(page.locator("section[aria-label='Receivables Metrics']")).toBeVisible();

    // Collections workspace loads cleanly
    await page.goto("/collections");
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();

    // Check mobile nav bar if in mobile project
    if (isMobile) {
      const mobileNav = page.locator("nav[aria-label='Mobile Navigation']");
      await expect(mobileNav).toBeVisible();
    }
  });
});

test.describe("Collections: Kanban board only", () => {
  test("Collections page renders the Kanban board and does NOT render a Board/Table toggle", async ({
    page,
  }) => {
    await page.goto("/collections");
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();

    // Kanban columns must be present
    await expect(page.getByText("Draft", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Awaiting Payment", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Overdue", { exact: false }).first()).toBeVisible();

    // No Board/Table view toggle must exist on the Collections page
    await expect(page.locator("[aria-label='View Mode']")).not.toBeVisible();

    // No <table> element on the default Collections page
    await expect(page.locator("table")).not.toBeVisible();
  });

  test("Collections page with ?stage param still loads the board", async ({ page }) => {
    // Dashboard deep-links use ?stage=overdue; Collections should still show the board
    await page.goto("/collections?stage=overdue");
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();
    await expect(page.getByText("Overdue", { exact: false }).first()).toBeVisible();
    // Board — no table
    await expect(page.locator("table")).not.toBeVisible();
  });

  test("Invoice cards on the board link to invoice detail pages", async ({ page }) => {
    await page.goto("/collections");
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();

    // At least one card link to /invoices/[id] must exist
    const invoiceLink = page.locator("a[href^='/invoices/demo-invoice-']").first();
    await expect(invoiceLink).toBeVisible();
    await invoiceLink.click();

    await expect(page).toHaveURL(/\/invoices\/demo-invoice-/);
    await expect(page.getByRole("heading", { name: "Invoice", exact: true })).toBeVisible();
    await expect(page.locator("text=Grand Total:")).toBeVisible();
  });
});

test.describe("Navigation: Invoices directory page", () => {
  test("Invoices nav link opens the dedicated invoice directory at /invoices", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/");

    if (isMobile) {
      await page.goto("/invoices");
    } else {
      // Desktop nav: click the Invoices link (not the /invoices/new CTA button)
      await page.locator("nav[aria-label='Main Navigation'] a[href='/invoices']").first().click();
    }

    await expect(page).toHaveURL("/invoices");
    await expect(page.locator("h1").filter({ hasText: "Invoices" })).toBeVisible();
    await expect(page.locator("table")).toBeVisible();
  });

  test("Invoices directory is separate from the Collections Board URL", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page).toHaveURL("/invoices");
    await expect(page).not.toHaveURL(/\/collections/);
    await expect(page.locator("table")).toBeVisible();
  });

  test("Invoices directory shows all status filter tabs", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    const tabList = page.locator("[role='tablist']");
    await expect(tabList).toBeVisible();
    await expect(tabList.locator("button", { hasText: "All" })).toBeVisible();
    await expect(tabList.locator("button", { hasText: "Draft" })).toBeVisible();
    await expect(tabList.locator("button", { hasText: "Overdue" })).toBeVisible();
    await expect(tabList.locator("button", { hasText: "Paid" })).toBeVisible();
  });

  test("Invoices directory navigates to invoice detail", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    const invoiceLink = page.locator("a[href^='/invoices/demo-invoice-']").first();
    await expect(invoiceLink).toBeVisible();
    await invoiceLink.click();

    await expect(page).toHaveURL(/\/invoices\/demo-invoice-/);
    await expect(page.getByRole("heading", { name: "Invoice", exact: true })).toBeVisible();
    await expect(page.locator("text=Grand Total:")).toBeVisible();
    await expect(page.locator("text=Line Items & Financial Calculation")).toBeVisible();
  });

  test("Invoices nav link is marked active when on /invoices", async ({ page }) => {
    await page.goto("/invoices");
    const invoicesLink = page
      .locator("nav[aria-label='Main Navigation'] a[href='/invoices']")
      .first();
    await expect(invoicesLink).toHaveAttribute("aria-current", "page");
  });

  test("Collections nav link is active on /collections and inactive on /invoices", async ({
    page,
  }) => {
    await page.goto("/collections");
    const collectionsLink = page
      .locator("nav[aria-label='Main Navigation'] a[href='/collections']")
      .first();
    await expect(collectionsLink).toHaveAttribute("aria-current", "page");

    await page.goto("/invoices");
    const collectionsLinkAgain = page
      .locator("nav[aria-label='Main Navigation'] a[href='/collections']")
      .first();
    await expect(collectionsLinkAgain).not.toHaveAttribute("aria-current", "page");
  });
});

test.describe("Invoices UX Improvements: Clickable row, URL-driven filters & search", () => {
  test("Entire invoice row is clickable and navigates to the invoice detail page", async ({
    page,
  }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    // Locate the first row in the tbody
    const firstRow = page.locator("tbody tr").first();
    await expect(firstRow).toBeVisible();

    // Verify hover and accessibility attributes
    await expect(firstRow).toHaveAttribute("tabindex", "0");
    await expect(firstRow).toHaveClass(/cursor-pointer/);

    // Click specifically on the client name cell (non-link area)
    const clientCell = firstRow.locator("td").nth(1);
    await clientCell.click();

    // Must navigate to the invoice detail page
    await expect(page).toHaveURL(/\/invoices\/demo-invoice-/);
    await expect(page.getByRole("heading", { name: "Invoice", exact: true })).toBeVisible();
    await expect(page.locator("text=Grand Total:")).toBeVisible();
  });

  test("Pressing Enter on a focused invoice row navigates to the invoice detail page", async ({
    page,
  }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    const firstRow = page.locator("tbody tr").first();
    await firstRow.focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/invoices\/demo-invoice-/);
    await expect(page.getByRole("heading", { name: "Invoice", exact: true })).toBeVisible();
  });

  test("Clicking the View action button navigates to detail without duplicate navigation", async ({
    page,
  }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    let navigationCount = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && frame.url().includes("/invoices/demo-invoice-")) {
        navigationCount++;
      }
    });

    const viewButton = page.locator("tbody tr").first().locator("a", { hasText: "View" });
    await expect(viewButton).toBeVisible();
    await viewButton.click();

    await expect(page).toHaveURL(/\/invoices\/demo-invoice-/);
    // Ensure only 1 main frame navigation occurred
    expect(navigationCount).toBe(1);
  });

  test("Status filter tabs update the URL and survive page refresh", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    // 1. Click Paid tab -> URL should update to /invoices?status=paid
    const paidTab = page.locator("[role='tablist'] button", { hasText: "Paid" });
    await paidTab.click();
    await expect(page).toHaveURL("/invoices?status=paid");
    await expect(paidTab).toHaveAttribute("aria-selected", "true");

    // 2. Click Draft tab -> URL should update to /invoices?status=draft
    const draftTab = page.locator("[role='tablist'] button", { hasText: "Draft" });
    await draftTab.click();
    await expect(page).toHaveURL("/invoices?status=draft");
    await expect(draftTab).toHaveAttribute("aria-selected", "true");

    // 3. Click Overdue tab -> URL should update to /invoices?status=overdue
    const overdueTab = page.locator("[role='tablist'] button", { hasText: "Overdue" });
    await overdueTab.click();
    await expect(page).toHaveURL("/invoices?status=overdue");
    await expect(overdueTab).toHaveAttribute("aria-selected", "true");

    // 4. Reload page on /invoices?status=overdue -> Overdue filter remains active
    await page.reload();
    await expect(page).toHaveURL("/invoices?status=overdue");
    const reloadedOverdueTab = page.locator("[role='tablist'] button", { hasText: "Overdue" });
    await expect(reloadedOverdueTab).toHaveAttribute("aria-selected", "true");

    // 5. Click All tab -> canonical URL /invoices (no status param)
    const allTab = page.locator("[role='tablist'] button", { hasText: "All" });
    await allTab.click();
    await expect(page).toHaveURL("/invoices");
    await expect(allTab).toHaveAttribute("aria-selected", "true");
  });

  test("Browser Back and Forward buttons correctly restore filter states", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    // Start at All -> click Paid
    await page.locator("[role='tablist'] button", { hasText: "Paid" }).click();
    await expect(page).toHaveURL("/invoices?status=paid");

    // Click Draft
    await page.locator("[role='tablist'] button", { hasText: "Draft" }).click();
    await expect(page).toHaveURL("/invoices?status=draft");

    // Browser Back -> returns to Paid
    await page.goBack();
    await expect(page).toHaveURL("/invoices?status=paid");
    await expect(page.locator("[role='tablist'] button", { hasText: "Paid" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Browser Back -> returns to canonical All
    await page.goBack();
    await expect(page).toHaveURL("/invoices");
    await expect(page.locator("[role='tablist'] button", { hasText: "All" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Browser Forward -> restores Paid
    await page.goForward();
    await expect(page).toHaveURL("/invoices?status=paid");
    await expect(page.locator("[role='tablist'] button", { hasText: "Paid" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  test("Invalid status parameter safely falls back to default All view", async ({ page }) => {
    await page.goto("/invoices?status=invalid_random_filter");
    await expect(page.locator("table")).toBeVisible();

    // All tab is selected by fallback
    const allTab = page.locator("[role='tablist'] button", { hasText: "All" });
    await expect(allTab).toHaveAttribute("aria-selected", "true");

    // Table displays invoices without error
    const rowCount = await page.locator("tbody tr").count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test("Search filters by full and partial invoice number, client name, and email", async ({
    page,
  }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    const searchInput = page.getByRole("searchbox", { name: "Search invoices" });

    // 1. Search by invoice identifier (demo-invoice-3)
    await searchInput.fill("demo-invoice-3");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr").first()).toContainText("TechStart Inc");

    // 2. Search by client name
    await searchInput.fill("TechStart");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr").first()).toContainText("TechStart Inc");

    // 3. Search by client email
    await searchInput.fill("billing-sandbox@techstart.example.com");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr").first()).toContainText("TechStart Inc");

    // 4. Search by partial query (case-insensitive)
    await searchInput.fill("techstart");
    await expect(page.locator("tbody tr")).toHaveCount(1);

    // 5. Clear search restores full list
    await searchInput.fill("");
    const allRows = await page.locator("tbody tr").count();
    expect(allRows).toBeGreaterThan(1);
  });

  test("Search query is preserved when changing status filter, and vice versa", async ({
    page,
  }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    const searchInput = page.getByRole("searchbox", { name: "Search invoices" });

    // Type search query and press Enter to flush to URL
    await searchInput.fill("Smith");
    await searchInput.press("Enter");

    // URL should have ?q=Smith
    await expect(page).toHaveURL(/q=Smith/);

    // Click Due Soon tab -> URL should retain q and include status=due_soon
    await page.locator("[role='tablist'] button", { hasText: "Due Soon" }).click();
    await expect(page).toHaveURL("/invoices?status=due_soon&q=Smith");

    // Search input should still contain "Smith"
    await expect(searchInput).toHaveValue("Smith");

    // Click All tab -> URL should be /invoices?q=Smith (canonical All with search query)
    await page.locator("[role='tablist'] button", { hasText: "All" }).click();
    await expect(page).toHaveURL("/invoices?q=Smith");
    await expect(searchInput).toHaveValue("Smith");
  });
});
