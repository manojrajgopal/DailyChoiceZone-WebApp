import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AdminNavGroup } from "@/types/admin";

import { setLocation } from "@/test/navigation";

import { AdminSidebar, OPEN_KEY, currentHref, type NavBadges } from "./AdminSidebar";

const BADGES: NavBadges = {
  lowStock: 0, openOrders: 4, pendingReviews: 0, openReturns: 2, openTickets: 0, pendingQuestions: 0,
  referralsInReview: 0, failedNotifications: 0,
};

const GROUPS: AdminNavGroup[] = [
  { id: "nav_overview", heading: "Overview", items: [{ id: "dashboard", label: "Dashboard", href: "/admin/dashboard", icon: "dashboard" }] },
  {
    id: "nav_sales",
    heading: "Sales",
    items: [
      { id: "orders", label: "Orders", href: "/admin/orders", icon: "orders", badge: "openOrders" },
      {
        id: "fulfilment-folder", label: "Fulfilment", href: "", icon: "shipments",
        children: [
          { id: "shipments", label: "Shipments", href: "/admin/shipments", icon: "shipments" },
          { id: "returns", label: "Returns", href: "/admin/returns", icon: "refunds", badge: "openReturns" },
        ],
      },
      {
        id: "payments-folder", label: "Payments", href: "", icon: "billing",
        children: [{
          id: "billing", label: "Billing", href: "/admin/billing", icon: "billing",
          children: [{ id: "invoices", label: "Invoices", href: "/admin/billing/invoices", icon: "invoices" }],
        }],
      },
    ],
  },
  {
    id: "nav_admin",
    heading: "Administration",
    items: [{
      id: "setup-folder", label: "Store setup", href: "", icon: "settings",
      children: [
        { id: "settings", label: "Store settings", href: "/admin/settings", icon: "settings" },
        { id: "site", label: "Site", href: "/admin/settings/site", icon: "site" },
      ],
    }],
  },
];

const draw = () => render(<AdminSidebar groups={GROUPS} badges={BADGES} />);
const link = (name: string) => screen.queryByRole("link", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  window.localStorage.clear();
});

describe("AdminSidebar", () => {
  it("opens only the group holding the current page; the others are collapsed headings", () => {
    setLocation("/admin/dashboard");
    draw();
    expect(link("Dashboard")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Sales" })).toHaveAttribute("aria-expanded", "false");
    expect(link("Orders")).toBeNull();
  });

  it("opens the folders down to a deeply nested page, and only that page is current", () => {
    setLocation("/admin/billing/invoices/INV001");
    draw();
    expect(screen.getByRole("button", { name: /^Payments/ })).toHaveAttribute("aria-expanded", "true");
    expect(link("Invoices")).toHaveAttribute("aria-current", "page");
    expect(link("Billing")).not.toHaveAttribute("aria-current");
    expect(link("Shipments")).toBeNull(); // the Fulfilment folder stays closed
  });

  it("a closed folder carries its children's counts; opened, each child shows its own", async () => {
    setLocation("/admin/orders");
    draw();
    const folder = screen.getByRole("button", { name: /^Fulfilment/ });
    expect(within(folder).getByText("2")).toBeInTheDocument();
    await userEvent.click(folder);
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(within(link("Returns")!).getByText("2")).toBeInTheDocument();
    expect(within(folder).queryByText("2")).toBeNull();
  });

  it("remembers what was opened, across visits", async () => {
    setLocation("/admin/dashboard");
    const { unmount } = draw();
    await userEvent.click(screen.getByRole("button", { name: "Sales" }));
    expect(link("Orders")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(OPEN_KEY)!)).toEqual({ "group:nav_sales": true });
    unmount();
    draw();
    expect(link("Orders")).toBeInTheDocument();
  });

  it("the current group can be collapsed, and reopens when a page inside it is visited", async () => {
    setLocation("/admin/orders");
    const { rerender } = draw();
    await userEvent.click(screen.getByRole("button", { name: "Sales" }));
    expect(link("Orders")).toBeNull();
    setLocation("/admin/shipments");
    rerender(<AdminSidebar groups={GROUPS} badges={BADGES} />);
    expect(link("Shipments")).toHaveAttribute("aria-current", "page");
  });

  it("a link with sub-pages opens them with its own chevron", async () => {
    setLocation("/admin/billing");
    draw();
    expect(link("Invoices")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hide Billing pages" }));
    expect(link("Invoices")).toBeNull();
  });

  it("works when storage is unavailable", async () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("blocked");
    };
    try {
      setLocation("/admin/dashboard");
      draw();
      await userEvent.click(screen.getByRole("button", { name: "Sales" }));
      expect(link("Orders")).toBeInTheDocument();
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe("currentHref", () => {
  it("is the longest matching link, so a settings sub-page doesn't light up Store settings", () => {
    expect(currentHref(GROUPS, "/admin/settings/site")).toBe("/admin/settings/site");
    expect(currentHref(GROUPS, "/admin/settings")).toBe("/admin/settings");
    expect(currentHref(GROUPS, "/admin/orders/detail")).toBe("/admin/orders");
  });

  it("never matches the dashboard for other pages, nor a folder", () => {
    expect(currentHref(GROUPS, "/admin/dashboard/x")).toBe("");
    expect(currentHref(GROUPS, "/admin/unknown")).toBe("");
  });
});
