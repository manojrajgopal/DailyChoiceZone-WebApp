import { describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";

import { AdminCampaignDetailView, AdminCampaignsView } from "./AdminCampaignsView";

// Campaigns are found, and their audience's segment, categories and plans
// chosen, by ID (docs/id-lookup.md) — never by name.

const configured = { provider: "test", configured: true, reason: "" };
const options = {
  kinds: [{ value: "promotional", label: "Promotional" }],
  segments: ["all"],
  variables: ["customer_name"],
  starters: {},
  channels: { email: configured, sms: configured, whatsapp: configured, in_app: configured },
  plans: [{ id: "MBP001", name: "Gold" }],
  categories: [{ id: "CAT001", name: "Kurtas" }],
  openTracking: false,
  savedSegments: [{ id: 3, name: "VIP", memberCount: 12, lastCalculatedAt: null }],
};

describe("AdminCampaignsView", () => {
  it("sends the Campaign ID from the address bar as the exact q", async () => {
    setLocation("/admin/marketing/campaigns?q=7");
    api.get("/admin/campaigns", { items: [], pagination: { page: 1, page_size: 25, total: 0, total_pages: 1 }, counts: {} });
    renderUI(<AdminCampaignsView />);
    await waitFor(() => expect(api.last("GET", "/admin/campaigns")?.query.get("q")).toBe("7"));
    expect(await screen.findByRole("group", { name: "Filtered by Campaign ID 7" })).toBeInTheDocument();
  });

  it("suggests Campaign IDs, filters by the one picked, and finds nothing for a name", async () => {
    setLocation("/admin/marketing/campaigns");
    api.get("/admin/campaigns", { items: [], pagination: { page: 1, page_size: 25, total: 0, total_pages: 1 }, counts: {} });
    lookupBackend("campaign", [idPreview("campaign", "7", { title: "Winter edit" }), idPreview("campaign", "70", { title: "Spring" })]);
    const { user } = renderUI(<AdminCampaignsView />);
    const field = await screen.findByRole("combobox", { name: "Campaign ID" });

    await user.type(field, "Winter");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    expect(router.replace).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, "7");
    expect(await screen.findByRole("option", { name: "70" })).toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "7" }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith("/admin/marketing/campaigns?q=7", { scroll: false }));
  });
});

describe("AdminCampaignDetailView audience", () => {
  it("takes the segment, categories and plans by ID and saves the IDs", async () => {
    setLocation("/admin/marketing/campaigns/detail");
    api.get("/admin/campaigns/options", options);
    api.post("/admin/campaigns/estimate", { matching: 0, channels: {}, messages: 0, excluded: {}, capped: false });
    api.post("/admin/campaigns", { id: 9, name: "Winter edit" });
    lookupBackend("segment", [idPreview("segment", "3", { title: "VIP" }), idPreview("segment", "31", { title: "Lapsed" })]);
    lookupBackend("category", [idPreview("category", "CAT001", { title: "Kurtas" }), idPreview("category", "CAT0010", { title: "Sarees" })]);
    lookupBackend("membership_plan", [idPreview("membership_plan", "MBP001", { title: "Gold" })]);
    const { user } = renderUI(<AdminCampaignDetailView />);

    await user.type(await screen.findByLabelText(/Name \(internal\)/), "Winter edit");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Who it goes to");
    // No name-based checklists or segment dropdown any more.
    expect(screen.queryByRole("checkbox", { name: "Kurtas" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Gold" })).not.toBeInTheDocument();

    const segmentField = screen.getByRole("combobox", { name: "Saved segment — Segment ID" });
    await user.type(segmentField, "VIP");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(segmentField);
    await user.type(segmentField, "3");
    await user.click(await screen.findByRole("option", { name: "3" }));
    expect(await screen.findByText("VIP")).toBeInTheDocument();

    const categories = screen.getByRole("combobox", { name: "Bought from these categories — Category ID" });
    await user.type(categories, "Kurtas");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(categories);
    await user.type(categories, "CAT001");
    await user.click(await screen.findByRole("option", { name: "CAT001" }));

    await user.type(screen.getByRole("combobox", { name: "Membership plan — Plan ID" }), "MBP");
    await user.click(await screen.findByRole("option", { name: "MBP001" }));
    expect(within(screen.getByRole("list", { name: "Chosen Membership plan — Plan IDs" })).getByText("MBP001")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.last("POST", "/admin/campaigns")).toBeDefined());
    expect(api.last("POST", "/admin/campaigns")!.body.audience).toEqual({
      segment: "all",
      segmentId: 3,
      categoryIds: ["CAT001"],
      membershipPlanIds: ["MBP001"],
    });
  });
});
