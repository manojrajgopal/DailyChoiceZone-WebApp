import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AuthSession, Product } from "@/types";

import { api, fail } from "@/test/api";
import { useWishlistStore } from "@/store/wishlistStore";

import { useWishlist, useWishlistCount, useWishlistItem } from "./useWishlist";

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

describe("useWishlist (guest)", () => {
  it("is empty with nothing saved", () => {
    const { result } = renderHook(() => useWishlist());
    expect(result.current.products).toEqual([]);
    expect(result.current.count).toBe(0);
    expect(result.current.isEmpty).toBe(true);
  });

  it("resolves saved ids into products, most recently added first", async () => {
    useWishlistStore.setState({ productIds: ["P1", "P2"] });
    api.get(/^\/products\/P1$/, product("P1"));
    api.get(/^\/products\/P2$/, product("P2"));
    const { result } = renderHook(() => useWishlist());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.products.map((p) => p.id)).toEqual(["P2", "P1"]);
    expect(result.current.count).toBe(2);
  });

  it("resolves to an empty list when the lookup fails", async () => {
    useWishlistStore.setState({ productIds: ["P1"] });
    api.get(/^\/products\/P1$/, fail(500));
    const { result } = renderHook(() => useWishlist());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.products).toEqual([]);
  });

  it("remove removes the id locally and toasts", () => {
    useWishlistStore.setState({ productIds: ["P1"] });
    const { result } = renderHook(() => useWishlist());
    act(() => result.current.remove(product("P1", "Kurta")));
    expect(useWishlistStore.getState().productIds).toEqual([]);
  });

  it("clear empties the list", () => {
    useWishlistStore.setState({ productIds: ["P1", "P2"] });
    const { result } = renderHook(() => useWishlist());
    act(() => result.current.clear());
    expect(useWishlistStore.getState().productIds).toEqual([]);
  });
});

describe("useWishlistItem (guest)", () => {
  it("is not wishlisted by default", () => {
    const { result } = renderHook(() => useWishlistItem("P1"));
    expect(result.current.isWishlisted).toBe(false);
  });

  it("toggle adds the product, stages it for a future sign-in, and reports true", () => {
    const { result } = renderHook(() => useWishlistItem("P1"));
    let now = false;
    act(() => {
      now = result.current.toggle("Kurta");
    });
    expect(now).toBe(true);
    expect(result.current.isWishlisted).toBe(true);
    expect(useWishlistStore.getState().productIds).toContain("P1");
    expect(useWishlistStore.getState().pending).toContain("P1");
  });

  it("toggle again removes it and reports false", () => {
    useWishlistStore.setState({ productIds: ["P1"] });
    const { result } = renderHook(() => useWishlistItem("P1"));
    let now = true;
    act(() => {
      now = result.current.toggle();
    });
    expect(now).toBe(false);
    expect(useWishlistStore.getState().productIds).not.toContain("P1");
  });
});

describe("useWishlistCount (guest)", () => {
  it("is zero with nothing saved", () => {
    const { result } = renderHook(() => useWishlistCount());
    expect(result.current).toBe(0);
  });

  it("reflects the number of saved ids", () => {
    useWishlistStore.setState({ productIds: ["P1", "P2", "P3"] });
    const { result } = renderHook(() => useWishlistCount());
    expect(result.current).toBe(3);
  });
});

/**
 * Signed-in sync merges a guest's staged items onto the account exactly once
 * per page load (a module-scoped `synced` promise) — so, like the session
 * check it depends on, this needs its own fresh module graph rather than
 * sharing one with the guest-mode tests above.
 */
describe("signed-in sync (fresh module)", () => {
  async function freshSignedIn(stagedIds: string[] = []) {
    const session: AuthSession = {
      user: { id: "U1", firstName: "A", lastName: "B", email: "a@b.com", phone: "1", memberSince: "2024-01-01" },
      token: "cust-token",
    };
    window.localStorage.setItem("dcz:session", JSON.stringify({ state: { session }, version: 1 }));
    window.localStorage.setItem(
      "dcz:wishlist",
      JSON.stringify({ state: { productIds: stagedIds, pending: stagedIds }, version: 2 }),
    );
    vi.resetModules();
    const [sessionStoreMod, wishlistStoreMod, hookMod] = await Promise.all([
      import("@/store/sessionStore"),
      import("@/store/wishlistStore"),
      import("./useWishlist"),
    ]);
    for (
      let i = 0;
      i < 50 && !(sessionStoreMod.useSessionStore.persist?.hasHydrated?.() && wishlistStoreMod.useWishlistStore.persist?.hasHydrated?.());
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return hookMod;
  }

  it("merges staged ids onto the account, then mirrors the server's list", async () => {
    const { useWishlist: fresh } = await freshSignedIn(["P9"]);
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.post("/wishlist/P9", ["P9"]);
    api.get("/wishlist/ids", ["P9"]);
    api.get("/wishlist", [product("P9")]);

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(api.requests("POST", "/wishlist/P9")).toHaveLength(1));
    await waitFor(() => expect(result.current.products.map((p) => p.id)).toEqual(["P9"]));
  });

  it("remove and clear also tell the server, signed in", async () => {
    const { useWishlist: fresh } = await freshSignedIn([]);
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.get("/wishlist/ids", ["P1", "P2"]);
    api.get("/wishlist", [product("P1"), product("P2")]);
    api.delete(/^\/wishlist\//, []);

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(result.current.products).toHaveLength(2));

    act(() => result.current.remove(product("P1")));
    await waitFor(() => expect(api.requests("DELETE", "/wishlist/P1")).toHaveLength(1));

    act(() => result.current.clear());
    await waitFor(() => expect(api.requests("DELETE", "/wishlist/P2")).toHaveLength(1));
  });
});

describe("useWishlistItem (signed in, fresh module)", () => {
  async function freshSignedIn() {
    const session: AuthSession = {
      user: { id: "U1", firstName: "A", lastName: "B", email: "a@b.com", phone: "1", memberSince: "2024-01-01" },
      token: "cust-token",
    };
    window.localStorage.setItem("dcz:session", JSON.stringify({ state: { session }, version: 1 }));
    vi.resetModules();
    const [sessionStoreMod, hookMod] = await Promise.all([
      import("@/store/sessionStore"),
      import("./useWishlist"),
    ]);
    for (let i = 0; i < 50 && !sessionStoreMod.useSessionStore.persist?.hasHydrated?.(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return hookMod;
  }

  it("toggle posts to the server instead of only staging locally", async () => {
    const { useWishlistItem: fresh } = await freshSignedIn();
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.get("/wishlist/ids", []);
    api.post("/wishlist/P1", ["P1"]);
    api.delete("/wishlist/P1", []);

    const { result } = renderHook(() => fresh("P1"));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.toggle("Kurta"));
    await waitFor(() => expect(api.requests("POST", "/wishlist/P1")).toHaveLength(1));

    act(() => result.current.toggle("Kurta"));
    await waitFor(() => expect(api.requests("DELETE", "/wishlist/P1")).toHaveLength(1));
  });
});
