import { describe, expect, it } from "vitest";

import { api, ok } from "@/test/api";

import {
  abandonMembershipCheckout,
  cancelMembership,
  createMembershipPlan,
  deleteMembershipPlan,
  getMembershipOverview,
  getMembershipProgramme,
  getMyMembership,
  listMembers,
  listMembershipPlans,
  saveMembershipProgramme,
  searchMembers,
  startMembershipCheckout,
  updateMembershipPlan,
  verifyMembershipPayment,
} from "./membershipService";

describe("shopper-facing calls", () => {
  it("getMembershipOverview GETs with the customer token when present", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/memberships", { name: "Choice Circle", tagline: "", enabled: true, plans: [], membership: null });
    await getMembershipOverview();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("getMyMembership GETs the signed-in member's own data", async () => {
    api.get("/memberships/me", { programme: { name: "x", tagline: "", enabled: true }, membership: null, history: [] });
    const result = await getMyMembership();
    expect(result.history).toEqual([]);
  });

  it("startMembershipCheckout POSTs the chosen plan", async () => {
    api.post("/memberships/checkout", (req) => ({ membershipId: "M1", status: "pending", gateway: null, membership: null, ...(req.body as object) }));
    await startMembershipCheckout("plan-1");
    expect(api.last()!.body).toEqual({ planId: "plan-1" });
  });

  it("verifyMembershipPayment POSTs the gateway confirmation", async () => {
    api.post("/memberships/M1/verify", (req) => ({ id: "M1", ...(req.body as object) }));
    const confirmation = { razorpayPaymentId: "p1", razorpayOrderId: "o1", razorpaySignature: "sig" };
    await verifyMembershipPayment("M1", confirmation);
    expect(api.last()!.body).toEqual(confirmation);
  });

  it("abandonMembershipCheckout POSTs to the abandon endpoint", async () => {
    api.post("/memberships/M1/abandon", {});
    await abandonMembershipCheckout("M1");
    expect(api.requests("POST", "/memberships/M1/abandon")).toHaveLength(1);
  });
});

describe("admin calls", () => {
  it("getMembershipProgramme / saveMembershipProgramme use admin auth", async () => {
    window.localStorage.setItem("dcz:admin-token", "adm");
    api.get("/admin/memberships/programme", { name: "x", tagline: "", enabled: true });
    await getMembershipProgramme();
    expect(api.last()!.headers.authorization).toBe("Bearer adm");

    api.put("/admin/memberships/programme", (req) => req.body);
    await saveMembershipProgramme({ name: "New", tagline: "t", enabled: false });
    expect(api.last()!.headers.authorization).toBe("Bearer adm");
    expect(api.last()!.body).toEqual({ name: "New", tagline: "t", enabled: false });
  });

  it("listMembershipPlans / createMembershipPlan / updateMembershipPlan / deleteMembershipPlan", async () => {
    api.get("/admin/memberships/plans", ok([]));
    await listMembershipPlans();

    api.post("/admin/memberships/plans", (req) => ({ id: "NEW", pricePerMonth: 0, ...(req.body as object) }));
    const plan = await createMembershipPlan({
      name: "Gold", description: "", durationMonths: 12, price: 999, compareAtPrice: null,
      freeDelivery: true, freeDeliveriesPerMonth: null, memberDiscountPercent: 5, extraReturnDays: 7,
      earlyAccess: true, prioritySupport: true, badge: "", active: true, sortOrder: 1,
    });
    expect(plan.id).toBe("NEW");

    api.put("/admin/memberships/plans/NEW", (req) => ({ id: "NEW", ...(req.body as object) }));
    await updateMembershipPlan("NEW", { active: false });
    expect(api.last("PUT")!.body).toEqual({ active: false });

    api.delete("/admin/memberships/plans/NEW", { outcome: "retired" });
    expect(await deleteMembershipPlan("NEW")).toEqual({ outcome: "retired" });
  });

  it("listMembers filters by status and limit", async () => {
    api.get(/\/admin\/memberships(\?|$)/, ok([]));
    await listMembers({ status: "active", limit: 10 });
    const request = api.last()!;
    expect(request.query.get("status")).toBe("active");
    expect(request.query.get("limit")).toBe("10");
  });

  it("listMembers with no filters sends no query string", async () => {
    api.get(/\/admin\/memberships(\?|$)/, ok([]));
    await listMembers();
    expect(api.last()!.url).not.toContain("?");
  });

  it("searchMembers builds a query from the given filters", async () => {
    api.get(/\/admin\/memberships\/search/, ok({ items: [], pagination: {}, counts: {}, plans: [] }));
    await searchMembers({ status: "active", plan: "gold", q: "asha", page: 2, pageSize: 20 });
    const request = api.last()!;
    expect(request.query.get("status")).toBe("active");
    expect(request.query.get("plan")).toBe("gold");
    expect(request.query.get("q")).toBe("asha");
    expect(request.query.get("page")).toBe("2");
  });

  it("cancelMembership POSTs to the cancel endpoint", async () => {
    api.post("/admin/memberships/M1/cancel", { id: "M1", status: "cancelled" });
    const result = await cancelMembership("M1");
    expect(result.status).toBe("cancelled");
  });
});
