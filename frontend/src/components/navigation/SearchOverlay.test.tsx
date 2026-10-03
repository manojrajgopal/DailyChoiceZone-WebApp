import { describe, expect, it, vi } from "vitest";

import type { SearchSuggestions } from "@/types";

import { api, fail, ok } from "@/test/api";
import { router } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { RECENT_SEARCHES_KEY } from "@/lib/search/recent-searches";

import { SearchOverlay } from "./SearchOverlay";

vi.mock("@/hooks/useSiteContent", () => ({ useSiteContent: () => ({ popularSearches: ["fallback term"] }) }));

const EMPTY: SearchSuggestions = {
  query: "",
  correctedTerm: null,
  products: [],
  categories: [],
  brands: [],
  popular: ["steel bottle", "lunch box"],
};

const BOTTLE: SearchSuggestions = {
  ...EMPTY,
  query: "bot",
  products: [
    { id: "PRD007", slug: "steel-bottle", name: "Steel Bottle", brand: "Anvi", image: "", price: 499, originalPrice: 699 },
    { id: "PRD008", slug: "glass-bottle", name: "Glass Bottle", brand: "Meridian", image: "", price: 299, originalPrice: 299 },
  ],
  categories: [{ slug: "kitchen", name: "Kitchen" }],
  brands: [{ value: "Botanica", label: "Botanica" }],
};

function answer(byTerm: Record<string, SearchSuggestions>) {
  api.get("/search/suggest", (request) => ok(byTerm[request.query.get("q") ?? ""] ?? { ...EMPTY, query: request.query.get("q") ?? "" }));
}

function setup() {
  const onOpenChange = vi.fn();
  const utils = renderUI(<SearchOverlay open onOpenChange={onOpenChange} />);
  return { ...utils, onOpenChange, input: screen.getByRole("combobox", { name: /search for products/i }) };
}

describe("SearchOverlay", () => {
  it("is an ARIA combobox controlling a listbox", () => {
    answer({});
    const { input } = setup();
    const listbox = screen.getByRole("listbox", { name: "Search suggestions" });
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-autocomplete", "list");
  });

  it("shows popular searches from the server before anything is typed", async () => {
    answer({ "": EMPTY });
    setup();
    expect(await screen.findByRole("option", { name: "steel bottle" })).toHaveAttribute("href", "/search?q=steel%20bottle");
    expect(screen.getByRole("option", { name: "lunch box" })).toBeInTheDocument();
  });

  it("shows recent searches with a clear button", async () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(["linen shirt", "kurta"]));
    answer({ "": EMPTY });
    const { user } = setup();
    const recent = screen.getByRole("group", { name: /recent searches/i });
    expect(within(recent).getAllByRole("option").map((option) => option.textContent)).toEqual(["linen shirt", "kurta"]);

    await user.click(screen.getByRole("button", { name: "Clear recent searches" }));
    expect(screen.queryByRole("group", { name: /recent searches/i })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
  });

  it("suggests products, categories and brands as you type", async () => {
    answer({ "": EMPTY, bot: BOTTLE });
    const { user, input } = setup();
    await user.type(input, "bot");

    const products = await screen.findByRole("group", { name: "Products" });
    expect(within(products).getByRole("option", { name: /steel bottle/i })).toHaveAttribute("href", "/product/PRD007");
    expect(screen.getByRole("option", { name: "Kitchen" })).toHaveAttribute("href", "/category/kitchen");
    expect(screen.getByRole("option", { name: "Botanica" })).toHaveAttribute("href", "/shop?brand=Botanica");
    expect(screen.getByRole("option", { name: /see all results for “bot”/i })).toHaveAttribute("href", "/search?q=bot");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(api.last("GET", "/search/suggest")!.query.get("q")).toBe("bot");
  });

  it("offers the correction as Did you mean", async () => {
    answer({ "": EMPTY, botle: { ...BOTTLE, query: "botle", correctedTerm: "bottle" } });
    const { user, input } = setup();
    await user.type(input, "botle");
    const option = await screen.findByRole("option", { name: /did you mean “bottle”/i });
    expect(option).toHaveAttribute("href", "/search?q=bottle");
  });

  it("moves through the options with the arrow keys and opens the highlighted one with Enter", async () => {
    answer({ "": EMPTY, bot: BOTTLE });
    const { user, input, onOpenChange } = setup();
    await user.type(input, "bot");
    await screen.findByRole("group", { name: "Products" });

    await user.keyboard("{ArrowDown}");
    const first = screen.getByRole("option", { name: /steel bottle/i });
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    expect(first).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}");
    const second = screen.getByRole("option", { name: /glass bottle/i });
    expect(input).toHaveAttribute("aria-activedescendant", second.id);
    expect(first).toHaveAttribute("aria-selected", "false");

    await user.keyboard("{ArrowUp}{ArrowUp}");
    // Wraps from the first option to the last ("See all results").
    const last = screen.getByRole("option", { name: /see all results/i });
    expect(input).toHaveAttribute("aria-activedescendant", last.id);

    await user.keyboard("{ArrowDown}{Enter}");
    expect(router.push).toHaveBeenLastCalledWith("/product/PRD007");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("searches on Enter with nothing highlighted, and remembers the term", async () => {
    answer({ "": EMPTY, bot: BOTTLE });
    const { user, input } = setup();
    await user.type(input, "  steel bottle {Enter}");
    expect(router.push).toHaveBeenLastCalledWith("/search?q=steel%20bottle");
    expect(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY) ?? "[]")).toEqual(["steel bottle"]);
  });

  it("resets the highlight when the term changes", async () => {
    answer({ "": EMPTY, bot: BOTTLE, bott: BOTTLE });
    const { user, input } = setup();
    await user.type(input, "bot");
    await screen.findByRole("group", { name: "Products" });
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant");
    await user.type(input, "t");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("closes on Escape", async () => {
    answer({ "": EMPTY });
    const { user, input, onOpenChange } = setup();
    input.focus();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says when nothing matches", async () => {
    answer({ "": EMPTY });
    const { user, input } = setup();
    await user.type(input, "zzzz");
    expect(await screen.findByText(/no matches for “zzzz”/i)).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "false"));
  });

  it("does not break when the suggestion request fails", async () => {
    api.get("/search/suggest", (request) => (request.query.get("q") ? fail(500) : ok(EMPTY)));
    const { user, input } = setup();
    await user.type(input, "bot");
    expect(await screen.findByText(/no matches for “bot”/i)).toBeInTheDocument();
  });
});
