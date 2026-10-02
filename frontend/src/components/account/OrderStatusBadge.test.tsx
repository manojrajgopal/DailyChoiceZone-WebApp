import { describe, expect, it } from "vitest";

import type { OrderStatus } from "@/types";
import { renderUI, screen } from "@/test/render";

import { ORDER_TIMELINE, OrderStatusBadge, statusLabel } from "./OrderStatusBadge";

describe("OrderStatusBadge", () => {
  it.each([
    ["pending", "Order placed", "bg-cream-deep"],
    ["confirmed", "Confirmed", "bg-ink"],
    ["processing", "Processing", "bg-ink"],
    ["packed", "Packed", "bg-ink"],
    ["shipped", "Shipped", "bg-ink"],
    ["in-transit", "In transit", "bg-ink"],
    ["out-for-delivery", "Out for delivery", "bg-ink"],
    ["delivered", "Delivered", "bg-sage-100"],
    ["cancelled", "Cancelled", "bg-ink-200"],
    ["returned", "Returned", "bg-ink-200"],
  ] as [OrderStatus, string, string][])("shows %s as “%s” with its tone", (status, label, toneClass) => {
    renderUI(<OrderStatusBadge status={status} />);
    const badge = screen.getByText(label);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass(toneClass);
  });

  it("falls back to the raw status for one the label map doesn't know", () => {
    renderUI(<OrderStatusBadge status={"weird-status" as OrderStatus} />);
    expect(screen.getByText("weird-status")).toHaveClass("bg-cream-deep");
  });
});

describe("statusLabel", () => {
  it("mirrors customerStageLabel", () => {
    expect(statusLabel("delivered")).toBe("Delivered");
    expect(statusLabel("pending")).toBe("Order placed");
  });

  it("falls back to the raw value for an unknown status", () => {
    expect(statusLabel("nonsense" as OrderStatus)).toBe("nonsense");
  });
});

describe("ORDER_TIMELINE", () => {
  it("lists every flow stage in order, ending at delivered, with no terminal statuses", () => {
    expect(ORDER_TIMELINE).toEqual([
      "pending",
      "confirmed",
      "processing",
      "packed",
      "shipped",
      "in-transit",
      "out-for-delivery",
      "delivered",
    ]);
    expect(ORDER_TIMELINE).not.toContain("cancelled");
    expect(ORDER_TIMELINE).not.toContain("returned");
  });
});
