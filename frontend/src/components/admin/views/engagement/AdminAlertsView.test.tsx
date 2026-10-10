import { describe, expect, it } from "vitest";

import type { AdminAlertRow, WaitingRow } from "@/services/admin/engagementAdminService";
import { api } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, within } from "@/test/render";

import { AdminAlertsView } from "./AdminAlertsView";

const PAGE = { page: 1, page_size: 25, total: 1, total_pages: 1 };

function waitingRow(overrides: Partial<WaitingRow> = {}): WaitingRow {
  return {
    productId: "PRD003",
    product: {
      id: "PRD003", name: "Wireless Earbuds", slug: "wireless-earbuds", sku: "DCZ-EL0003", image: "", price: 3000,
      available: false, stock: 0, status: "out-of-stock",
    },
    size: "", color: "Black", waiting: 4,
    oldest: "2026-10-01T10:00:00Z", newest: "2026-10-05T10:00:00Z",
    ...overrides,
  };
}

function alertRow(overrides: Partial<AdminAlertRow> = {}): AdminAlertRow {
  return {
    id: 7, kind: "stock", status: "active", size: "", color: "Black",
    createdAt: "2026-10-05T10:00:00Z", notifiedAt: null, unsubscribedAt: null,
    product: { id: "PRD003", name: "Wireless Earbuds", slug: "wireless-earbuds", sku: "DCZ-EL0003", image: "", price: 3000, available: false },
    customer: { id: "CUS001", name: "Asha Rao", email: "asha@example.com", phone: "+919876543210" },
    attempts: 0, lastAttemptAt: null, lastError: "", delivery: null,
    ...overrides,
  };
}

describe("AdminAlertsView — waiting customers", () => {
  it("opens on who is waiting for what, most wanted first, with totals", async () => {
    signIn("admin");
    setLocation("/admin/alerts");
    api.get("/admin/alerts/stock/waiting", {
      items: [waitingRow()], pagination: PAGE, summary: { requests: 4, products: 1, customers: 4 },
    });
    renderUI(<AdminAlertsView />);

    expect(await screen.findByRole("link", { name: "Wireless Earbuds" })).toHaveAttribute("href", "/admin/products/edit?id=PRD003");
    expect(screen.getByRole("tab", { name: "Waiting customers" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("4 customers waiting")).toBeInTheDocument();
    const row = screen.getByRole("link", { name: "Wireless Earbuds" }).closest("tr")!;
    expect(within(row).getByText("DCZ-EL0003")).toBeInTheDocument();
    expect(within(row).getByText("4")).toBeInTheDocument();
    expect(within(row).getByText("Out of stock")).toBeInTheDocument();
  });

  it("opens the customers waiting for a product, with their phone numbers", async () => {
    signIn("admin");
    setLocation("/admin/alerts");
    api.get("/admin/alerts/stock/waiting", {
      items: [waitingRow()], pagination: PAGE, summary: { requests: 4, products: 1, customers: 4 },
    });
    const { user } = renderUI(<AdminAlertsView />);
    await user.click(await screen.findByRole("button", { name: "See the customers waiting for Wireless Earbuds" }));

    const href = router.replace.mock.calls.at(-1)?.[0] ?? router.push.mock.calls.at(-1)?.[0];
    const url = new URL(String(href), "http://localhost");
    expect(url.searchParams.get("view")).toBe("list");
    expect(url.searchParams.get("productId")).toBe("PRD003");
    expect(url.searchParams.get("status")).toBe("active");
  });

  it("lists each customer with email and phone", async () => {
    signIn("admin");
    setLocation("/admin/alerts?view=list&productId=PRD003&status=active");
    api.get("/admin/alerts/stock", { items: [alertRow()], pagination: PAGE, counts: { active: 1 } });
    renderUI(<AdminAlertsView />);

    expect(await screen.findByRole("link", { name: "Asha Rao" })).toBeInTheDocument();
    expect(screen.getByText("+919876543210")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Back in stock" })).toHaveAttribute("aria-selected", "true");
    const query = api.last("GET", "/admin/alerts/stock")!.query;
    expect(query.get("productId")).toBe("PRD003");
    expect(query.get("status")).toBe("active");
  });
});
