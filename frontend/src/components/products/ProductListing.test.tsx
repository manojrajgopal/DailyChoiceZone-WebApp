import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeProduct } from "@/test/sliceA-fixtures";
import { makeFacets } from "@/test/search-fixtures";
import { api, ok, raw } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";

import { ProductListing } from "./ProductListing";

const content = vi.hoisted(() => ({
  value: {
    ratingFilters: [4],
    discountFilters: [10],
    popularSearches: [],
    sortOptions: [{ value: "newest", label: "Just in" }],
  } as unknown,
}));
vi.mock("@/hooks/useSiteContent", () => ({ useSiteContent: () => content.value }));

const PRODUCTS = [
  makeProduct({ id: "PRD001", slug: "one", name: "Steel Bottle" }),
  makeProduct({ id: "PRD002", slug: "two", name: "Glass Bottle" }),
  makeProduct({ id: "PRD003", slug: "three", name: "Lunch Box" }),
];

function listing(
  items = PRODUCTS,
  { page = 1, pageSize = 24, total = items.length, search }: { page?: number; pageSize?: number; total?: number; search?: unknown } = {},
) {
  return raw(200, {
    success: true,
    data: items,
    pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
    ...(search ? { search } : {}),
  });
}

/** Stop real navigation when a product link is followed: only the tracking matters here. */
function preventNavigation(event: Event) {
  event.preventDefault();
}

describe("ProductListing", () => {
  beforeEach(() => {
    window.addEventListener("click", preventNavigation, true);
  });
  afterEach(() => {
    window.removeEventListener("click", preventNavigation, true);
  });

  it("sends the full URL query to the listing and to the facets", async () => {
    setLocation("/shop?category=kitchen,home&attr.material=steel&attr.capacity.min=500&availability=in-stock&sort=newest");
    api.get("/products", listing());
    api.get("/products/facets", ok(makeFacets()));
    renderUI(<ProductListing basePath="/shop" />);

    await screen.findByText("Steel Bottle");
    const products = api.last("GET", "/products")!.query;
    expect(products.get("category")).toBe("kitchen,home");
    expect(products.get("attr.material")).toBe("steel");
    expect(products.get("attr.capacity.min")).toBe("500");
    expect(products.get("availability")).toBe("in-stock");
    expect(products.get("sort")).toBe("newest");

    const facets = api.last("GET", "/products/facets")!.query;
    expect(facets.get("category")).toBe("kitchen,home");
    expect(facets.get("attr.material")).toBe("steel");
    expect(facets.get("availability")).toBe("in-stock");
    expect(facets.has("sort")).toBe(false);
    expect(facets.has("page")).toBe(false);
  });

  it("merges a route-locked category into the facet request", async () => {
    setLocation("/category/kitchen?brand=Anvi");
    api.get("/products", listing());
    api.get("/products/facets", ok(makeFacets()));
    renderUI(<ProductListing basePath="/category/kitchen" locked={{ category: ["kitchen"] }} showCategoryFilter={false} />);
    await screen.findByText("Steel Bottle");
    const facets = api.last("GET", "/products/facets")!.query;
    expect(facets.get("category")).toBe("kitchen");
    expect(facets.get("brands")).toBe("Anvi");
  });

  it("offers the API's sorts without relevance when browsing, with the store's labels", async () => {
    setLocation("/shop");
    api.get("/products", listing());
    api.get("/products/facets", ok(makeFacets()));
    renderUI(<ProductListing basePath="/shop" />);
    const select = await screen.findByRole("combobox", { name: "Sort products" });
    const values = within(select).getAllByRole("option").map((option) => (option as HTMLOptionElement).value);
    expect(values).not.toContain("relevance");
    expect(values).toEqual(expect.arrayContaining(["recommended", "oldest", "best-selling", "availability"]));
    expect(select).toHaveValue("recommended");
    expect(within(select).getByRole("option", { name: "Just in" })).toBeInTheDocument();
  });

  it("defaults to relevance with a search term, and a new sort is pushed", async () => {
    setLocation("/search?q=bottle");
    api.get("/products", listing());
    api.get("/products/facets", ok(makeFacets()));
    const { user } = renderUI(<ProductListing basePath="/search" locked={{ query: "bottle" }} />);
    const select = await screen.findByRole("combobox", { name: "Sort products" });
    expect(select).toHaveValue("relevance");
    await user.selectOptions(select, "price-asc");
    expect(router.push).toHaveBeenLastCalledWith("/search?q=bottle&sort=price-asc", { scroll: false });
  });

  it("pushes a desktop filter change straight to the URL", async () => {
    setLocation("/shop");
    api.get("/products", listing());
    api.get("/products/facets", ok(makeFacets()));
    const { user } = renderUI(<ProductListing basePath="/shop" />);
    const rail = await screen.findByRole("complementary", { name: "Filters" });
    await user.click(await within(rail).findByRole("checkbox", { name: /kitchen/i }));
    expect(router.push).toHaveBeenLastCalledWith("/shop?category=kitchen", { scroll: false });
  });

  it("stages mobile drawer changes in a draft, with its own counts, and applies them in one go", async () => {
    setLocation("/shop");
    api.get("/products", listing());
    api.get("/products/facets", (request) =>
      ok(request.query.get("availability") === "out-of-stock"
        ? makeFacets({ availability: { inStock: 35, outOfStock: 6 } })
        : makeFacets()),
    );
    const { user } = renderUI(<ProductListing basePath="/shop" />);
    await screen.findByText("Steel Bottle");

    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("button", { name: "Show 3 results" })).toBeInTheDocument();

    await user.click(within(drawer).getByRole("checkbox", { name: /out of stock/i }));
    expect(router.push).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(api.requests("GET", "/products/facets").some((r) => r.query.get("availability") === "out-of-stock")).toBe(true),
    );
    const apply = await within(drawer).findByRole("button", { name: "Show 6 results" });
    await user.click(apply);
    expect(router.push).toHaveBeenLastCalledWith("/shop?availability=out-of-stock", { scroll: false });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("clears the draft with Clear all and discards it when the drawer is closed", async () => {
    setLocation("/shop?brand=Anvi");
    api.get("/products", listing());
    api.get("/products/facets", ok(makeFacets()));
    const { user } = renderUI(<ProductListing basePath="/shop" />);
    await screen.findByText("Steel Bottle");

    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("checkbox", { name: /anvi/i })).toBeChecked();
    await user.click(within(drawer).getByRole("button", { name: "Clear all" }));
    expect(within(drawer).getByRole("checkbox", { name: /anvi/i })).not.toBeChecked();
    expect(router.push).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(router.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByRole("checkbox", { name: /anvi/i })).toBeChecked();
  });

  it("removes a filter from its chip", async () => {
    setLocation("/shop?attr.material=steel");
    api.get("/products", listing());
    api.get("/products/facets", ok(makeFacets()));
    const { user } = renderUI(<ProductListing basePath="/shop" />);
    await user.click(await screen.findByRole("button", { name: "Remove filter: Material: Steel" }));
    expect(router.push).toHaveBeenLastCalledWith("/shop", { scroll: false });
  });

  it("shows the typo correction banner from the search meta", async () => {
    setLocation("/search?q=stel botle");
    api.get("/products", listing(PRODUCTS, { search: { term: "stel botle", correctedTerm: "steel bottle", searchId: 9 } }));
    api.get("/products/facets", ok(makeFacets()));
    renderUI(<ProductListing basePath="/search" locked={{ query: "stel botle" }} />);
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Showing results for steel bottle");
    expect(banner).toHaveTextContent("You searched for “stel botle”");
    expect(within(banner).getByRole("link", { name: "steel bottle" })).toHaveAttribute("href", "/search?q=steel%20bottle");
  });

  it("records a search result click with its 1-based position over the whole list", async () => {
    setLocation("/search?q=bottle&page=2&pageSize=2");
    api.get("/products", listing(PRODUCTS.slice(0, 2), { page: 2, pageSize: 2, total: 5, search: { term: "bottle", correctedTerm: null, searchId: 812 } }));
    api.get("/products/facets", ok(makeFacets()));
    api.post("/search/click", ok({ recorded: true }));
    const { user } = renderUI(<ProductListing basePath="/search" locked={{ query: "bottle" }} />);

    const card = (await screen.findAllByRole("link", { name: /glass bottle/i }))[0]!;
    await user.click(card);
    await waitFor(() => expect(api.last("POST", "/search/click")).toBeDefined());
    expect(api.last("POST", "/search/click")!.body).toMatchObject({ searchId: 812, productId: "PRD002", position: 4 });
  });

  it("records nothing outside a search", async () => {
    setLocation("/shop");
    api.get("/products", listing());
    api.get("/products/facets", ok(makeFacets()));
    const { user } = renderUI(<ProductListing basePath="/shop" />);
    await user.click((await screen.findAllByRole("link", { name: /steel bottle/i }))[0]!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.requests("POST", "/search/click")).toHaveLength(0);
  });

  it("renders the extra empty-state content when nothing matches", async () => {
    setLocation("/search?q=zzz");
    api.get("/products", listing([], { search: { term: "zzz", correctedTerm: null, searchId: 3 } }));
    api.get("/products/facets", ok(makeFacets()));
    renderUI(
      <ProductListing basePath="/search" locked={{ query: "zzz" }} emptyTitle="No results" emptyExtra={<p>Try these</p>} />,
    );
    expect(await screen.findByText("No results")).toBeInTheDocument();
    expect(screen.getByText("Try these")).toBeInTheDocument();
  });
});
