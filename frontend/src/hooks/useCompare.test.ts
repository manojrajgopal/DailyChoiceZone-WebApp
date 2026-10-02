import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AuthSession, Product } from "@/types";

import { api, fail } from "@/test/api";
import { useCompareStore } from "@/store/compareStore";

import { COMPARE_LIMIT, useCompareList, useCompareProducts } from "./useCompare";

function product(id: string, name = `Product ${id}`): Product {
  return {
    id,
    slug: id,
    name,
    brand: "Brand",
    category: "women",
    subcategory: "kurtas",
    price: 100,
    originalPrice: 100,
    discount: 0,
    currency: "INR",
    rating: 4,
    reviewCount: 0,
    images: [],
    colors: [],
    sizes: [],
    description: "",
    material: "",
    tags: [],
    isNew: false,
    isTrending: false,
    isBestSeller: false,
    isFeatured: false,
    stock: 5,
    sku: id,
    care: "",
    specifications: [],
  };
}

describe("useCompareList (guest)", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useCompareList());
    expect(result.current.productIds).toEqual([]);
    expect(result.current.count).toBe(0);
    expect(result.current.has("P1")).toBe(false);
  });

  it("add stages a product locally and reports added", async () => {
    const { result } = renderHook(() => useCompareList());
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.add(product("P1"));
    });
    expect(outcome).toBe("added");
    expect(useCompareStore.getState().productIds).toEqual(["P1"]);
    expect(useCompareStore.getState().pending).toEqual(["P1"]);
  });

  it("adding the same product again is a no-op that still reports added", async () => {
    useCompareStore.setState({ productIds: ["P1"] });
    const { result } = renderHook(() => useCompareList());
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.add(product("P1"));
    });
    expect(outcome).toBe("added");
    expect(useCompareStore.getState().productIds).toEqual(["P1"]);
  });

  it("reports full once the limit is reached, without changing anything", async () => {
    useCompareStore.setState({ productIds: ["P1", "P2", "P3", "P4"] });
    const { result } = renderHook(() => useCompareList());
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.add(product("P5"));
    });
    expect(outcome).toBe("full");
    expect(useCompareStore.getState().productIds).toEqual(["P1", "P2", "P3", "P4"]);
  });

  it("replaces a named product at the limit", async () => {
    useCompareStore.setState({ productIds: ["P1", "P2", "P3", "P4"] });
    const { result } = renderHook(() => useCompareList());
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.add(product("P5"), "P2");
    });
    expect(outcome).toBe("added");
    expect(useCompareStore.getState().productIds).toEqual(["P1", "P3", "P4", "P5"]);
  });

  it("remove drops the id", async () => {
    useCompareStore.setState({ productIds: ["P1", "P2"] });
    const { result } = renderHook(() => useCompareList());
    await act(() => result.current.remove("P1"));
    expect(useCompareStore.getState().productIds).toEqual(["P2"]);
  });

  it("clear empties the list", async () => {
    useCompareStore.setState({ productIds: ["P1", "P2"] });
    const { result } = renderHook(() => useCompareList());
    await act(() => result.current.clear());
    expect(useCompareStore.getState().productIds).toEqual([]);
  });

  it("exposes the shared compare limit", () => {
    expect(COMPARE_LIMIT).toBe(4);
  });
});

describe("useCompareProducts (guest)", () => {
  it("is empty with nothing to compare", async () => {
    const { result } = renderHook(() => useCompareProducts());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.products).toEqual([]);
  });

  it("resolves the staged ids into products, dropping ones no longer for sale", async () => {
    useCompareStore.setState({ productIds: ["P1", "P2"] });
    api.get(/^\/products\/P1$/, product("P1"));
    api.get(/^\/products\/P2$/, fail(404));
    const { result } = renderHook(() => useCompareProducts());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.products.map((p) => p.id)).toEqual(["P1"]);
  });
});

/**
 * Signed-in behaviour depends on the server-confirmation check, which (like
 * the session hooks it is built on) is scoped to one module instance per real
 * page load — so this gets a fresh module graph, seeded via `localStorage`.
 */
describe("signed-in compare (fresh module)", () => {
  async function freshSignedIn(stagedIds: string[] = []) {
    const session: AuthSession = {
      user: { id: "U1", firstName: "A", lastName: "B", email: "a@b.com", phone: "1", memberSince: "2024-01-01" },
      token: "cust-token",
    };
    window.localStorage.setItem("dcz:session", JSON.stringify({ state: { session }, version: 1 }));
    window.localStorage.setItem(
      "dcz:compare",
      JSON.stringify({ state: { productIds: stagedIds, pending: stagedIds }, version: 1 }),
    );
    vi.resetModules();
    const [sessionStoreMod, compareStoreMod, hookMod] = await Promise.all([
      import("@/store/sessionStore"),
      import("@/store/compareStore"),
      import("./useCompare"),
    ]);
    for (
      let i = 0;
      i < 50 && !(sessionStoreMod.useSessionStore.persist?.hasHydrated?.() && compareStoreMod.useCompareStore.persist?.hasHydrated?.());
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return hookMod;
  }

  it("merges staged ids onto the account on sign-in", async () => {
    const { useCompareList: fresh } = await freshSignedIn(["P9"]);
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.post("/compare/merge", { productIds: ["P9"] });

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(api.requests("POST", "/compare/merge")).toHaveLength(1));
    await waitFor(() => expect(result.current.productIds).toEqual(["P9"]));
  });

  it("surfaces the server's COMPARISON_FULL error as 'full'", async () => {
    const { useCompareList: fresh } = await freshSignedIn([]);
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.get("/compare/ids", { productIds: ["P1", "P2", "P3", "P4"], limit: 4 });
    api.post(/^\/compare\/P5/, fail(409, "Comparison list is full", "COMPARISON_FULL"));

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(result.current.productIds).toEqual(["P1", "P2", "P3", "P4"]));
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.add(product("P5"), "P2");
    });
    expect(outcome).toBe("full");
  });

  it("adds a product (signed in) and removes it again, both confirmed by the server", async () => {
    const { useCompareList: fresh } = await freshSignedIn([]);
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.get("/compare/ids", { productIds: [], limit: 4 });
    api.post("/compare/P1", { productIds: ["P1"] });
    api.delete("/compare/P1", { productIds: [] });

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(result.current.productIds).toEqual([]));

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.add(product("P1"));
    });
    expect(outcome).toBe("added");
    expect(result.current.productIds).toEqual(["P1"]);

    await act(() => result.current.remove("P1"));
    expect(result.current.productIds).toEqual([]);
  });

  it("keeps the local list when the server rejects a remove (the next sync corrects it)", async () => {
    const { useCompareList: fresh } = await freshSignedIn([]);
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.get("/compare/ids", { productIds: ["P1"], limit: 4 });
    api.delete("/compare/P1", fail(500));

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(result.current.productIds).toEqual(["P1"]));
    await act(() => result.current.remove("P1"));
    // Removed from the local list regardless of the server call's outcome.
    expect(result.current.productIds).toEqual([]);
  });

  it("retries the sync on the next sign-in after a failed merge", async () => {
    const { useCompareList: fresh } = await freshSignedIn(["P9"]);
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.post("/compare/merge", fail(500));

    const { result, unmount } = renderHook(() => fresh());
    await waitFor(() => expect(api.requests("POST", "/compare/merge")).toHaveLength(1));
    unmount();

    api.get("/compare/ids", { productIds: ["P1"], limit: 4 });
    const { result: second } = renderHook(() => fresh());
    await waitFor(() => expect(second.current.productIds).toEqual(["P1"]));
    void result;
  });
});

describe("useCompareProducts (signed in, fresh module)", () => {
  async function freshSignedIn() {
    const session: AuthSession = {
      user: { id: "U1", firstName: "A", lastName: "B", email: "a@b.com", phone: "1", memberSince: "2024-01-01" },
      token: "cust-token",
    };
    window.localStorage.setItem("dcz:session", JSON.stringify({ state: { session }, version: 1 }));
    vi.resetModules();
    const [sessionStoreMod, hookMod] = await Promise.all([
      import("@/store/sessionStore"),
      import("./useCompare"),
    ]);
    for (let i = 0; i < 50 && !sessionStoreMod.useSessionStore.persist?.hasHydrated?.(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return hookMod;
  }

  it("fetches full product records from the server instead of resolving ids locally", async () => {
    const { useCompareProducts: fresh } = await freshSignedIn();
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.get("/compare/ids", { productIds: ["P1"], limit: 4 });
    api.get("/compare", { items: [product("P1")], limit: 4 });

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.products.map((p) => p.id)).toEqual(["P1"]);
  });
});
