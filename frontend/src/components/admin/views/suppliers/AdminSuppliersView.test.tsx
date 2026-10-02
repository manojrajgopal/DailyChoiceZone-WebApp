import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { page, supplier } from "@/test/suppliers-fixtures";

import { AdminSuppliersView } from "./AdminSuppliersView";

const lastQuery = () => api.last("GET", "/admin/suppliers")!.query;

describe("AdminSuppliersView", () => {
  describe("loading, error, empty and access", () => {
    it("shows placeholder rows while loading", () => {
      api.get("/admin/suppliers", () => new Promise(() => undefined));
      const { container } = renderUI(<AdminSuppliersView />);
      expect(container.querySelectorAll("tbody .animate-pulse").length).toBeGreaterThan(0);
    });

    it("offers a retry when the list doesn't load", async () => {
      api.get("/admin/suppliers", page([supplier()]));
      api.once("GET", "/admin/suppliers", fail(500));
      const { user } = renderUI(<AdminSuppliersView />);
      expect(await screen.findByText("This didn’t load.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("link", { name: "Anvi Textiles" })).toBeInTheDocument();
    });

    it("explains a missing suppliers permission", async () => {
      api.get("/admin/suppliers", fail(403, "Forbidden", "FORBIDDEN"));
      renderUI(<AdminSuppliersView />);
      expect(await screen.findByText("Your role doesn't include suppliers")).toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /New supplier/ })).not.toBeInTheDocument();
    });

    it("invites adding the first supplier when there are none", async () => {
      api.get("/admin/suppliers", page([]));
      renderUI(<AdminSuppliersView />);
      expect(await screen.findByText("No suppliers yet")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Add your first supplier" })).toHaveAttribute("href", "/admin/suppliers/new");
    });

    it("says nothing matches a search, without the first-supplier prompt", async () => {
      setLocation("/admin/suppliers?q=zzz");
      api.get("/admin/suppliers", page([]));
      renderUI(<AdminSuppliersView />);
      expect(await screen.findByText("No suppliers match")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Add your first supplier" })).not.toBeInTheDocument();
    });
  });

  describe("rows", () => {
    it("lists suppliers with their contact, GSTIN, terms and status", async () => {
      signIn("admin", "adm");
      api.get(
        "/admin/suppliers",
        page(
          [
            supplier(),
            supplier({ id: "SUP/2", code: "BLUE", name: "Blue Looms", contactPerson: "", phone: "", email: "x@blue.example", gstin: null, paymentTerms: "", creditDays: 15, status: "inactive", createdAt: "" }),
            supplier({ id: "SUP3", code: "NOTERMS", name: "No Terms Co", paymentTerms: "", creditDays: 0 }),
          ],
          { counts: { active: 2, inactive: 1, archived: 4 } },
        ),
      );
      renderUI(<AdminSuppliersView />);

      expect(await screen.findByRole("link", { name: "Anvi Textiles" })).toHaveAttribute("href", "/admin/suppliers/detail?id=SUP001");
      expect(screen.getByRole("link", { name: "Blue Looms" })).toHaveAttribute("href", "/admin/suppliers/detail?id=SUP%2F2");
      const rows = screen.getAllByRole("row");
      expect(rows[1]).toHaveTextContent("ANVI-TEX");
      expect(rows[1]).toHaveTextContent("R. Kumar");
      expect(rows[1]).toHaveTextContent("9876543210 · sales@anvi.example");
      expect(rows[1]).toHaveTextContent("29ABCDE1234F1Z5");
      expect(rows[1]).toHaveTextContent("Net 30");
      expect(rows[1]).toHaveTextContent("Active");
      expect(rows[1]).toHaveTextContent("1 Sept 2026");
      expect(rows[2]).toHaveTextContent("15 days");
      expect(rows[2]).toHaveTextContent("Inactive");
      expect(within(rows[2]!).getAllByText("—").length).toBe(3);
      expect(within(rows[3]!).getAllByText("—").length).toBe(1);

      expect(screen.getByRole("tab", { name: "All current 3" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "Archived 4" })).toBeInTheDocument();
      expect(lastQuery().get("sort")).toBe("name");
      expect(api.last("GET", "/admin/suppliers")!.headers.authorization).toBe("Bearer adm");
      expect(screen.getByRole("link", { name: /New supplier/ })).toHaveAttribute("href", "/admin/suppliers/new");
    });
  });

  describe("filters", () => {
    it("reads the search, status, sort and page from the URL", async () => {
      setLocation("/admin/suppliers?q=anvi&status=archived&sort=createdAt&page=2&pageSize=100");
      api.get("/admin/suppliers", page([supplier()], { page: 2, total: 120, totalPages: 2 }));
      renderUI(<AdminSuppliersView />);
      await screen.findByRole("link", { name: "Anvi Textiles" });
      expect(Object.fromEntries(lastQuery().entries())).toEqual({ q: "anvi", status: "archived", sort: "createdAt", page: "2", pageSize: "100" });
      expect(screen.getByRole("combobox", { name: "Sort suppliers" })).toHaveValue("createdAt");
      expect(screen.getByText("Showing 101–120 of 120")).toBeInTheDocument();
    });

    it("falls back to sorting by name for an unknown sort", async () => {
      setLocation("/admin/suppliers?sort=evil");
      api.get("/admin/suppliers", page([supplier()]));
      renderUI(<AdminSuppliersView />);
      await screen.findByRole("link", { name: "Anvi Textiles" });
      expect(lastQuery().get("sort")).toBe("name");
    });

    it("switches status tab, sort and search through the address bar", async () => {
      setLocation("/admin/suppliers");
      api.get("/admin/suppliers", (req) => page(req.query.get("status") === "archived" ? [] : [supplier()]));
      const { user, rerender } = renderUI(<AdminSuppliersView />);
      await screen.findByRole("link", { name: "Anvi Textiles" });

      await user.click(screen.getByRole("tab", { name: /^Archived/ }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/suppliers?status=archived", { scroll: false });
      rerender(<AdminSuppliersView />);
      expect(await screen.findByText("No suppliers match")).toBeInTheDocument();
      expect(lastQuery().get("status")).toBe("archived");

      await user.selectOptions(screen.getByRole("combobox", { name: "Sort suppliers" }), "code");
      expect(router.replace).toHaveBeenLastCalledWith("/admin/suppliers?status=archived&sort=code", { scroll: false });
      rerender(<AdminSuppliersView />);
      // Name is the default, so choosing it again takes it out of the URL.
      await user.selectOptions(screen.getByRole("combobox", { name: "Sort suppliers" }), "name");
      expect(router.replace).toHaveBeenLastCalledWith("/admin/suppliers?status=archived", { scroll: false });
      rerender(<AdminSuppliersView />);

      await user.type(screen.getByLabelText("Search suppliers"), "29ABCDE");
      await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith("/admin/suppliers?q=29ABCDE&status=archived", { scroll: false }));
    });

    it("clears the filters", async () => {
      setLocation("/admin/suppliers?q=anvi&status=inactive");
      api.get("/admin/suppliers", page([supplier()]));
      const { user } = renderUI(<AdminSuppliersView />);
      await screen.findByRole("link", { name: "Anvi Textiles" });
      await user.click(screen.getByRole("button", { name: /Clear filters/ }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/suppliers", { scroll: false });
    });

    it("pages through the results", async () => {
      setLocation("/admin/suppliers?page=2");
      api.get("/admin/suppliers", page([supplier()], { page: 2, total: 75, totalPages: 3 }));
      const { user } = renderUI(<AdminSuppliersView />);
      expect(await screen.findByText("Showing 26–50 of 75")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Previous page" }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/suppliers", { scroll: false });
      await user.click(screen.getByRole("button", { name: "Page 3" }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/suppliers?page=3", { scroll: false });
    });
  });
});
