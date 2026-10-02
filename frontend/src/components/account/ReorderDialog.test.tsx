import { describe, expect, it, vi } from "vitest";

import { api, fail, networkError } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { reorderLine, reorderable } from "@/test/sliceD-acct2-fixtures";

import { ReorderDialog } from "./ReorderDialog";

function setup(props: Partial<Parameters<typeof ReorderDialog>[0]> = {}) {
  const onClose = vi.fn();
  const view = renderUI(<ReorderDialog orderId={props.orderId ?? "O1"} open={props.open ?? true} onClose={onClose} only={props.only} />);
  return { ...view, onClose };
}

describe("ReorderDialog", () => {
  describe("loading", () => {
    it("shows a checking message while the order is being read", () => {
      api.get("/orders/O1/reorder", () => new Promise(() => undefined));
      setup();
      expect(screen.getByText("Checking what’s available…")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Order again" })).toBeInTheDocument();
    });

    it("does nothing while closed", () => {
      setup({ open: false });
      expect(api.calls).toHaveLength(0);
    });
  });

  describe("failure", () => {
    it("shows the server's message when the order can't be checked", async () => {
      api.get("/orders/O1/reorder", fail(404, "This order no longer exists."));
      setup();
      expect(await screen.findByText("This order no longer exists.")).toBeInTheDocument();
    });

    it("shows a generic message for a non-API failure (e.g. Next's own control-flow signal)", async () => {
      api.get("/orders/O1/reorder", networkError(Object.assign(new Error("DYNAMIC_SERVER_USAGE"), { digest: "DYNAMIC_SERVER_USAGE" })));
      setup();
      expect(await screen.findByText("This order couldn't be checked.")).toBeInTheDocument();
    });
  });

  describe("choosing items", () => {
    it("preselects every addable line and shows what each is ordered as", async () => {
      api.get("/orders/O1/reorder", reorderable([
        reorderLine({ key: "a", name: "Linen Shirt", size: "M", color: "Blue", quantity: 1, orderedQuantity: 2 }),
        reorderLine({ key: "b", name: "Shorts", quantity: 0, reason: "Sold out", size: null, color: null }),
      ]));
      setup();
      expect(await screen.findByRole("heading", { name: "Order DCZ-1001 again" })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Add Linen Shirt" })).toBeChecked();
      expect(screen.getByText(/Size M · Blue · Ordered 2 · adding 1/)).toBeInTheDocument();
      const soldOut = screen.getByRole("checkbox", { name: "Add Shorts" });
      expect(soldOut).toBeDisabled();
      expect(soldOut).not.toBeChecked();
      expect(screen.getByText("Sold out")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Add 1 to bag/ })).toBeInTheDocument();
    });

    it("shows the current price and the original price when they differ", async () => {
      api.get("/orders/O1/reorder", reorderable([reorderLine({ key: "a", orderedUnitPrice: 1000, currentPrice: 1200 })]));
      setup();
      await screen.findByRole("heading", { name: /Order .* again/ });
      expect(screen.getByText("₹1,200")).toBeInTheDocument();
      expect(screen.getByText("was ₹1,000")).toBeInTheDocument();
    });

    it("shows a dash when the item is no longer sold (no current price)", async () => {
      api.get("/orders/O1/reorder", reorderable([reorderLine({ key: "a", currentPrice: null, quantity: 0, reason: "Discontinued" })]));
      setup();
      await screen.findByRole("heading", { name: /Order .* again/ });
      expect(screen.getByText("—")).toBeInTheDocument();
    });

    it("labels a bundle line", async () => {
      api.get("/orders/O1/reorder", reorderable([reorderLine({ key: "a", kind: "bundle", name: "Summer Set" })]));
      setup();
      expect(await screen.findByText("· bundle")).toBeInTheDocument();
    });

    it("limits to a single line when `only` is given", async () => {
      api.get("/orders/O1/reorder", reorderable([
        reorderLine({ key: "a", name: "Linen Shirt" }),
        reorderLine({ key: "b", name: "Shorts" }),
      ]));
      setup({ only: "b" });
      await screen.findByRole("heading", { name: /Order .* again/ });
      expect(screen.queryByText("Linen Shirt")).not.toBeInTheDocument();
      expect(screen.getByText("Shorts")).toBeInTheDocument();
    });

    it("toggling a checkbox changes the add count, down to 'Nothing can be added'", async () => {
      api.get("/orders/O1/reorder", reorderable([reorderLine({ key: "a", name: "Linen Shirt" })]));
      const { user } = setup();
      const checkbox = await screen.findByRole("checkbox", { name: "Add Linen Shirt" });
      expect(screen.getByRole("button", { name: /Add 1 to bag/ })).toBeEnabled();
      await user.click(checkbox);
      expect(screen.getByRole("button", { name: "Nothing can be added" })).toBeDisabled();
    });

    it("cancels without submitting", async () => {
      api.get("/orders/O1/reorder", reorderable([reorderLine()]));
      const { user, onClose } = setup();
      await screen.findByRole("heading", { name: /Order .* again/ });
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalledOnce();
      expect(api.requests("POST", "/orders/O1/reorder")).toHaveLength(0);
    });
  });

  describe("submitting", () => {
    it("adds the chosen lines, shows what was added, and offers the bag", async () => {
      api.get("/orders/O1/reorder", reorderable([reorderLine({ key: "a", name: "Linen Shirt", quantity: 2 })]));
      api.post("/orders/O1/reorder", (req) => {
        expect(req.body).toEqual({ keys: ["a"] });
        return { added: [reorderLine({ key: "a", name: "Linen Shirt", quantity: 2, currentPrice: 1499 })], skipped: [], message: "Added 2 items to your bag", units: 2 };
      });
      api.get("/cart/count", { itemCount: 2 });
      const { user } = setup();
      await screen.findByRole("checkbox", { name: "Add Linen Shirt" });

      await user.click(screen.getByRole("button", { name: /Add 1 to bag/ }));
      expect(await screen.findByRole("heading", { name: "Added to your bag" })).toBeInTheDocument();
      expect(screen.getByText("Added 2 items to your bag")).toBeInTheDocument();
      expect(screen.getByText(/2 × Linen Shirt/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Review your bag" })).toHaveAttribute("href", "/cart");
    });

    it("shows a disabled, busy button while submitting", async () => {
      api.get("/orders/O1/reorder", reorderable([reorderLine({ key: "a" })]));
      api.post("/orders/O1/reorder", () => new Promise(() => undefined));
      const { user } = setup();
      await screen.findByRole("checkbox", { name: /Add/ });
      await user.click(screen.getByRole("button", { name: /Add 1 to bag/ }));
      expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    });

    it("lists what was skipped by the server alongside unaddable lines, without a bag link when nothing was added", async () => {
      api.get("/orders/O1/reorder", reorderable([
        reorderLine({ key: "a", name: "Linen Shirt" }),
        reorderLine({ key: "b", name: "Shorts", quantity: 0, reason: "Sold out" }),
      ]));
      api.post("/orders/O1/reorder", {
        added: [],
        skipped: [reorderLine({ key: "a", name: "Linen Shirt", reason: "Just sold out" })],
        message: "Nothing could be added",
        units: 0,
      });
      const { user } = setup();
      await screen.findByRole("checkbox", { name: "Add Linen Shirt" });
      await user.click(screen.getByRole("button", { name: /Add 1 to bag/ }));

      expect(await screen.findByText("Nothing could be added")).toBeInTheDocument();
      expect(screen.getByText("2 items couldn’t be added")).toBeInTheDocument();
      expect(screen.getByText(/Linen Shirt — Just sold out/)).toBeInTheDocument();
      expect(screen.getByText(/Shorts — Sold out/)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Review your bag" })).not.toBeInTheDocument();
    });

    it("reports a failure to add and stays on the choice screen", async () => {
      api.get("/orders/O1/reorder", reorderable([reorderLine({ key: "a" })]));
      api.post("/orders/O1/reorder", fail(409, "Stock changed while you were choosing."));
      const { user } = setup();
      await screen.findByRole("checkbox", { name: /Add/ });
      await user.click(screen.getByRole("button", { name: /Add 1 to bag/ }));
      await waitFor(() => expect(screen.getByRole("button", { name: /Add 1 to bag/ })).toBeEnabled());
      expect(screen.queryByRole("heading", { name: "Added to your bag" })).not.toBeInTheDocument();
    });
  });

  describe("closing via the dialog's own chrome", () => {
    it("calls onClose when dismissed", async () => {
      api.get("/orders/O1/reorder", reorderable([reorderLine()]));
      const { user, onClose } = setup();
      await screen.findByRole("checkbox", { name: /Add/ });
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
