import { describe, expect, it } from "vitest";

import type { GiftCardCheck, GiftCardSummary, StoreCreditEntry, StoreCreditPage } from "@/services/walletService";
import { api, fail, networkError } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { fresh } from "@/test/sliceD-acct1-fixtures";
import { signInCustomer } from "@/test/sliceD-acct3-session";

async function load() {
  fresh();
  return (await import("./AccountWalletView")).AccountWalletView;
}

function creditEntry(overrides: Partial<StoreCreditEntry> = {}): StoreCreditEntry {
  return { id: 1, kind: "refund", label: "Refund for DCZ-1001", amount: 500, balanceAfter: 500, reason: "Return approved", orderId: "O1", createdAt: "2026-09-20", ...overrides };
}

function creditPage(overrides: Partial<StoreCreditPage> = {}): StoreCreditPage {
  return {
    items: [],
    pagination: { page: 1, page_size: 20, total: 0, total_pages: 1 },
    balance: 500,
    lifetimeCredited: 500,
    lifetimeSpent: 0,
    ...overrides,
  };
}

function card(overrides: Partial<GiftCardSummary> = {}): GiftCardSummary {
  return {
    id: 1,
    last4: "WXYZ",
    status: "active",
    balance: 1000,
    initialAmount: 1000,
    expiresAt: "2027-01-01",
    usable: true,
    recipientName: "Priya",
    recipientEmail: "priya@example.com",
    message: "",
    createdAt: "2026-09-01",
    deliveredAt: "2026-09-02",
    paidAt: "2026-09-01",
    ...overrides,
  };
}

function okCards(cards: GiftCardSummary[] = []) {
  api.get("/gift-cards/mine", cards);
}

describe("AccountWalletView", () => {
  describe("loading", () => {
    it("shows placeholders while credit and cards load", async () => {
      signInCustomer();
      api.get("/account/store-credit", () => new Promise(() => undefined));
      okCards();
      const AccountWalletView = await load();
      const { container } = renderUI(<AccountWalletView />);
      expect(screen.getByRole("heading", { name: "Gift cards & credit" })).toBeInTheDocument();
      expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    });
  });

  describe("failure", () => {
    it("shows an error state and retries", async () => {
      api.get("/account/store-credit", fail(500));
      okCards();
      signInCustomer();
      const AccountWalletView = await load();
      const { user } = renderUI(<AccountWalletView />);
      await screen.findByRole("alert");
      api.get("/account/store-credit", creditPage());
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("₹500")).toBeInTheDocument();
    });
  });

  describe("store credit", () => {
    it("shows the balance and a link to shop", async () => {
      api.get("/account/store-credit", creditPage({ balance: 1250.5 }));
      okCards();
      signInCustomer();
      const AccountWalletView = await load();
      renderUI(<AccountWalletView />);
      expect(await screen.findByText("₹1,250.50")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Shop now" })).toHaveAttribute("href", "/shop");
    });

    it("says there's no activity yet", async () => {
      api.get("/account/store-credit", creditPage({ items: [] }));
      okCards();
      signInCustomer();
      const AccountWalletView = await load();
      renderUI(<AccountWalletView />);
      expect(await screen.findByText("No store credit activity yet.")).toBeInTheDocument();
    });

    it("lists credit entries with a sign and the running balance", async () => {
      api.get("/account/store-credit", creditPage({
        items: [creditEntry({ amount: 500, balanceAfter: 500 }), creditEntry({ id: 2, amount: -200, balanceAfter: 300, label: "Spent at checkout", reason: "" })],
      }));
      okCards();
      signInCustomer();
      const AccountWalletView = await load();
      renderUI(<AccountWalletView />);
      expect(await screen.findByText("+₹500")).toBeInTheDocument();
      expect(screen.getByText("−₹200")).toBeInTheDocument();
      expect(screen.getByText("₹300")).toBeInTheDocument();
    });

    it("paginates when there's more than one page", async () => {
      api.get("/account/store-credit", (req) => {
        const page = Number(req.query.get("page") ?? 1);
        return creditPage({ pagination: { page, page_size: 20, total: 40, total_pages: 2 } });
      });
      okCards();
      signInCustomer();
      const AccountWalletView = await load();
      const { user } = renderUI(<AccountWalletView />);
      const nav = await screen.findByRole("navigation", { name: "Pagination" });
      await user.click(within(nav).getByRole("button", { name: "Next page" }));
      await waitFor(() => expect(api.last("GET", "/account/store-credit")!.query.get("page")).toBe("2"));
    });

    it("hides pagination for a single page", async () => {
      api.get("/account/store-credit", creditPage({ pagination: { page: 1, page_size: 20, total: 2, total_pages: 1 } }));
      okCards();
      signInCustomer();
      const AccountWalletView = await load();
      renderUI(<AccountWalletView />);
      await screen.findByText("₹500");
      expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument();
    });
  });

  describe("gift cards sent", () => {
    it("says none have been sent yet", async () => {
      api.get("/account/store-credit", creditPage());
      okCards([]);
      signInCustomer();
      const AccountWalletView = await load();
      renderUI(<AccountWalletView />);
      expect(await screen.findByText("You haven’t sent any gift cards yet.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Send a gift card" })).toHaveAttribute("href", "/gift-cards");
    });

    it("lists a sent card with its status, recipient, balance and expiry", async () => {
      api.get("/account/store-credit", creditPage());
      okCards([card()]);
      signInCustomer();
      const AccountWalletView = await load();
      renderUI(<AccountWalletView />);
      expect(await screen.findByText("₹1,000")).toBeInTheDocument();
      expect(screen.getByText("Active")).toBeInTheDocument();
      expect(screen.getByText("To Priya")).toBeInTheDocument();
      expect(screen.getByText("priya@example.com")).toBeInTheDocument();
      expect(screen.getByText(/Ends in WXYZ · Balance ₹1,000 · until 1 Jan 2027/)).toBeInTheDocument();
    });

    it("omits the last-4 when the card has none to show", async () => {
      api.get("/account/store-credit", creditPage());
      okCards([card({ last4: "----", expiresAt: null })]);
      signInCustomer();
      const AccountWalletView = await load();
      renderUI(<AccountWalletView />);
      expect(await screen.findByText("Balance ₹1,000")).toBeInTheDocument();
    });

    it.each([
      ["partially-used", "Partly used"],
      ["used", "Used up"],
      ["expired", "Expired"],
      ["disabled", "Cancelled"],
      ["refunded", "Refunded"],
      ["pending", "Awaiting payment"],
    ])("labels status %s as %s", async (status, label) => {
      api.get("/account/store-credit", creditPage());
      okCards([card({ status: status as GiftCardSummary["status"] })]);
      signInCustomer();
      const AccountWalletView = await load();
      renderUI(<AccountWalletView />);
      expect(await screen.findByText(label)).toBeInTheDocument();
    });
  });

  describe("balance check", () => {
    it("disables Check balance until a code is entered", async () => {
      api.get("/account/store-credit", creditPage());
      okCards();
      signInCustomer();
      const AccountWalletView = await load();
      renderUI(<AccountWalletView />);
      expect(await screen.findByRole("button", { name: "Check balance" })).toBeDisabled();
    });

    it("shows a valid card's balance and expiry", async () => {
      api.get("/account/store-credit", creditPage());
      okCards();
      api.post("/gift-cards/check", { valid: true, reason: "", last4: "WXYZ", balance: 450, expiresAt: "2027-06-01" } satisfies GiftCardCheck);
      signInCustomer();
      const AccountWalletView = await load();
      const { user } = renderUI(<AccountWalletView />);
      await user.type(await screen.findByPlaceholderText("DCZG-XXXX-XXXX-XXXX-XXXX"), "DCZG-WXYZ");
      await user.click(screen.getByRole("button", { name: "Check balance" }));
      expect(await screen.findByRole("status")).toHaveTextContent("Card ending WXYZ: ₹450 left, usable until 1 Jun 2027.");
    });

    it("shows the reason for an invalid card", async () => {
      api.get("/account/store-credit", creditPage());
      okCards();
      api.post("/gift-cards/check", { valid: false, reason: "That code doesn't exist." } satisfies GiftCardCheck);
      signInCustomer();
      const AccountWalletView = await load();
      const { user } = renderUI(<AccountWalletView />);
      await user.type(await screen.findByPlaceholderText("DCZG-XXXX-XXXX-XXXX-XXXX"), "BAD");
      await user.click(screen.getByRole("button", { name: "Check balance" }));
      expect(await screen.findByRole("status")).toHaveTextContent("That code doesn't exist.");
    });

    it("shows Checking… while the check is in flight", async () => {
      api.get("/account/store-credit", creditPage());
      okCards();
      api.post("/gift-cards/check", () => new Promise(() => undefined));
      signInCustomer();
      const AccountWalletView = await load();
      const { user } = renderUI(<AccountWalletView />);
      await user.type(await screen.findByPlaceholderText("DCZG-XXXX-XXXX-XXXX-XXXX"), "BAD");
      await user.click(screen.getByRole("button", { name: "Check balance" }));
      expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    });

    it("shows the server's error message on the field itself, rather than as a result", async () => {
      api.get("/account/store-credit", creditPage());
      okCards();
      api.post("/gift-cards/check", fail(404, "That code doesn't exist."));
      signInCustomer();
      const AccountWalletView = await load();
      const { user } = renderUI(<AccountWalletView />);
      await user.type(await screen.findByPlaceholderText("DCZG-XXXX-XXXX-XXXX-XXXX"), "BAD");
      await user.click(screen.getByRole("button", { name: "Check balance" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("That code doesn't exist.");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("shows a generic message for a non-API failure", async () => {
      api.get("/account/store-credit", creditPage());
      okCards();
      api.post("/gift-cards/check", networkError(Object.assign(new Error("x"), { digest: "DYNAMIC_SERVER_USAGE" })));
      signInCustomer();
      const AccountWalletView = await load();
      const { user } = renderUI(<AccountWalletView />);
      await user.type(await screen.findByPlaceholderText("DCZG-XXXX-XXXX-XXXX-XXXX"), "BAD");
      await user.click(screen.getByRole("button", { name: "Check balance" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't check that code just now.");
    });
  });
});
