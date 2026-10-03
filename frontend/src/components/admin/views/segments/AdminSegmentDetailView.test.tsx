import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, fail, file } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { member, paged, registry, segmentDetail } from "@/test/segments-fixtures";
import { useToastStore } from "@/store/toastStore";

import { AdminSegmentDetailView, historyDetail } from "./AdminSegmentDetailView";

const toasts = () => useToastStore.getState().toasts.map((entry) => entry.message);

beforeEach(() => {
  setLocation("/admin/customers/segments/detail?id=3");
  api.get("/admin/segments/fields", registry());
  api.get("/admin/segments/3", segmentDetail());
  api.get("/admin/segments/3/members", (req) => ({
    ...paged(req.query.get("q") === "zzz" ? [] : [member(), member({ customerId: "CUS002", name: "Ravi K", rfmLabel: "no-orders", rfmScore: "000", lastOrderAt: null })], {
      total: req.query.get("q") === "zzz" ? 0 : 60,
      totalPages: 3,
      page: Number(req.query.get("page") ?? 1),
    }),
    masked: true,
  }));
});

async function renderDetail() {
  const view = renderUI(<AdminSegmentDetailView />);
  await screen.findByRole("heading", { name: "VIP" });
  return view;
}

describe("AdminSegmentDetailView", () => {
  describe("states", () => {
    it("says when the segment doesn't exist", async () => {
      api.get("/admin/segments/3", fail(404, "Not found", "SEGMENT_NOT_FOUND"));
      renderUI(<AdminSegmentDetailView />);
      expect(await screen.findByText("That segment doesn't exist.")).toBeInTheDocument();
    });

    it("explains a missing segments permission", async () => {
      api.get("/admin/segments/3", fail(403, "Forbidden", "FORBIDDEN"));
      renderUI(<AdminSegmentDetailView />);
      expect(await screen.findByText("Your role doesn't include segments")).toBeInTheDocument();
    });

    it("offers a retry when it doesn't load", async () => {
      api.once("GET", "/admin/segments/3", fail(500));
      const { user } = renderUI(<AdminSegmentDetailView />);
      await user.click(await screen.findByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("heading", { name: "VIP" })).toBeInTheDocument();
    });
  });

  describe("header and rules", () => {
    it("shows the name, description, kind, status, size and freshness, with the integrations", async () => {
      await renderDetail();
      expect(screen.getByText("Big spenders who ordered lately")).toBeInTheDocument();
      expect(screen.getByText("Default")).toBeInTheDocument();
      expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
      expect(screen.getByText("Members").closest("div")).toHaveTextContent("42");
      expect(screen.getByRole("link", { name: /Edit/ })).toHaveAttribute("href", "/admin/customers/segments/edit?id=3");
      expect(screen.getByRole("link", { name: /Send campaign to this segment/ })).toHaveAttribute("href", "/admin/marketing/campaigns/detail?segmentId=3");
      expect(screen.getByRole("link", { name: /Create coupon for this segment/ })).toHaveAttribute("href", "/admin/coupons?new=1&segmentId=3");
    });

    it("summarises the rules in words", async () => {
      await renderDetail();
      const rules = screen.getByRole("list", { name: "Rules" });
      await waitFor(() => expect(rules).toHaveTextContent("Total spend is at least ₹25,000"));
      expect(rules).toHaveTextContent("Total orders is at least 5");
      expect(rules).toHaveTextContent("any of:");
      expect(rules).toHaveTextContent("City is any of Bengaluru, Mysuru");
      expect(rules).toHaveTextContent("Last order is within the last 180 days");
    });
  });

  describe("members", () => {
    it("lists members as sent (masked), pages and searches them", async () => {
      const { user } = await renderDetail();
      const table = await screen.findByRole("table", { name: "Members" });
      expect(await within(table).findByRole("link", { name: "Asha Rao" })).toHaveAttribute("href", "/admin/customers/detail?id=CUS001");
      const rows = within(table).getAllByRole("row");
      expect(rows[1]).toHaveTextContent("a••••@example.com · 987•••00001");
      expect(rows[1]).toHaveTextContent("Bengaluru, Karnataka");
      expect(rows[1]).toHaveTextContent("₹5,400");
      expect(rows[1]).toHaveTextContent("Loyal");
      expect(rows[1]).toHaveTextContent("343");
      expect(rows[2]).toHaveTextContent("Never");
      expect(rows[2]).toHaveTextContent("No orders");
      expect(screen.getByText("Contact details are masked for your role.")).toBeInTheDocument();
      expect(screen.getByText("60 members")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Page 2" }));
      await waitFor(() => expect(api.last("GET", "/admin/segments/3/members")!.query.get("page")).toBe("2"));

      await user.type(screen.getByLabelText("Search members"), "zzz");
      expect(await screen.findByText("No members match")).toBeInTheDocument();
      expect(api.last("GET", "/admin/segments/3/members")!.query.get("q")).toBe("zzz");
      expect(api.last("GET", "/admin/segments/3/members")!.query.get("page")).toBe("1");
    });
  });

  describe("RFM and history", () => {
    it("draws the label distribution and the R/F/M score bars", async () => {
      await renderDetail();
      expect(screen.getByText("Champions")).toBeInTheDocument();
      expect(screen.getByText("30")).toBeInTheDocument();
      // A label nobody has is left out.
      expect(screen.queryByText("Lost")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Recency 5: 30")).toBeInTheDocument();
      expect(screen.getByLabelText("Recency 4: 12")).toBeInTheDocument();
      expect(screen.getByLabelText("Frequency 5: 42")).toBeInTheDocument();
      expect(screen.getByLabelText("Monetary 3: 2")).toBeInTheDocument();
      expect(screen.getByLabelText("Monetary 1: 0")).toBeInTheDocument();
    });

    it("lists what happened, who did it and the change", async () => {
      await renderDetail();
      const history = screen.getByRole("list", { name: "History" });
      const items = within(history).getAllByRole("listitem");
      expect(items[0]).toHaveTextContent("Recalculated40 → 42 members");
      expect(items[0]).toHaveTextContent("Manoj ·");
      expect(items[1]).toHaveTextContent("Created");
      expect(items[1]).toHaveTextContent("System ·");
    });

    it("describes each kind of change", () => {
      const entry = { id: 1, action: "x", label: "X", actor: "ADM001", actorName: "M", at: "2026-10-08T06:00:00" };
      expect(historyDetail({ ...entry, details: { rows: 1 } })).toBe("1 row");
      expect(historyDetail({ ...entry, details: { before: [{ field: "a" }], after: [{ field: "a" }, { match: "any", rules: [{}, {}] }] } })).toBe("1 → 3 conditions");
      expect(historyDetail({ ...entry, details: { before: { name: "A", description: "" }, after: { name: "B", description: "" } } })).toBe("Changed name");
      expect(historyDetail({ ...entry, details: null })).toBe("");
    });
  });

  describe("actions", () => {
    it("recalculates and reports before → after", async () => {
      api.post("/admin/segments/3/recalculate", segmentDetail({ memberCount: 45 }));
      const { user } = await renderDetail();
      await user.click(screen.getByRole("button", { name: /Recalculate/ }));
      await waitFor(() => expect(toasts()).toContain("Recalculated: 42 → 45 members."));
      expect(api.requests("GET", "/admin/segments/3").length).toBeGreaterThanOrEqual(2);
    });

    it("exports the CSV when allowed", async () => {
      api.get("/admin/segments/3/export", file("id\n", { "content-disposition": 'attachment; filename="segment-vip-2026-10-08.csv"' }));
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
      const { user } = await renderDetail();
      await user.click(screen.getByRole("button", { name: /Export CSV/ }));
      await waitFor(() => expect(toasts()).toContain("Export downloaded."));
      expect(api.last("GET", "/admin/segments/3/export")).toBeTruthy();
    });

    it("hides the export without segments-export", async () => {
      api.get("/admin/segments/3", segmentDetail({ actions: { edit: true, archive: true, restore: false, recalculate: true, export: false } }));
      await renderDetail();
      expect(screen.queryByRole("button", { name: /Export CSV/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Recalculate/ })).toBeInTheDocument();
    });

    it("archives only after confirming", async () => {
      api.post("/admin/segments/3/archive", segmentDetail({ status: "archived" }));
      const { user } = await renderDetail();
      await user.click(screen.getByRole("button", { name: /^Archive$/ }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Archive VIP?");
      expect(api.last("POST", "/admin/segments/3/archive")).toBeUndefined();
      await user.click(within(dialog).getByRole("button", { name: "Archive segment" }));
      await waitFor(() => expect(api.last("POST", "/admin/segments/3/archive")).toBeTruthy());
      await waitFor(() => expect(toasts()).toContain("VIP archived"));
    });

    it("offers restore (and no campaign or coupon links) for an archived segment", async () => {
      api.get(
        "/admin/segments/3",
        segmentDetail({ status: "archived", actions: { edit: false, archive: false, restore: true, recalculate: false, export: true } }),
      );
      api.post("/admin/segments/3/restore", segmentDetail());
      const { user } = await renderDetail();
      expect(screen.queryByRole("link", { name: /Send campaign/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Edit/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Archive$/ })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /Restore/ }));
      await waitFor(() => expect(toasts()).toContain("VIP restored"));
    });

    it("shows the reason when a recalculation is refused", async () => {
      api.post("/admin/segments/3/recalculate", fail(409, "This segment is archived. Restore it first.", "SEGMENT_ARCHIVED"));
      const { user } = await renderDetail();
      await user.click(screen.getByRole("button", { name: /Recalculate/ }));
      await waitFor(() => expect(toasts()).toContain("This segment is archived. Restore it first."));
    });
  });
});
