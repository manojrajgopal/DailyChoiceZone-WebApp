import { afterEach, describe, expect, it } from "vitest";

import type { ProductAvailability as Answer } from "@/services/discoveryService";
import { api, fail, networkError } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";

import { ProductAvailability, resetAvailabilityCache } from "./ProductAvailability";

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    productId: "P1",
    pincode: "560001",
    valid: true,
    available: true,
    status: "available",
    message: "Available for delivery",
    deliverable: true,
    inventoryAvailable: true,
    inventoryScope: "product",
    maxQuantity: 10,
    variant: { size: "M", color: "Black", needsSize: false },
    location: { city: "Bengaluru", district: "", state: "Karnataka", listed: true },
    estimatedDelivery: { dispatchBy: "2026-10-02", from: "2026-10-05", to: "2026-10-07", label: "5–7 Oct", latestLabel: "Wed, 7 Oct" },
    codAvailable: true,
    cod: { available: true, fee: null, maxOrderValue: null, reason: "" },
    expressAvailable: true,
    express: {
      available: true,
      estimatedDelivery: { dispatchBy: "2026-10-02", from: "2026-10-05", to: "2026-10-05", label: "Mon, 5 Oct", latestLabel: "Mon, 5 Oct" },
      fee: 149,
    },
    deliveryFee: 49,
    standardDeliveryFee: 49,
    freeDeliveryThreshold: 999,
    freeDelivery: false,
    dispatch: { cutoffHour: 14, handlingDays: 0 },
    note: "",
    ...overrides,
  };
}

function setup(props: Partial<Parameters<typeof ProductAvailability>[0]> = {}) {
  return renderUI(
    <ProductAvailability productId="P1" size="M" color="Black" quantity={1} needsSize {...props} />,
  );
}

afterEach(() => resetAvailabilityCache());

describe("ProductAvailability", () => {
  it("checks the chosen variant at a pincode and shows the terms", async () => {
    api.get("/products/P1/availability", answer());
    const { user } = setup({ quantity: 2 });
    await user.type(screen.getByLabelText("Delivery pincode"), "560001");
    await user.click(screen.getByRole("button", { name: "Check" }));

    expect(await screen.findByText("Available for delivery to 560001 (Bengaluru, Karnataka)")).toBeInTheDocument();
    expect(screen.getByText("5–7 Oct")).toBeInTheDocument();
    expect(screen.getByText("₹49")).toBeInTheDocument();
    expect(screen.getByText("By Mon, 5 Oct")).toBeInTheDocument();
    const request = api.last("GET", "/products/P1/availability")!;
    expect(request.query.get("pincode")).toBe("560001");
    expect(request.query.get("size")).toBe("M");
    expect(request.query.get("color")).toBe("Black");
    expect(request.query.get("quantity")).toBe("2");
    // Remembered for next time, on this device.
    expect(localStorage.getItem("dcz.pincode")).toBe("560001");
  });

  it("says when cash on delivery and express aren't offered, and why", async () => {
    api.get("/products/P1/availability", answer({
      codAvailable: false,
      cod: { available: false, fee: null, maxOrderValue: null, reason: "Cash on delivery isn't available for this item." },
      expressAvailable: false,
      express: { available: false, estimatedDelivery: null, fee: null },
      deliveryFee: 0,
      freeDelivery: true,
    }));
    const { user } = setup();
    await user.type(screen.getByLabelText("Delivery pincode"), "560001{Enter}");
    expect(await screen.findByText(/isn't available for this item/)).toBeInTheDocument();
    expect(screen.getAllByText("Not available")).toHaveLength(2);
    expect(screen.getByText("Free")).toBeInTheDocument();
  });

  it.each([
    ["not-serviceable", false, "Sorry, we don't deliver to this pincode yet."],
    ["restricted", true, "Fragile: not sent to the North-East"],
    ["out-of-stock", true, "Linen Shirt is out of stock."],
  ] as const)("shows %s as a problem", async (status, deliverable, text) => {
    api.get("/products/P1/availability", answer({
      status, available: false, deliverable: status === "restricted" ? false : deliverable, message: text,
    }));
    const { user } = setup();
    await user.type(screen.getByLabelText("Delivery pincode"), "799001{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("asks for a size when none is chosen", async () => {
    api.get("/products/P1/availability", answer({ status: "select-variant", available: false,
      variant: { size: null, color: "Black", needsSize: true } }));
    const { user } = setup({ size: null });
    await user.type(screen.getByLabelText("Delivery pincode"), "560001{Enter}");
    expect(await screen.findByText(/Choose a size to check it's in stock/)).toBeInTheDocument();
    expect(api.last("GET", "/products/P1/availability")!.query.get("size")).toBeNull();
  });

  it("refuses a malformed pincode without asking the server", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Delivery pincode"), "012{Enter}");
    expect(screen.getByText("Enter a valid 6-digit pincode.")).toBeInTheDocument();
    expect(api.requests("GET", /availability/)).toHaveLength(0);
  });

  it("says so when the check fails", async () => {
    api.get("/products/P1/availability", networkError());
    const { user } = setup();
    await user.type(screen.getByLabelText("Delivery pincode"), "560001{Enter}");
    // The client turns "no answer at all" into its own offline message.
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t connect/i);
  });

  it("shows the server's own message for a refused check", async () => {
    api.get("/products/P1/availability", fail(429, "Too many pincode checks. Please wait a moment.", "RATE_LIMITED"));
    const { user } = setup();
    await user.type(screen.getByLabelText("Delivery pincode"), "560001{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many pincode checks");
  });

  it("checks again when the variant changes, and reuses an answer it already has", async () => {
    api.get("/products/P1/availability", answer());
    const { user, rerender } = setup();
    await user.type(screen.getByLabelText("Delivery pincode"), "560001{Enter}");
    await screen.findByText(/Available for delivery/);
    rerender(<ProductAvailability productId="P1" size="L" color="Black" quantity={1} needsSize />);
    await waitFor(() => expect(api.requests("GET", "/products/P1/availability")).toHaveLength(2));
    rerender(<ProductAvailability productId="P1" size="M" color="Black" quantity={1} needsSize />);
    await screen.findByText(/Available for delivery/);
    expect(api.requests("GET", "/products/P1/availability")).toHaveLength(2);
  });

  it("checks the pincode remembered from last time", async () => {
    localStorage.setItem("dcz.pincode", "560001");
    api.get("/products/P1/availability", answer());
    setup();
    expect(await screen.findByText(/Available for delivery/)).toBeInTheDocument();
  });
});
