import { describe, expect, it, vi } from "vitest";

import { api, hang } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";
import { fresh, product, siteContent, storeSession } from "@/test/sliceD-acct1-fixtures";

/**
 * `useWishlist`'s sync keeps a module-scope "already read this page" promise
 * (`synced` in `src/hooks/useWishlist.ts`), shared by every mounted instance —
 * so, like the account-shell tests, each test gets a fresh module registry and
 * imports both the view and the wishlist store dynamically afterwards.
 */
async function load() {
  fresh();
  const [{ AccountWishlistView }, { useWishlistStore }] = await Promise.all([
    import("./AccountWishlistView"),
    import("@/store/wishlistStore"),
  ]);
  return { AccountWishlistView, useWishlistStore };
}

describe("AccountWishlistView", () => {
  describe("signed in, empty", () => {
    it("shows the empty state with a link to shop", async () => {
      api.get("/site/content", siteContent());
      storeSession();
      const { AccountWishlistView } = await load();
      api.get("/wishlist/ids", []);

      renderUI(<AccountWishlistView />);
      expect(await screen.findByText("Nothing saved yet")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Discover products" })).toHaveAttribute("href", "/shop");
    });
  });

  describe("signed in, loading", () => {
    it("shows placeholders while the saved products resolve", async () => {
      api.get("/site/content", siteContent());
      storeSession();
      const { AccountWishlistView } = await load();
      api.get("/wishlist/ids", ["P1", "P2"]);
      api.get("/wishlist", hang());

      const { container } = renderUI(<AccountWishlistView />);
      await waitFor(() => expect(api.requests("GET", "/wishlist/ids")).toHaveLength(1));
      expect(screen.queryByText("Nothing saved yet")).not.toBeInTheDocument();
      expect(container.querySelectorAll(".aspect-\\[3\\/4\\]")).toHaveLength(4);
    });
  });

  describe("signed in, within the preview size", () => {
    it("shows every item and offers to manage the wishlist", async () => {
      api.get("/site/content", siteContent());
      storeSession();
      const { AccountWishlistView } = await load();
      api.get("/wishlist/ids", ["P1", "P2"]);
      api.get("/wishlist", [product("P1", { name: "Linen Shirt" }), product("P2", { name: "Denim Jacket" })]);

      renderUI(<AccountWishlistView />);
      expect(await screen.findByText("2 saved items")).toBeInTheDocument();
      expect(screen.getByText("Linen Shirt")).toBeInTheDocument();
      expect(screen.getByText("Denim Jacket")).toBeInTheDocument();
      const manage = screen.getByRole("link", { name: /Manage wishlist/ });
      expect(manage).toHaveAttribute("href", "/wishlist");
    });

    it("uses the singular for exactly one saved item", async () => {
      api.get("/site/content", siteContent());
      storeSession();
      const { AccountWishlistView } = await load();
      api.get("/wishlist/ids", ["P1"]);
      api.get("/wishlist", [product("P1")]);
      renderUI(<AccountWishlistView />);
      expect(await screen.findByText("1 saved item")).toBeInTheDocument();
    });
  });

  describe("signed in, more than the preview size", () => {
    it("shows only the first four and offers the full list", async () => {
      api.get("/site/content", siteContent());
      storeSession();
      const { AccountWishlistView } = await load();
      const ids = ["P1", "P2", "P3", "P4", "P5"];
      api.get("/wishlist/ids", ids);
      api.get("/wishlist", ids.map((id) => product(id)));

      renderUI(<AccountWishlistView />);
      expect(await screen.findByText("Showing 4 of 5 saved items")).toBeInTheDocument();
      expect(screen.getByText("Product P1")).toBeInTheDocument();
      expect(screen.queryByText("Product P5")).not.toBeInTheDocument();
      const link = screen.getByRole("link", { name: /View complete wishlist · 5 items/ });
      expect(link).toHaveAttribute("href", "/wishlist");
    });
  });

  describe("guest", () => {
    it("is gated behind sign-in by AccountShell, like every account page", async () => {
      api.get("/site/content", siteContent());
      const { AccountWishlistView, useWishlistStore } = await load();
      useWishlistStore.getState().add("P1");

      renderUI(<AccountWishlistView />);
      expect(screen.getByRole("heading", { name: "Your account" })).toBeInTheDocument();
      expect(screen.queryByText(/saved item/)).not.toBeInTheDocument();
    });
  });
});
