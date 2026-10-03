import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";
import { signInCustomer } from "@/test/sliceD-cart-fixtures";
import { CartAvailabilityNotice, useCartAvailability } from "@/components/checkout/CartAvailabilityNotice";
import type { CartAvailability } from "@/services/discoveryService";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";
import { useSavedForLaterStore } from "@/store/savedForLaterStore";

import { GuestDataSync } from "./GuestDataSync";

describe("GuestDataSync", () => {
  it("does nothing for a guest", () => {
    useRecentlyViewedStore.getState().record("P1");
    renderUI(<GuestDataSync />);
    expect(api.requests("POST", /merge/)).toHaveLength(0);
    expect(useRecentlyViewedStore.getState().productIds).toEqual(["P1"]);
  });

  it("hands a guest's history and saved lines to the account at sign-in, then forgets them locally", async () => {
    useRecentlyViewedStore.setState({ productIds: ["P2", "P1"], viewedAt: { P2: 2000, P1: 1000 } });
    useSavedForLaterStore.getState().save({ productId: "P3", size: "M", quantity: 2 });
    signInCustomer();
    api.post("/recently-viewed/merge", { merged: 2, skipped: 0 });
    api.post("/cart/saved/merge", { items: [], limit: 100, merged: 1, skipped: 0 });

    renderUI(<GuestDataSync />);

    await waitFor(() => expect(useSavedForLaterStore.getState().lines).toEqual([]));
    expect(api.last("POST", "/recently-viewed/merge")?.body).toEqual({
      items: [{ productId: "P2", viewedAt: 2000 }, { productId: "P1", viewedAt: 1000 }],
    });
    expect(api.last("POST", "/cart/saved/merge")?.body).toEqual({
      items: [{ productId: "P3", size: "M", color: null, quantity: 2 }],
    });
    expect(useRecentlyViewedStore.getState().productIds).toEqual([]);
  });

  it("keeps what the server didn't accept, to try again", async () => {
    useRecentlyViewedStore.getState().record("P1");
    signInCustomer();
    api.post("/recently-viewed/merge", fail(500));
    renderUI(<GuestDataSync />);
    await waitFor(() => expect(api.requests("POST", "/recently-viewed/merge")).toHaveLength(1));
    expect(useRecentlyViewedStore.getState().productIds).toEqual(["P1"]);
  });
});

function availability(overrides: Partial<CartAvailability> = {}): CartAvailability {
  return {
    pincode: "781001", valid: true, serviceable: true, reason: "",
    location: { city: "Guwahati", district: "", state: "Assam" },
    lines: [
      { lineId: 1, productId: "P1", name: "Linen Shirt", available: true, status: "available", message: "Available for delivery" },
      { lineId: 2, productId: "P2", name: "Glass Lamp", available: false, status: "restricted",
        message: "Fragile: not sent to the North-East" },
    ],
    allAvailable: false, unavailableCount: 1, codAvailable: true, expressAvailable: true, estimatedDeliveryBy: null,
    ...overrides,
  };
}

function Probe({ pincode }: { pincode: string }) {
  const { result } = useCartAvailability(pincode);
  return <CartAvailabilityNotice result={result} />;
}

describe("CartAvailabilityNotice", () => {
  it("names the bag item that can't go to the pincode", async () => {
    signInCustomer();
    api.get("/cart/availability", availability());
    renderUI(<Probe pincode="781001" />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("One item in your bag can't be delivered to 781001");
    expect(alert).toHaveTextContent("Glass Lamp — Fragile: not sent to the North-East");
    expect(alert).not.toHaveTextContent("Linen Shirt");
    expect(api.last("GET", "/cart/availability")?.query.get("pincode")).toBe("781001");
  });

  it("says nothing when everything can go", async () => {
    signInCustomer();
    api.get("/cart/availability", availability({ allAvailable: true, unavailableCount: 0, lines: [] }));
    renderUI(<Probe pincode="560001" />);
    await waitFor(() => expect(api.requests("GET", "/cart/availability")).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks nothing for a guest", async () => {
    renderUI(<Probe pincode="560001" />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.requests("GET", "/cart/availability")).toHaveLength(0);
  });

  it("asks nothing for a half-typed pincode", async () => {
    signInCustomer();
    renderUI(<Probe pincode="5600" />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.requests("GET", "/cart/availability")).toHaveLength(0);
  });
});
