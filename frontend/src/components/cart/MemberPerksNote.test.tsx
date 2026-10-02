import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberPerks } from "@/services/cartService";
import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";

function perks(overrides: Partial<MemberPerks> = {}): MemberPerks {
  return {
    name: "Choice Circle",
    planName: "Annual",
    endsAt: "2027-01-01",
    discountPercent: 10,
    freeDelivery: true,
    freeDeliveriesLeft: 2,
    ...overrides,
  };
}

/**
 * `MemberPerksNote` caches the fetched programme in a module-scope variable
 * shared by every mounted instance (see the component's `programme` let), so
 * each test needs its own fresh module registry — otherwise a later test
 * would see an earlier test's cached (or failed) fetch instead of its own.
 */
async function load() {
  vi.resetModules();
  return (await import("./MemberPerksNote")).MemberPerksNote;
}

describe("MemberPerksNote", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("a member", () => {
    it("names the programme and lists the discount and free delivery applied", async () => {
      const MemberPerksNote = await load();
      renderUI(<MemberPerksNote membership={perks()} />);
      expect(screen.getByText("Choice Circle member")).toBeInTheDocument();
      expect(screen.getByText(/— 10% member savings and free delivery applied to this order\./)).toBeInTheDocument();
      expect(screen.getByText("2 free deliveries left this month.")).toBeInTheDocument();
      // A member's offer is never fetched.
      expect(api.calls).toHaveLength(0);
    });

    it("uses the singular for exactly one free delivery left", async () => {
      const MemberPerksNote = await load();
      renderUI(<MemberPerksNote membership={perks({ freeDeliveriesLeft: 1 })} />);
      expect(screen.getByText("1 free delivery left this month.")).toBeInTheDocument();
    });

    it("says the month's free deliveries are used up at zero", async () => {
      const MemberPerksNote = await load();
      renderUI(<MemberPerksNote membership={perks({ freeDeliveriesLeft: 0 })} />);
      expect(screen.getByText("You've used this month's free deliveries.")).toBeInTheDocument();
    });

    it("omits the free-delivery line when it is unlimited (null)", async () => {
      const MemberPerksNote = await load();
      renderUI(<MemberPerksNote membership={perks({ freeDeliveriesLeft: null })} />);
      expect(screen.queryByText(/free deliver/i, { selector: "span" })).not.toBeInTheDocument();
    });

    it("ends with a bare period when there is no discount and no free delivery", async () => {
      const MemberPerksNote = await load();
      const { container } = renderUI(
        <MemberPerksNote membership={perks({ discountPercent: 0, freeDelivery: false, freeDeliveriesLeft: null })} />,
      );
      expect(container.querySelector("p")).toHaveTextContent("Choice Circle member.");
    });

    it("lists only the free delivery perk when there is no discount", async () => {
      const MemberPerksNote = await load();
      renderUI(<MemberPerksNote membership={perks({ discountPercent: 0 })} />);
      expect(screen.getByText(/— free delivery applied to this order\./)).toBeInTheDocument();
    });
  });

  describe("not a member", () => {
    it("invites joining when the programme is open and has a plan, showing the cheapest per month", async () => {
      api.get("/memberships", {
        name: "Choice Circle",
        enabled: true,
        plans: [
          { price: 999, durationMonths: 12, freeDelivery: true, memberDiscountPercent: 10 },
          { price: 199, durationMonths: 1, freeDelivery: false, memberDiscountPercent: 5 },
        ],
      });
      const MemberPerksNote = await load();
      renderUI(<MemberPerksNote membership={null} />);
      expect(await screen.findByText("Join Choice Circle")).toBeInTheDocument();
      // ₹999/12 ≈ ₹83, cheaper per month than ₹199/1.
      expect(screen.getByText(/free delivery and 10% off every order, from ₹83\/month\./)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Join Choice Circle/ })).toHaveAttribute("href", "/membership");
    });

    it("says member benefits instead of free delivery when the cheapest plan has none", async () => {
      api.get("/memberships", {
        name: "Choice Circle",
        enabled: true,
        plans: [{ price: 100, durationMonths: 1, freeDelivery: false, memberDiscountPercent: 0 }],
      });
      const MemberPerksNote = await load();
      renderUI(<MemberPerksNote membership={null} />);
      expect(await screen.findByText(/member benefits, from ₹100\/month\./)).toBeInTheDocument();
    });

    it("renders nothing while the programme is disabled", async () => {
      api.get("/memberships", { name: "Choice Circle", enabled: false, plans: [{ price: 1, durationMonths: 1, freeDelivery: true, memberDiscountPercent: 1 }] });
      const MemberPerksNote = await load();
      const { container } = renderUI(<MemberPerksNote membership={null} />);
      await waitFor(() => expect(api.requests("GET", "/memberships")).toHaveLength(1));
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when the programme has no plans", async () => {
      api.get("/memberships", { name: "Choice Circle", enabled: true, plans: [] });
      const MemberPerksNote = await load();
      const { container } = renderUI(<MemberPerksNote membership={null} />);
      await waitFor(() => expect(api.requests("GET", "/memberships")).toHaveLength(1));
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when the programme can't be loaded, and recovers on the next mount", async () => {
      api.get("/memberships", fail(500));
      const MemberPerksNote = await load();
      const { container, unmount } = renderUI(<MemberPerksNote membership={null} />);
      await waitFor(() => expect(api.requests("GET", "/memberships")).toHaveLength(1));
      expect(container).toBeEmptyDOMElement();
      unmount();

      api.get("/memberships", { name: "Choice Circle", enabled: true, plans: [{ price: 120, durationMonths: 1, freeDelivery: true, memberDiscountPercent: 0 }] });
      renderUI(<MemberPerksNote membership={null} />);
      expect(await screen.findByText("Join Choice Circle")).toBeInTheDocument();
    });
  });
});
