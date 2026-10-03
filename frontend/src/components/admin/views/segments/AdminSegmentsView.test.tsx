import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { paged, segment, segmentDetail } from "@/test/segments-fixtures";
import { useToastStore } from "@/store/toastStore";

import { AdminSegmentsView } from "./AdminSegmentsView";

const page = (items: ReturnType<typeof segment>[], extra: Parameters<typeof paged>[1] = {}, counts = { active: 15, archived: 2 }) => ({
  ...paged(items, extra),
  counts,
});
const lastQuery = () => api.last("GET", "/admin/segments")!.query;
const toasts = () => useToastStore.getState().toasts.map((entry) => entry.message);

describe("AdminSegmentsView", () => {
  describe("states", () => {
    it("shows placeholder rows while loading", () => {
      api.get("/admin/segments", () => new Promise(() => undefined));
      const { container } = renderUI(<AdminSegmentsView />);
      expect(container.querySelectorAll("tbody .animate-pulse").length).toBeGreaterThan(0);
    });

    it("offers a retry when the list doesn't load", async () => {
      api.get("/admin/segments", page([segment()]));
      api.once("GET", "/admin/segments", fail(500));
      const { user } = renderUI(<AdminSegmentsView />);
      expect(await screen.findByText("This didn’t load.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("link", { name: "VIP" })).toBeInTheDocument();
    });

    it("explains a missing segments permission", async () => {
      api.get("/admin/segments", fail(403, "Forbidden", "FORBIDDEN"));
      renderUI(<AdminSegmentsView />);
      expect(await screen.findByText("Your role doesn't include segments")).toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("says when there are no segments, and when nothing matches", async () => {
      api.get("/admin/segments", page([]));
      const { unmount } = renderUI(<AdminSegmentsView />);
      expect(await screen.findByText("No segments yet")).toBeInTheDocument();
      unmount();

      setLocation("/admin/customers/segments?q=zzz");
      renderUI(<AdminSegmentsView />);
      expect(await screen.findByText("No segments match")).toBeInTheDocument();
    });
  });

  describe("rows", () => {
    it("lists name, members, last calculated, kind and status, with the header actions", async () => {
      signIn("admin", "adm");
      api.get(
        "/admin/segments",
        page([
          segment(),
          segment({ id: 7, name: "Diwali shoppers", slug: "diwali", kind: "custom", memberCount: 1234, lastCalculatedAt: null, conditionCount: 1, description: "" }),
        ]),
      );
      renderUI(<AdminSegmentsView />);

      expect(await screen.findByRole("link", { name: "VIP" })).toHaveAttribute("href", "/admin/customers/segments/detail?id=3");
      const rows = screen.getAllByRole("row");
      expect(rows[1]).toHaveTextContent("Big spenders who ordered lately");
      expect(rows[1]).toHaveTextContent("3 conditions · match all");
      expect(rows[1]).toHaveTextContent("Default");
      expect(rows[1]).toHaveTextContent("Active");
      expect(rows[1]).toHaveTextContent("42");
      expect(rows[2]).toHaveTextContent("Custom");
      expect(rows[2]).toHaveTextContent("1,234");
      expect(rows[2]).toHaveTextContent("Not yet");
      expect(rows[2]).toHaveTextContent("1 condition ·");
      expect(within(rows[2]!).getByRole("link", { name: "Edit Diwali shoppers" })).toHaveAttribute("href", "/admin/customers/segments/edit?id=7");
      expect(within(rows[2]!).getByRole("link", { name: "View Diwali shoppers" })).toHaveAttribute("href", "/admin/customers/segments/detail?id=7");

      expect(screen.getByRole("link", { name: /New segment/ })).toHaveAttribute("href", "/admin/customers/segments/edit");
      expect(screen.getByRole("link", { name: /RFM settings/ })).toHaveAttribute("href", "/admin/customers/segments/settings");
      expect(screen.getByRole("tab", { name: "Active 15" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "All 17" })).toBeInTheDocument();
      expect(lastQuery().get("status")).toBe("active");
      expect(api.last("GET", "/admin/segments")!.headers.authorization).toBe("Bearer adm");
    });
  });

  describe("filters", () => {
    it("reads the search, status and page from the URL", async () => {
      setLocation("/admin/customers/segments?q=vip&status=archived&page=2");
      api.get("/admin/segments", page([segment({ status: "archived" })], { page: 2, total: 30, totalPages: 2 }));
      renderUI(<AdminSegmentsView />);
      await screen.findByRole("link", { name: "VIP" });
      expect(Object.fromEntries(lastQuery().entries())).toEqual({ q: "vip", status: "archived", page: "2", pageSize: "25" });
      expect(screen.getByRole("tab", { name: "Archived 2" })).toHaveAttribute("aria-selected", "true");
    });

    it("switches the status tab and searches through the address bar", async () => {
      setLocation("/admin/customers/segments");
      api.get("/admin/segments", page([segment()]));
      const { user } = renderUI(<AdminSegmentsView />);
      await screen.findByRole("link", { name: "VIP" });

      await user.click(screen.getByRole("tab", { name: /^All/ }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/customers/segments?status=all", { scroll: false });

      await user.click(screen.getByRole("tab", { name: /^Active/ }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/customers/segments", { scroll: false });

      await user.type(screen.getByLabelText("Search segments"), "vip");
      await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith("/admin/customers/segments?q=vip", { scroll: false }));
    });

    it("falls back to active for an unknown status", async () => {
      setLocation("/admin/customers/segments?status=evil");
      api.get("/admin/segments", page([segment()]));
      renderUI(<AdminSegmentsView />);
      await screen.findByRole("link", { name: "VIP" });
      expect(lastQuery().get("status")).toBe("active");
    });
  });

  describe("actions", () => {
    it("archives only after confirming", async () => {
      api.get("/admin/segments", page([segment()]));
      api.post("/admin/segments/3/archive", segmentDetail({ status: "archived" }));
      const { user } = renderUI(<AdminSegmentsView />);
      await user.click(await screen.findByRole("button", { name: "Archive VIP" }));

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Archive VIP?");
      expect(api.last("POST", "/admin/segments/3/archive")).toBeUndefined();

      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(api.last("POST", "/admin/segments/3/archive")).toBeUndefined();

      await user.click(screen.getByRole("button", { name: "Archive VIP" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archive segment" }));
      await waitFor(() => expect(api.last("POST", "/admin/segments/3/archive")).toBeTruthy());
      await waitFor(() => expect(toasts()).toContain("VIP archived"));
      expect(api.requests("GET", "/admin/segments").length).toBeGreaterThanOrEqual(2);
    });

    it("shows the server's reason when archiving fails", async () => {
      api.get("/admin/segments", page([segment()]));
      api.post("/admin/segments/3/archive", fail(409, "This segment is already archived.", "SEGMENT_ARCHIVED"));
      const { user } = renderUI(<AdminSegmentsView />);
      await user.click(await screen.findByRole("button", { name: "Archive VIP" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archive segment" }));
      await waitFor(() => expect(toasts()).toContain("This segment is already archived."));
    });

    it("restores an archived segment, which has no edit link", async () => {
      setLocation("/admin/customers/segments?status=archived");
      api.get("/admin/segments", page([segment({ status: "archived" })]));
      api.post("/admin/segments/3/restore", segmentDetail());
      const { user } = renderUI(<AdminSegmentsView />);
      await screen.findByRole("link", { name: "VIP" });
      expect(screen.queryByRole("link", { name: "Edit VIP" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Restore VIP" }));
      await waitFor(() => expect(toasts()).toContain("VIP restored"));
    });

    it("refreshes metrics after confirming and reports the result", async () => {
      api.get("/admin/segments", page([segment()]));
      api.post("/admin/segments/metrics/refresh", { refreshed: 1200, segments: 15 });
      const { user } = renderUI(<AdminSegmentsView />);
      await screen.findByRole("link", { name: "VIP" });
      await user.click(screen.getByRole("button", { name: /Refresh metrics/ }));
      const dialog = await screen.findByRole("dialog");
      expect(api.last("POST", "/admin/segments/metrics/refresh")).toBeUndefined();
      await user.click(within(dialog).getByRole("button", { name: "Refresh metrics" }));
      await waitFor(() => expect(toasts()).toContain("Metrics refreshed for 1,200 customers; 15 segments recalculated."));
    });

    it("says so when the refresh fails", async () => {
      api.get("/admin/segments", page([segment()]));
      api.post("/admin/segments/metrics/refresh", fail(500, "Traceback…"));
      const { user } = renderUI(<AdminSegmentsView />);
      await screen.findByRole("link", { name: "VIP" });
      await user.click(screen.getByRole("button", { name: /Refresh metrics/ }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Refresh metrics" }));
      await waitFor(() => expect(toasts()).toContain("The metrics weren't refreshed. Please try again."));
    });
  });
});
