import { describe, expect, it, vi } from "vitest";

import type { MyReferrals } from "@/services/growthService";
import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";
import { fresh } from "@/test/sliceD-acct1-fixtures";
import { signInCustomer } from "@/test/sliceD-acct3-session";

async function load() {
  fresh();
  return (await import("./AccountReferralsView")).AccountReferralsView;
}

function referrals(overrides: Partial<MyReferrals> = {}): MyReferrals {
  return {
    rules: {
      enabled: true,
      rewardType: "store_credit",
      referrerReward: 20000,
      refereeReward: 10000,
      minOrderAmount: 50000,
      rewardOn: "delivered",
      windowDays: 30,
      unit: "order",
    },
    code: "ASHA50",
    codeDisabled: false,
    shareUrl: "https://dcz.example/r/ASHA50",
    stats: { invited: 2, pending: 1, rewarded: 1, earnedCredit: 20000, earnedPoints: 0 },
    referrals: [],
    joinedWith: null,
    unit: "order",
    ...overrides,
  };
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("AccountReferralsView", () => {
  describe("loading", () => {
    it("shows placeholders while referrals load", async () => {
      signInCustomer();
      api.get("/account/referrals", () => new Promise(() => undefined));
      const AccountReferralsView = await load();
      const { container } = renderUI(<AccountReferralsView />);
      await waitFor(() => expect(api.requests("GET", "/account/referrals")).toHaveLength(1));
      expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    });
  });

  describe("failure", () => {
    it("shows an error state and retries", async () => {
      api.get("/account/referrals", fail(500));
      signInCustomer();
      const AccountReferralsView = await load();
      const { user } = renderUI(<AccountReferralsView />);
      await screen.findByRole("alert");

      api.get("/account/referrals", referrals());
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("ASHA50")).toBeInTheDocument();
    });
  });

  describe("programme states", () => {
    it("shows the paused message when the programme is disabled", async () => {
      api.get("/account/referrals", referrals({ rules: { ...referrals().rules, enabled: false } }));
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText(/referral programme is paused/)).toBeInTheDocument();
    });

    it("shows a message when this shopper's own code is disabled", async () => {
      api.get("/account/referrals", referrals({ codeDisabled: true }));
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText(/referral code has been switched off/)).toBeInTheDocument();
    });

    it("shows the code, copy and share actions", async () => {
      api.get("/account/referrals", referrals());
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText("ASHA50")).toBeInTheDocument();
      expect(screen.getByText("https://dcz.example/r/ASHA50")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Copy code/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Share link/ })).toBeInTheDocument();
    });
  });

  describe("how it works", () => {
    it("describes the reward as store credit or points, for both sides", async () => {
      api.get("/account/referrals", referrals());
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText("You get ₹20,000 store credit, and they get ₹10,000 store credit.")).toBeInTheDocument();
    });

    it("describes points rewards", async () => {
      api.get("/account/referrals", referrals({ rules: { ...referrals().rules, rewardType: "points", referrerReward: 500, refereeReward: 0 } }));
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText(/You get 500 reward points\.$/)).toBeInTheDocument();
    });

    it("says 'paid for' when the reward triggers on payment rather than delivery", async () => {
      api.get("/account/referrals", referrals({ rules: { ...referrals().rules, rewardOn: "paid" } }));
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText(/is paid for within 30 days\./)).toBeInTheDocument();
    });
  });

  describe("friends who joined", () => {
    it("says nobody has joined yet", async () => {
      api.get("/account/referrals", referrals());
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText("No one has joined with your code yet.")).toBeInTheDocument();
    });

    it("lists each friend with status, reward and expiry", async () => {
      api.get("/account/referrals", referrals({
        referrals: [
          { id: 1, name: "Priya", status: "rewarded", statusLabel: "Rewarded", joinedAt: "2026-08-01", rewardedAt: "2026-08-10", reward: "₹200 credited", expiresAt: null },
          { id: 2, name: "Rahul", status: "pending", statusLabel: "Waiting on first order", joinedAt: "2026-09-01", rewardedAt: null, reward: null, expiresAt: "2026-10-01" },
        ],
      }));
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText("Priya")).toBeInTheDocument();
      expect(screen.getByText("₹200 credited")).toBeInTheDocument();
      expect(screen.getByText("Rahul")).toBeInTheDocument();
      expect(screen.getByText("Waiting on first order")).toBeInTheDocument();
      expect(screen.getByText(/Order by/)).toBeInTheDocument();
    });

    it("shows invited/rewarded/earned stats", async () => {
      api.get("/account/referrals", referrals({ stats: { invited: 5, pending: 1, rewarded: 3, earnedCredit: 60000, earnedPoints: 400 } }));
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText("5 joined · 3 rewarded · ₹60,000 earned · 400 points earned")).toBeInTheDocument();
    });
  });

  describe("joined with a friend's code", () => {
    it("shows the status and reward", async () => {
      api.get("/account/referrals", referrals({ joinedWith: { status: "rewarded", statusLabel: "Rewarded", reward: "₹100", expiresAt: null } }));
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText(/You joined with a friend.s code: rewarded — ₹100 added to your account\./)).toBeInTheDocument();
    });

    it("ends with a bare period when there is no reward yet", async () => {
      api.get("/account/referrals", referrals({ joinedWith: { status: "pending", statusLabel: "Pending", reward: null, expiresAt: null } }));
      signInCustomer();
      const AccountReferralsView = await load();
      renderUI(<AccountReferralsView />);
      expect(await screen.findByText(/You joined with a friend.s code: pending\./)).toBeInTheDocument();
    });
  });

  describe("copy and share", () => {
    it("copies the code to the clipboard", async () => {
      api.get("/account/referrals", referrals());
      signInCustomer();
      const AccountReferralsView = await load();
      // user-event's own setup() installs its own clipboard stub, so this
      // replaces it only after renderUI (which calls that setup) has run.
      const { user } = renderUI(<AccountReferralsView />);
      const writeText = stubClipboard();
      await user.click(await screen.findByRole("button", { name: /Copy code/ }));
      expect(writeText).toHaveBeenCalledWith("ASHA50");
    });

    it("uses the Web Share API when available", async () => {
      api.get("/account/referrals", referrals());
      signInCustomer();
      const share = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "share", { value: share, configurable: true });
      const AccountReferralsView = await load();
      const { user } = renderUI(<AccountReferralsView />);
      await user.click(await screen.findByRole("button", { name: /Share link/ }));
      expect(share).toHaveBeenCalledWith({ title: "Daily Choice Zone", text: expect.stringContaining("ASHA50"), url: "https://dcz.example/r/ASHA50" });
      Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    });

    it("falls back to copying the link when there is no Web Share API", async () => {
      api.get("/account/referrals", referrals());
      signInCustomer();
      Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
      const AccountReferralsView = await load();
      const { user } = renderUI(<AccountReferralsView />);
      const writeText = stubClipboard();
      await user.click(await screen.findByRole("button", { name: /Share link/ }));
      expect(writeText).toHaveBeenCalledWith("https://dcz.example/r/ASHA50");
    });
  });
});
