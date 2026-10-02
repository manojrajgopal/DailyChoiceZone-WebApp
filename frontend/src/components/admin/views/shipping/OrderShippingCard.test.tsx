import { describe, expect, it, vi } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { orderShipping, shipment, shipmentRow } from "@/test/shipping-fixtures";

import { OrderShippingCard } from "./OrderShippingCard";

describe("OrderShippingCard", () => {
  it("shows a placeholder while loading", () => {
    api.get("/admin/orders/ORD042/shipping", () => new Promise(() => undefined));
    renderUI(<OrderShippingCard orderId="ORD042" />);
    expect(screen.getByLabelText("Loading shipping")).toBeInTheDocument();
  });

  it("renders nothing without the shipments permission", async () => {
    api.get("/admin/orders/ORD042/shipping", fail(403, "Forbidden", "FORBIDDEN"));
    const { container } = renderUI(<OrderShippingCard orderId="ORD042" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("offers a retry when the details don't load", async () => {
    api.get("/admin/orders/ORD042/shipping", orderShipping());
    api.once("GET", "/admin/orders/ORD042/shipping", fail(500));
    const { user } = renderUI(<OrderShippingCard orderId="ORD042" />);
    expect(await screen.findByText("Shipping details didn’t load.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Create shipment" })).toBeInTheDocument();
  });

  it("shows the active shipment and lists earlier ones", async () => {
    api.get(
      "/admin/orders/ORD042/shipping",
      orderShipping({
        activeShipmentId: 12,
        canCreate: false,
        shipments: [
          shipmentRow({ id: 9, shipmentNumber: "DCZ-SH-2026-000009", status: "cancelled", statusLabel: "Cancelled" }),
          shipmentRow({ requestStatus: "failed", lastError: "Label API down" }),
        ],
      }),
    );
    renderUI(<OrderShippingCard orderId="ORD042" />);
    expect(await screen.findByText("DCZ-SH-2026-000012")).toBeInTheDocument();
    expect(screen.getByText("Delhivery Surface · AWB 1234567890")).toBeInTheDocument();
    expect(screen.getByText("Expected 9 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText("Courier request failed: Label API down")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open shipment" })).toHaveAttribute("href", "/admin/shipments/detail?id=12");
    expect(screen.getByRole("link", { name: "DCZ-SH-2026-000009" })).toHaveAttribute("href", "/admin/shipments/detail?id=9");
    expect(screen.queryByRole("button", { name: "Create shipment" })).not.toBeInTheDocument();
  });

  it("says AWB pending before the courier has assigned one", async () => {
    api.get("/admin/orders/ORD042/shipping", orderShipping({ activeShipmentId: 12, shipments: [shipmentRow({ awb: "", expectedDeliveryAt: null })] }));
    renderUI(<OrderShippingCard orderId="ORD042" />);
    expect(await screen.findByText("Delhivery Surface · AWB pending")).toBeInTheDocument();
    expect(screen.queryByText(/^Expected/)).not.toBeInTheDocument();
  });

  it("gives the server's reason when a shipment can't be created", async () => {
    api.get("/admin/orders/ORD042/shipping", orderShipping({ canCreate: false, reason: "The order hasn't been paid yet." }));
    renderUI(<OrderShippingCard orderId="ORD042" />);
    expect(await screen.findByText("The order hasn't been paid yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create shipment" })).not.toBeInTheDocument();
  });

  it("falls back to a general reason when the server gives none", async () => {
    api.get("/admin/orders/ORD042/shipping", orderShipping({ canCreate: false, reason: "" }));
    renderUI(<OrderShippingCard orderId="ORD042" />);
    expect(await screen.findByText("A shipment can't be created for this order right now.")).toBeInTheDocument();
  });

  it("creates a shipment from the dialog, then re-reads the order's shipping", async () => {
    const onChanged = vi.fn();
    api.get("/admin/orders/ORD042/shipping", orderShipping({ defaultPackage: { weightGrams: 800, lengthCm: 30, widthCm: 20, heightCm: 5, count: 1, type: "box" } }));
    api.post("/admin/shipments", shipment());
    const { user } = renderUI(<OrderShippingCard orderId="ORD042" onChanged={onChanged} />);

    await user.click(await screen.findByRole("button", { name: "Create shipment" }));
    const dialog = await screen.findByRole("dialog", { name: "Create shipment for #DCZ10042" });
    await user.selectOptions(within(dialog).getByLabelText(/^Service/), "Surface");

    api.get("/admin/orders/ORD042/shipping", orderShipping({ activeShipmentId: 12, canCreate: false, shipments: [shipmentRow()] }));
    await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("link", { name: "Open shipment" })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.last("POST", "/admin/shipments")!.body.orderId).toBe("ORD042");
  });
});
