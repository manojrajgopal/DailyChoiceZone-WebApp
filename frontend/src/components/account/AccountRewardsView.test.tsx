import { describe, expect, it } from "vitest";

import type { RewardEntry, RewardRules, RewardsPage } from "@/services/walletService";
import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { fresh } from "@/test/sliceD-acct1-fixtures";
import { signInCustomer } from "@/test/sliceD-acct3-session";

async function load() {
  fresh();
  return (await import("./AccountRewardsView")).AccountRewardsView;
}

function rules(overrides: Partial<RewardRules> = {}): RewardRules {
  return {
    pointsPer100: 2,
    redeemPoints: 100,
    redeemValue: 10,
    minRedeemPoints: 100,
    maxPointsPerOrder: 500,
    maxOrderPercent: 20,
    expiryMonths: 12,
    pendingDays: 7,
    excludeTax: true,
    excludeTenderPaid: true,
    excludeDiscountedItems: false,
    memberMultiplier: 1,
    allowWithCoupons: true,
    allowWithGiftCards: true,
    allowWithStoreCredit: true,
    ...overrides,
  };
}

function entry(overrides: Partial<RewardEntry> = {}): RewardEntry {
  return {
    id: 1,
    kind: "earned",
    label: "Order DCZ-1001",
    points: 200,
    balanceAfter: 200,
    orderId: "O1",
    reason: "2 points per ₹100 spent",
    availableAt: "2026-09-27",
    expiresAt: null,
    createdAt: "2026-09-20",
    ...overrides,
  };
}

function rewardsPage(overrides: Partial<RewardsPage> = {}): RewardsPage {
  return {
    items: [],
    pagination: { page: 1, page_size: 20, total: 0, total_pages: 1 },
    enabled: true,
    available: 500,
    debt: 0,
    availableValue: 50,
    pending: 100,
    nextReleaseAt: "2026-10-05",
    lifetimeEarned: 800,
    lifetimeRedeemed: 200,
    lifetimeExpired: 100,
    lifetimeReversed: 0,
    nextExpiry: null,
    rules: rules(),
    ...overrides,
  };
}

describe("AccountRewardsView", () => {
  describe("loading", () => {
    it("shows placeholders while rewards load", async () => {
      signInCustomer();
      api.get("/account/rewards", () => new Promise(() => undefined));
      const AccountRewardsView = await load();
      const { container } = renderUI(<AccountRewardsView />);
      await waitFor(() => expect(api.requests("GET", "/account/rewards")).toHaveLength(1));
      expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    });
  });

  describe("failure", () => {
    it("shows an error state and retries", async () => {
      api.get("/account/rewards", fail(500));
      signInCustomer();
      const AccountRewardsView = await load();
      const { user } = renderUI(<AccountRewardsView />);
      await screen.findByRole("alert");
      api.get("/account/rewards", rewardsPage());
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Ready to spend")).toBeInTheDocument();
    });
  });

  describe("tiles", () => {
    it("shows available, pending and lifetime figures", async () => {
      api.get("/account/rewards", rewardsPage());
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      expect(await screen.findByText("500")).toBeInTheDocument();
      expect(screen.getByText("Worth ₹50")).toBeInTheDocument();
      expect(screen.getByText("100")).toBeInTheDocument();
      expect(screen.getByText("Next batch ready 5 Oct 2026")).toBeInTheDocument();
      expect(screen.getByText("800")).toBeInTheDocument();
      expect(screen.getByText("200 spent · 100 expired")).toBeInTheDocument();
    });

    it("explains pending points when there's no next-release date", async () => {
      api.get("/account/rewards", rewardsPage({ nextReleaseAt: null }));
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      expect(await screen.findByText("Points from delivered orders")).toBeInTheDocument();
    });
  });

  describe("programme state", () => {
    it("shows a paused notice when rewards are disabled", async () => {
      api.get("/account/rewards", rewardsPage({ enabled: false }));
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      expect(await screen.findByText(/Reward points are paused right now\./)).toBeInTheDocument();
    });

    it("warns about debt from a returned order", async () => {
      api.get("/account/rewards", rewardsPage({ debt: 50 }));
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      expect(await screen.findByText(/50 points from a returned order had already been spent\./)).toBeInTheDocument();
    });

    it("shows the next expiry", async () => {
      api.get("/account/rewards", rewardsPage({ nextExpiry: { at: "2026-12-01", points: 120 } }));
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      expect(await screen.findByText(/120 points expire on/)).toBeInTheDocument();
      expect(screen.getByText("1 Dec 2026")).toBeInTheDocument();
    });
  });

  describe("rules", () => {
    it("lists earn rules, including member multiplier and exclusions when they apply", async () => {
      api.get("/account/rewards", rewardsPage({ rules: rules({ memberMultiplier: 2, excludeTenderPaid: true, excludeDiscountedItems: true, pendingDays: 10 }) }));
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      expect(await screen.findByText("Members earn 2× points.")).toBeInTheDocument();
      expect(screen.getByText(/What you pay with gift cards, store credit or points doesn.t earn points\./)).toBeInTheDocument();
      expect(screen.getByText("Discounted items don’t earn points.")).toBeInTheDocument();
      expect(screen.getByText(/\(10 days\)/)).toBeInTheDocument();
    });

    it("omits the multiplier line and exclusions when they don't apply", async () => {
      api.get("/account/rewards", rewardsPage({ rules: rules({ memberMultiplier: 1, excludeTenderPaid: false, excludeDiscountedItems: false }) }));
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      await screen.findByText(/points for every ₹100/);
      expect(screen.queryByText(/Members earn/)).not.toBeInTheDocument();
      expect(screen.queryByText(/doesn.t earn points/)).not.toBeInTheDocument();
    });

    it("shows spend rules and says points don't expire when expiryMonths is 0", async () => {
      api.get("/account/rewards", rewardsPage({ rules: rules({ expiryMonths: 0, allowWithCoupons: false }) }));
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      expect(await screen.findByText("100 points = ₹10 off at checkout.")).toBeInTheDocument();
      expect(screen.getByText("Points don’t expire.")).toBeInTheDocument();
      expect(screen.getByText("Points can’t be combined with a coupon.")).toBeInTheDocument();
    });
  });

  describe("history", () => {
    it("says there is no history yet", async () => {
      api.get("/account/rewards", rewardsPage({ items: [] }));
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      expect(await screen.findByText(/No points yet/)).toBeInTheDocument();
    });

    it("lists each movement with a sign, and the available-from date for earned points", async () => {
      api.get("/account/rewards", rewardsPage({
        items: [
          entry({ id: 1, label: "Order DCZ-1001", points: 200, kind: "earned", availableAt: "2026-09-27" }),
          entry({ id: 2, label: "Redeemed at checkout", points: -100, kind: "redeemed", availableAt: null, reason: "Order DCZ-1002" }),
        ],
      }));
      signInCustomer();
      const AccountRewardsView = await load();
      renderUI(<AccountRewardsView />);
      expect(await screen.findByText("+200")).toBeInTheDocument();
      expect(screen.getByText("−100")).toBeInTheDocument();
      expect(screen.getByText(/ready 27 Sept 2026/)).toBeInTheDocument();
    });

    it("paginates, requesting the next page", async () => {
      api.get("/account/rewards", (req) => {
        const page = Number(req.query.get("page") ?? 1);
        return rewardsPage({ pagination: { page, page_size: 20, total: 40, total_pages: 2 } });
      });
      signInCustomer();
      const AccountRewardsView = await load();
      const { user } = renderUI(<AccountRewardsView />);
      const nav = await screen.findByRole("navigation", { name: "Pagination" });
      await user.click(within(nav).getByRole("button", { name: "Next page" }));
      await waitFor(() => expect(api.last("GET", "/account/rewards")!.query.get("page")).toBe("2"));
    });
  });
});
