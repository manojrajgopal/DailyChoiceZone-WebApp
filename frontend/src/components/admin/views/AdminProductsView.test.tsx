import { describe, expect, it } from "vitest";

import { api, raw } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { emptyProductDraft } from "@/services/admin/productAdminService";
import { useToastStore } from "@/store/toastStore";
import type { AdminProduct } from "@/types/admin";

import { AdminProductsView } from "./AdminProductsView";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

function product(overrides: Partial<AdminProduct> = {}): AdminProduct {
  return {
    ...emptyProductDraft(),
    id: "P1",
    slug: "linen-shirt",
    name: "Linen shirt",
    brand: "Daily Choice",
    category: "men",
    subcategory: "shirts",
    price: 1299,
    originalPrice: 1599,
    discount: 19,
    stock: 20,
    sku: "DCZ-LS-01",
    status: "active",
    images: [],
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    updatedBy: "A1",
    ...overrides,
  } as AdminProduct;
}

const COUNTS = { all: 57, active: 40, draft: 10, "out-of-stock": 5, archived: 2 };
const FILTERS = {
  categories: [{ value: "men", label: "Men" }, { value: "women", label: "Women" }],
  brands: ["Daily Choice", "Loom"],
};

function serve(items: AdminProduct[] = [product()], pagination: Partial<{ page: number; page_size: number; total: number; total_pages: number }> = {}) {
  api.get("/admin/products", raw(200, {
    success: true,
    data: items,
    pagination: { page: 1, page_size: 25, total: items.length, total_pages: 1, ...pagination },
    counts: COUNTS,
    filters: FILTERS,
  }));
}

async function open(href = "/admin/products", items?: AdminProduct[], pagination?: Parameters<typeof serve>[1]) {
  setLocation(href);
  serve(items, pagination);
  const view = renderUI(<AdminProductsView />);
  await screen.findByRole("link", { name: (items ?? [product()])[0]!.name });
  return view;
}

describe("AdminProductsView", () => {
  it("asks the server for one page and shows status counts and the filter options", async () => {
    signIn("admin", "adm");
    await open();

    const request = api.last("GET", "/admin/products")!;
    expect(request.headers.authorization).toBe("Bearer adm");
    expect(request.query.get("page")).toBe("1");
    expect(request.query.get("pageSize")).toBe("25");
    expect(request.query.get("status")).toBeNull();
    expect(api.requests("GET", "/admin/products")).toHaveLength(1);

    expect(screen.getByRole("tab", { name: "All 57" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Draft 10" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Out of stock 5" })).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Filter by category" })).getByRole("option", { name: "Women" })).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Filter by brand" })).getByRole("option", { name: "Loom" })).toBeInTheDocument();

    const row = screen.getByRole("link", { name: "Linen shirt" }).closest("tr")!;
    expect(within(row).getByText("DCZ-LS-01")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Edit Linen shirt" })).toHaveAttribute("href", "/admin/products/edit?id=P1");
    expect(within(row).getByRole("link", { name: "View Linen shirt on the storefront" })).toHaveAttribute("href", "/product/P1");
  });

  it("sends the Product ID, filters, sort and page from the address bar", async () => {
    await open("/admin/products?q=PRD001&status=draft&category=men&brand=Loom&stock=low-stock&flag=isNew&sort=price-desc&page=2&pageSize=50");
    const query = api.last("GET", "/admin/products")!.query;
    expect(query.get("q")).toBe("PRD001");
    expect(query.get("search")).toBeNull();
    expect(query.get("status")).toBe("draft");
    expect(query.get("category")).toBe("men");
    expect(query.get("brands")).toBe("Loom");
    expect(query.get("stock")).toBe("low-stock");
    expect(query.get("isNew")).toBe("true");
    expect(query.get("sort")).toBe("price-desc");
    expect(query.get("page")).toBe("2");
    expect(query.get("pageSize")).toBe("50");

    expect(screen.getByRole("tab", { name: "Draft 10" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("group", { name: "Filtered by Product ID or SKU PRD001" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Price/ })).toHaveAttribute("aria-sort", "descending");
  });

  it("ignores values the server wouldn't accept", async () => {
    await open("/admin/products?status=bogus&stock=lots&sort=random");
    const query = api.last("GET", "/admin/products")!.query;
    expect(query.get("status")).toBeNull();
    expect(query.get("stock")).toBeNull();
    expect(query.get("sort")).toBeNull();
  });

  it("writes filter changes to the address bar, back on page 1", async () => {
    const { user } = await open("/admin/products?page=3");

    await user.click(screen.getByRole("tab", { name: /^Archived/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?status=archived", { scroll: false });

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by category" }), "women");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?category=women", { scroll: false });

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by stock level" }), "out-of-stock");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?stock=out-of-stock", { scroll: false });

    await user.selectOptions(screen.getByRole("combobox", { name: "Sort products" }), "best-selling");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?sort=best-selling", { scroll: false });

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("filters by a Product ID chosen from the ID suggestions, never by name", async () => {
    api.get("/admin/lookup/product", (req) =>
      req.query.get("q") === "DCZ-LS" ? { items: [{ id: "PRD001", match: "DCZ-LS-01" }], hasMore: false } : { items: [], hasMore: false },
    );
    const { user } = await open();
    const box = screen.getByRole("combobox", { name: "Product ID or SKU" });
    expect(box).toHaveAttribute("placeholder", "Search Product ID…");

    await user.type(box, "DCZ-LS");
    await user.click(await screen.findByRole("option", { name: /PRD001/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?q=PRD001", { scroll: false });
    expect(api.last("GET", "/admin/lookup/product")!.query.get("q")).toBe("DCZ-LS");
  });

  it("removes the Product ID filter from its chip", async () => {
    const { user } = await open("/admin/products?q=PRD001&status=draft");
    await user.click(screen.getByRole("button", { name: "Remove Product ID or SKU filter" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?status=draft", { scroll: false });
  });

  it("sorts on the server from the column headers", async () => {
    const { user } = await open("/admin/products?sort=name-asc");
    expect(screen.getByRole("columnheader", { name: /Product/ })).toHaveAttribute("aria-sort", "ascending");

    await user.click(screen.getByRole("button", { name: "Product" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?sort=name-desc", { scroll: false });

    await user.click(screen.getByRole("button", { name: "Stock" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?sort=stock-asc", { scroll: false });

    await user.click(screen.getByRole("button", { name: "Created" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?sort=oldest", { scroll: false });
  });

  it("pages with the server's totals and changes the page size", async () => {
    const items = Array.from({ length: 3 }, (_, index) => product({ id: `P${index + 1}`, name: `Product ${index + 1}` }));
    const { user } = await open("/admin/products?status=active", items, { total: 75, total_pages: 3 });
    expect(screen.getByText(/1–25\s*of 75/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?status=active&page=2", { scroll: false });

    await user.selectOptions(screen.getByRole("combobox", { name: "Rows per page" }), "100");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products?status=active&pageSize=100", { scroll: false });
  });

  it("clears every filter at once", async () => {
    const { user } = await open("/admin/products?q=PRD001&brand=Loom&sort=newest");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/products", { scroll: false });
  });

  it("says so when nothing matches", async () => {
    setLocation("/admin/products?q=PRD999");
    serve([]);
    renderUI(<AdminProductsView />);
    expect(await screen.findByText("No products match")).toBeInTheDocument();
  });

  it("deletes a product after confirming, then reloads the page", async () => {
    const { user } = await open();
    api.get("/admin/products/P1", product());
    api.delete("/products/P1", null);

    await user.click(screen.getByRole("button", { name: "Delete Linen shirt" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete product?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete product" }));

    await waitFor(() => expect(api.requests("DELETE", "/products/P1")).toHaveLength(1));
    await waitFor(() => expect(toasts()).toContain("success:Linen shirt deleted"));
    await waitFor(() => expect(api.requests("GET", "/admin/products")).toHaveLength(2));
  });

  it("steps back a page when the last row of a later page is deleted", async () => {
    const { user } = await open("/admin/products?page=2", [product()], { page: 2, total: 26, total_pages: 2 });
    api.get("/admin/products/P1", product());
    api.delete("/products/P1", null);

    await user.click(screen.getByRole("button", { name: "Delete Linen shirt" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete product" }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith("/admin/products", { scroll: false }));
  });

  it("duplicates a product as a draft and opens it", async () => {
    const { user } = await open();
    api.get("/admin/products/P1", product());
    api.post("/products", (request) => product({ ...request.body, id: "P9" }));

    await user.click(screen.getByRole("button", { name: "Duplicate Linen shirt" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/products/edit?id=P9"));
    expect(api.last("POST", "/products")!.body.status).toBe("draft");
  });
});
