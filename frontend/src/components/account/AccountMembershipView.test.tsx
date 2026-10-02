import { describe, expect, it } from "vitest";

import type { MembershipSummary, MyMembership } from "@/services/membershipService";
import { api, fail } from "@/test/api";
import { renderUI, screen, within } from "@/test/render";
import { fresh } from "@/test/sliceD-acct1-fixtures";
import { signInCustomer } from "@/test/sliceD-acct3-session";

async function load() {
  fresh();
  return (await import("./AccountMembershipView")).AccountMembershipView;
}

function membership(overrides: Partial<MembershipSummary> = {}): MembershipSummary {
  return {
    id: "M1",
    planId: "annual",
    planName: "Annual",
    status: "active",
    startsAt: "2026-01-01",
    endsAt: "2027-01-01",
    amount: 99900,
    benefits: { freeDelivery: true, freeDeliveriesPerMonth: null, memberDiscountPercent: 10, extraReturnDays: 7, earlyAccess: true, prioritySupport: false },
    freeDeliveriesLeftThisMonth: null,
    savedOnOrders: 1200,
    freeDeliveryOrders: 3,
    ...overrides,
  };
}

function myMembership(overrides: Partial<MyMembership> = {}): MyMembership {
  return {
    programme: { name: "Choice Circle", tagline: "Shop more, save more.", enabled: true },
    membership: membership(),
    history: [],
    ...overrides,
  };
}

describe("AccountMembershipView", () => {
  describe("loading", () => {
    it("shows placeholders while membership loads", async () => {
      signInCustomer();
      api.get("/memberships/me", () => new Promise(() => undefined));
      const AccountMembershipView = await load();
      const { container } = renderUI(<AccountMembershipView />);
      expect(screen.getByRole("heading", { name: "Membership" })).toBeInTheDocument();
      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    });
  });

  describe("failure", () => {
    it("shows an error state and retries", async () => {
      api.get("/memberships/me", fail(500));
      signInCustomer();
      const AccountMembershipView = await load();
      const { user } = renderUI(<AccountMembershipView />);
      expect(await screen.findByText("We couldn't load your membership just now. Please try again.")).toBeInTheDocument();
      api.get("/memberships/me", myMembership());
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("heading", { name: "Annual" })).toBeInTheDocument();
    });
  });

  describe("an active member", () => {
    it("shows the plan, status, dates, figures and benefits", async () => {
      api.get("/memberships/me", myMembership());
      signInCustomer();
      const AccountMembershipView = await load();
      renderUI(<AccountMembershipView />);

      expect(await screen.findByText("Your Choice Circle benefits and savings.")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Annual" })).toBeInTheDocument();
      expect(screen.getByText("Active")).toBeInTheDocument();
      expect(screen.getByText(/Member since 1 Jan 2026 · benefits run until 1 Jan 2027/)).toBeInTheDocument();
      expect(screen.getByText("₹1,200")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
      expect(screen.getByText("Unlimited")).toBeInTheDocument();
      expect(screen.getByText("Free standard delivery on every order")).toBeInTheDocument();
      expect(screen.getByText(/An extra 10% off every order/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Extend your membership/ })).toHaveAttribute("href", "/membership");
    });

    it("shows a finite free-delivery allowance and what's left this month", async () => {
      api.get("/memberships/me", myMembership({
        membership: membership({ benefits: { freeDelivery: true, freeDeliveriesPerMonth: 4, memberDiscountPercent: 0, extraReturnDays: 0, earlyAccess: false, prioritySupport: false }, freeDeliveriesLeftThisMonth: 2 }),
      }));
      signInCustomer();
      const AccountMembershipView = await load();
      renderUI(<AccountMembershipView />);
      expect(await screen.findByText("4 free standard deliveries every month")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("says 'Ended' for a membership that's no longer active, without deliveries-left", async () => {
      api.get("/memberships/me", myMembership({ membership: membership({ status: "expired" }) }));
      signInCustomer();
      const AccountMembershipView = await load();
      renderUI(<AccountMembershipView />);
      expect(await screen.findByText("Ended 1 Jan 2027")).toBeInTheDocument();
      expect(screen.queryByText("Free deliveries left this month")).not.toBeInTheDocument();
    });
  });

  describe("not a member", () => {
    it("invites joining when the programme is open", async () => {
      api.get("/memberships/me", myMembership({ membership: null }));
      signInCustomer();
      const AccountMembershipView = await load();
      renderUI(<AccountMembershipView />);
      expect(await screen.findByText("You're not a Choice Circle member yet")).toBeInTheDocument();
      expect(screen.getByText("Shop more, save more.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Explore Choice Circle/ })).toHaveAttribute("href", "/membership");
    });

    it("says the programme is coming soon when it isn't enabled", async () => {
      api.get("/memberships/me", myMembership({ membership: null, programme: { name: "Choice Circle", tagline: "", enabled: false } }));
      signInCustomer();
      const AccountMembershipView = await load();
      renderUI(<AccountMembershipView />);
      expect(await screen.findByText("Membership opens soon")).toBeInTheDocument();
    });
  });

  describe("history", () => {
    it("lists past memberships, marking the current one", async () => {
      api.get("/memberships/me", myMembership({
        history: [
          membership({ id: "M1", planName: "Annual" }),
          membership({ id: "M0", planName: "Monthly", status: "expired", savedOnOrders: 0 }),
        ],
      }));
      signInCustomer();
      const AccountMembershipView = await load();
      renderUI(<AccountMembershipView />);
      expect(await screen.findByText("Membership history")).toBeInTheDocument();
      const rows = within(screen.getByText("Membership history").closest("section")!).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      expect(within(rows[0]!).getByText("Current")).toBeInTheDocument();
      expect(within(rows[1]!).queryByText("Current")).not.toBeInTheDocument();
      expect(within(rows[1]!).queryByText(/Saved/)).not.toBeInTheDocument();
    });

    it("is omitted when there is no history", async () => {
      api.get("/memberships/me", myMembership({ history: [] }));
      signInCustomer();
      const AccountMembershipView = await load();
      renderUI(<AccountMembershipView />);
      await screen.findByRole("heading", { name: "Annual" });
      expect(screen.queryByText("Membership history")).not.toBeInTheDocument();
    });
  });
});
