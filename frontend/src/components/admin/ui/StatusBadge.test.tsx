import { describe, expect, it } from "vitest";

import { renderUI, screen } from "@/test/render";

import { DomainStatus, StatusBadge, humanStatus } from "./StatusBadge";

describe("humanStatus", () => {
  it.each([
    ["cod-pending", "Cash on delivery due"],
    ["partially-refunded", "Partly refunded"],
    ["out-for-delivery", "Out for delivery"],
    ["in-transit", "In transit"],
    ["out-of-stock", "Out of stock"],
    ["low-stock", "Low stock"],
    ["in-stock", "In stock"],
    ["replacement-shipped", "Replacement shipped"],
    ["picked-up", "Picked up"],
    ["delivered", "Delivered"],
    ["ready-to-ship-now", "Ready to ship now"],
    ["", ""],
  ])("%s -> %s", (input, expected) => {
    expect(humanStatus(input)).toBe(expected);
  });
});

describe("StatusBadge", () => {
  it("defaults to the neutral tone and merges a class", () => {
    renderUI(<StatusBadge className="x">Draft</StatusBadge>);
    const pill = screen.getByText("Draft");
    expect(pill.className).toContain("bg-admin-raised");
    expect(pill).toHaveClass("x");
  });

  it.each([
    ["good", "bg-[#e8f6e8]"],
    ["warning", "bg-[#fdf3dd]"],
    ["serious", "bg-[#fdeee7]"],
    ["critical", "bg-[#fbeaea]"],
    ["info", "bg-[#e9f1fc]"],
  ] as const)("renders the %s tone", (tone, cls) => {
    renderUI(<StatusBadge tone={tone}>S</StatusBadge>);
    expect(screen.getByText("S").className).toContain(cls);
  });
});

describe("DomainStatus", () => {
  it.each([
    ["order", "delivered", "Delivered", "bg-[#e8f6e8]"],
    ["order", "cancelled", "Cancelled", "bg-[#fbeaea]"],
    ["order", "returned", "Returned", "bg-[#fdeee7]"],
    ["order", "shipped", "Shipped", "bg-[#e9f1fc]"],
    ["payment", "cod-pending", "Cash on delivery due", "bg-[#fdf3dd]"],
    ["payment", "refunded", "Refunded", "bg-[#fdeee7]"],
    ["product", "out-of-stock", "Out of stock", "bg-[#fbeaea]"],
    ["product", "draft", "Draft", "bg-admin-raised"],
    ["stock", "low-stock", "Low stock", "bg-[#fdf3dd]"],
    ["review", "approved", "Approved", "bg-[#e8f6e8]"],
    ["coupon", "scheduled", "Scheduled", "bg-[#e9f1fc]"],
    ["generic", "blocked", "Blocked", "bg-[#fbeaea]"],
    ["order", "mystery", "Mystery", "bg-admin-raised"],
  ] as const)("%s %s reads %s", (domain, status, label, cls) => {
    renderUI(<DomainStatus domain={domain} status={status} className="d" />);
    const pill = screen.getByText(label);
    expect(pill.className).toContain(cls);
    expect(pill).toHaveClass("d");
  });
});
