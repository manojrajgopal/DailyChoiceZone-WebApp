import { describe, expect, it, vi } from "vitest";

import { api, fail } from "@/test/api";
import { setLocation, router } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";
import { signInCustomer } from "@/test/sliceD-cart-fixtures";

import { CartRecoveryNotice } from "./CartRecoveryNotice";

describe("CartRecoveryNotice", () => {
  describe("no recovery token", () => {
    it("renders nothing", () => {
      const onRestored = vi.fn();
      const { container } = renderUI(<CartRecoveryNotice onRestored={onRestored} />);
      expect(container).toBeEmptyDOMElement();
      expect(api.calls).toHaveLength(0);
    });
  });

  describe("signed out, with a token", () => {
    it("invites sign-in and links back to the same recovery URL", () => {
      setLocation("/cart?recover=TOK1");
      renderUI(<CartRecoveryNotice onRestored={vi.fn()} />);
      expect(screen.getByText(/Sign in to see the bag you saved/)).toBeInTheDocument();
      const link = screen.getByRole("link", { name: "Sign in" });
      expect(link).toHaveAttribute("href", `/account?next=${encodeURIComponent("/cart?recover=TOK1")}`);
      // No request is made for a visitor who isn't signed in.
      expect(api.requests("POST", "/cart/recover")).toHaveLength(0);
    });
  });

  describe("signed in, with a token", () => {
    it("opens the link, reports what was restored, and clears the token from the URL", async () => {
      setLocation("/cart?recover=TOK1");
      signInCustomer();
      api.post("/cart/recover", { changes: [{ name: "Linen Shirt", message: "Price dropped to ₹899" }], restored: 2 });
      const onRestored = vi.fn();
      renderUI(<CartRecoveryNotice onRestored={onRestored} />);

      expect(await screen.findByText(/We've put 2 items back in your bag\./)).toBeInTheDocument();
      expect(screen.getByText("Price dropped to ₹899")).toBeInTheDocument();
      expect(onRestored).toHaveBeenCalledOnce();

      const request = api.last("POST", "/cart/recover")!;
      expect(request.body).toEqual({ token: "TOK1" });
      expect(request.headers.authorization).toBe("Bearer test-token");
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/cart", { scroll: false }));
    });

    it("uses the singular for exactly one restored item", async () => {
      setLocation("/cart?recover=TOK1");
      signInCustomer();
      api.post("/cart/recover", { changes: [], restored: 1 });
      renderUI(<CartRecoveryNotice onRestored={vi.fn()} />);
      expect(await screen.findByText(/We've put your item back in your bag\./)).toBeInTheDocument();
    });

    it("says the bag is unchanged when nothing needed restoring, without calling onRestored", async () => {
      setLocation("/cart?recover=TOK1");
      signInCustomer();
      api.post("/cart/recover", { changes: [], restored: 0 });
      const onRestored = vi.fn();
      renderUI(<CartRecoveryNotice onRestored={onRestored} />);
      expect(await screen.findByText("Your bag is just as you left it.")).toBeInTheDocument();
      expect(onRestored).not.toHaveBeenCalled();
    });

    it("explains a 404 as belonging to a different account, and can be dismissed", async () => {
      setLocation("/cart?recover=TOK1");
      signInCustomer();
      api.post("/cart/recover", fail(404, "Not found", "NOT_FOUND"));
      const { user } = renderUI(<CartRecoveryNotice onRestored={vi.fn()} />);
      expect(await screen.findByText(/belongs to a different account/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("shows a generic message for any other failure", async () => {
      setLocation("/cart?recover=TOK1");
      signInCustomer();
      api.post("/cart/recover", fail(500));
      renderUI(<CartRecoveryNotice onRestored={vi.fn()} />);
      expect(await screen.findByText(/We couldn't open your saved bag just now\./)).toBeInTheDocument();
    });

    it("opens the recovery link only once even if the component re-renders", async () => {
      setLocation("/cart?recover=TOK1");
      signInCustomer();
      api.post("/cart/recover", { changes: [], restored: 0 });
      const onRestored = vi.fn();
      const { rerender } = renderUI(<CartRecoveryNotice onRestored={onRestored} />);
      await waitFor(() => expect(api.requests("POST", "/cart/recover")).toHaveLength(1));
      rerender(<CartRecoveryNotice onRestored={onRestored} />);
      rerender(<CartRecoveryNotice onRestored={onRestored} />);
      expect(api.requests("POST", "/cart/recover")).toHaveLength(1);
    });
  });
});
