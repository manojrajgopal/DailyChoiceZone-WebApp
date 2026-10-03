import { describe, expect, it } from "vitest";

import type { DashboardStat } from "@/types/admin";
import { renderUI, screen } from "@/test/render";

import { StatCard } from "./StatCard";

const base: DashboardStat = { id: "s", label: "Revenue", value: 250000, format: "currency", delta: 12.5, href: "/admin/orders", icon: "sales" };

describe("StatCard", () => {
  it("links to its target and shows a compact currency value with a rising delta", () => {
    renderUI(<StatCard stat={base} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/admin/orders");
    expect(link).toHaveTextContent("Revenue");
    // formatCompactINR keeps a single trailing zero (see format.test.ts).
    expect(screen.getByText("₹2.50L")).toBeInTheDocument();
    expect(screen.getByText("+12.5%")).toHaveClass("text-[#0a6b0a]");
    expect(screen.getByText("vs previous period")).toBeInTheDocument();
  });

  it("shows a falling delta without a plus sign", () => {
    renderUI(<StatCard stat={{ ...base, delta: -4 }} />);
    expect(screen.getByText("-4%")).toHaveClass("text-[#a32424]");
  });

  it("treats a zero delta as rising", () => {
    renderUI(<StatCard stat={{ ...base, delta: 0 }} />);
    expect(screen.getByText("+0%")).toBeInTheDocument();
  });

  it("formats plain numbers in the Indian locale and says Current total with no delta", () => {
    renderUI(<StatCard stat={{ ...base, format: "number", value: 1234567, delta: null, icon: "orders" }} />);
    expect(screen.getByText("12,34,567")).toBeInTheDocument();
    expect(screen.getByText("Current total")).toBeInTheDocument();
  });

  it("highlights an alert tile with a positive value as Needs restocking", () => {
    renderUI(<StatCard stat={{ ...base, format: "number", value: 3, delta: null, icon: "alert" }} />);
    expect(screen.getByText("Needs restocking")).toBeInTheDocument();
    expect(screen.getByRole("link").className).toContain("border-[#fab219]/40");
  });

  it("does not alert when the alert value is zero", () => {
    renderUI(<StatCard stat={{ ...base, format: "number", value: 0, delta: null, icon: "alert" }} />);
    expect(screen.getByText("Current total")).toBeInTheDocument();
    expect(screen.getByRole("link").className).not.toContain("border-[#fab219]/40");
  });
});
