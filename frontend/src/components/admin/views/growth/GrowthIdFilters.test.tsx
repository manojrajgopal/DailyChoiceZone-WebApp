import { describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";

import { AdminBundlesView } from "./AdminBundlesView";
import { AdminFlashSalesView } from "./AdminFlashSalesView";
import { AdminReferralsView } from "./AdminReferralsView";

// The growth lists find one record by its ID (docs/id-lookup.md): the box is
// the ID lookup, the list's `q` is that ID exactly, and a name finds nothing.

const empty = (counts: Record<string, number> = {}) => ({
  items: [],
  pagination: { page: 1, page_size: 25, total: 0, total_pages: 1 },
  counts,
});

const cases = [
  {
    name: "bundles",
    path: "/admin/bundles",
    endpoint: "/admin/bundles",
    entity: "bundle" as const,
    label: "Bundle ID",
    render: () => renderUI(<AdminBundlesView />),
  },
  {
    name: "flash sales",
    path: "/admin/flash-sales",
    endpoint: "/admin/flash-sales",
    entity: "flash_sale" as const,
    label: "Flash sale ID",
    render: () => renderUI(<AdminFlashSalesView />),
  },
];

describe.each(cases)("the $name list", ({ path, endpoint, entity, label, render }) => {
  it("sends the ID from the address bar as the exact q, and shows it as the filter", async () => {
    setLocation(`${path}?q=4`);
    api.get(endpoint, empty());
    render();
    await waitFor(() => expect(api.last("GET", endpoint)?.query.get("q")).toBe("4"));
    expect(await screen.findByRole("group", { name: `Filtered by ${label} 4` })).toBeInTheDocument();
  });

  it("suggests IDs as they are typed, filters by the one picked, and finds nothing for a name", async () => {
    setLocation(path);
    api.get(endpoint, empty());
    lookupBackend(entity, [idPreview(entity, "4", { title: "Weekend Flash" }), idPreview(entity, "41", { title: "Office Look" })]);
    const { user } = render();
    const field = await screen.findByRole("combobox", { name: label });

    await user.type(field, "Office");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    expect(router.replace).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, "4");
    expect(await screen.findByRole("option", { name: "41" })).toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "4" }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith(`${path}?q=4`, { scroll: false }));
  });
});

describe("the referrals list", () => {
  const metrics = { days: 30, signups: 0, rewarded: 0, conversion: null, creditPaid: 0, pointsPaid: 0, qualifyingRevenue: 0, inReview: 0, topReferrers: [] };

  it("finds by referral code, exactly; a name or email is not a code", async () => {
    setLocation("/admin/referrals");
    api.get("/admin/referrals", empty());
    api.get("/admin/referrals/metrics", metrics);
    lookupBackend("referral_code", [idPreview("referral_code", "ASHA2026"), idPreview("referral_code", "ASHA20267")]);
    const { user } = renderUI(<AdminReferralsView />);
    const field = await screen.findByRole("combobox", { name: "Referral code ID" });

    await user.type(field, "asha@example.com");
    expect((await screen.findAllByText(/No matching IDs found\.|Invalid/)).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "ASHA");
    await user.click(await screen.findByRole("option", { name: "ASHA2026" }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith("/admin/referrals?q=ASHA2026", { scroll: false }));
  });

  it("switches the box to Customer ID, keeping the kind in the address bar", async () => {
    setLocation("/admin/referrals");
    api.get("/admin/referrals", empty());
    api.get("/admin/referrals/metrics", metrics);
    lookupBackend("customer", [idPreview("customer", "CUS001"), idPreview("customer", "CUS0010")]);
    const { user } = renderUI(<AdminReferralsView />);
    await screen.findByRole("combobox", { name: "Referral code ID" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Which ID to find by" }), "customer");
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith("/admin/referrals?by=customer", { scroll: false }));
  });

  it("sends a Customer ID from the address bar as the exact q", async () => {
    setLocation("/admin/referrals?by=customer&q=CUS001");
    api.get("/admin/referrals", empty());
    api.get("/admin/referrals/metrics", metrics);
    renderUI(<AdminReferralsView />);
    await waitFor(() => expect(api.last("GET", "/admin/referrals")?.query.get("q")).toBe("CUS001"));
    expect(await screen.findByRole("group", { name: "Filtered by Customer ID CUS001" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Which ID to find by" })).toHaveValue("customer");
    // Only the ID goes to the server; which kind it is stays in the address bar.
    expect(api.last("GET", "/admin/referrals")?.query.get("by")).toBeNull();
  });
});
