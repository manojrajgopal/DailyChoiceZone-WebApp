import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { useToastStore } from "@/store/toastStore";
import type { SearchAnalytics, SearchSettings } from "@/types/searchAdmin";

import { AdminSearchView } from "./AdminSearchView";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

function analytics(overrides: Partial<SearchAnalytics> = {}): SearchAnalytics {
  return {
    range: "30d",
    from: "2026-09-03",
    to: "2026-10-02",
    totals: {
      searches: 1240, uniqueTerms: 310, zeroResultSearches: 93, zeroResultRate: 7.5,
      clicks: 520, ctr: 38.2, conversions: 41, conversionRate: 3.3,
    },
    topSearches: [{ term: "kurta", searches: 220, clicks: 130, ctr: 51.4, conversions: 12, avgResults: 34.5 }],
    zeroResults: [{ term: "jorts", searches: 14, lastSearchedAt: "2026-10-01" }],
    trending: [
      { term: "raincoat", searches: 60, previous: 20, change: 200 },
      { term: "diwali lamp", searches: 9, previous: 0, change: null },
    ],
    series: [
      { date: "2026-09-30", searches: 40, zeroResults: 3, clicks: 15 },
      { date: "2026-10-01", searches: 52, zeroResults: 4, clicks: 20 },
    ],
    ...overrides,
  };
}

function settings(overrides: Partial<SearchSettings> = {}): SearchSettings {
  return {
    popularMode: "curated",
    popularSearches: ["kurta", "saree"],
    autoPopular: ["shirt", "jeans"],
    synonyms: [["tee", "tshirt"]],
    lastRebuildAt: "2026-10-01T02:00:00Z",
    dictionarySize: 4200,
    ...overrides,
  };
}

describe("AdminSearchView — analytics", () => {
  it("shows totals, top, zero-result and trending searches for the default 30 days", async () => {
    signIn("admin", "adm");
    setLocation("/admin/search");
    api.get("/admin/search/analytics", analytics());
    renderUI(<AdminSearchView />);

    expect(await screen.findByText("1,240")).toBeInTheDocument();
    const request = api.last("GET", "/admin/search/analytics")!;
    expect(request.query.get("range")).toBe("30d");
    expect(request.headers.authorization).toBe("Bearer adm");

    expect(screen.getByText("7.5%")).toBeInTheDocument();
    expect(screen.getByText("93 searches")).toBeInTheDocument();
    expect(screen.getByText("38.2%")).toBeInTheDocument();
    expect(screen.getByText("41 orders")).toBeInTheDocument();

    const kurta = screen.getByText("kurta").closest("tr")!;
    expect(within(kurta).getByText("220")).toBeInTheDocument();
    expect(within(kurta).getByText("51.4%")).toBeInTheDocument();
    expect(within(kurta).getByText("34.5")).toBeInTheDocument();
    expect(screen.getByText("jorts").closest("tr")).toHaveTextContent("14");
    expect(screen.getByText("raincoat").closest("tr")).toHaveTextContent("+200%");
    expect(screen.getByText("diwali lamp").closest("tr")).toHaveTextContent("New");
    expect(screen.getByRole("tab", { name: "Analytics" })).toHaveAttribute("aria-selected", "true");
  });

  it("asks for the range in the address bar and switches it", async () => {
    setLocation("/admin/search?range=7d");
    api.get("/admin/search/analytics", analytics({ range: "7d" }));
    const { user } = renderUI(<AdminSearchView />);
    await screen.findByText("1,240");
    expect(api.last("GET", "/admin/search/analytics")!.query.get("range")).toBe("7d");
    expect(screen.getByRole("tab", { name: "7 days" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "90 days" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/search?range=90d", { scroll: false });
  });

  it("says when nothing has been searched yet", async () => {
    setLocation("/admin/search");
    api.get("/admin/search/analytics", analytics({ topSearches: [], zeroResults: [], trending: [] }));
    renderUI(<AdminSearchView />);
    expect(await screen.findByText("No searches yet")).toBeInTheDocument();
    expect(screen.getByText("Every search found something")).toBeInTheDocument();
    expect(screen.getByText("Nothing trending")).toBeInTheDocument();
  });

  it("explains a role without the search permission", async () => {
    setLocation("/admin/search");
    api.get("/admin/search/analytics", fail(403, "Forbidden", "FORBIDDEN"));
    renderUI(<AdminSearchView />);
    expect(await screen.findByText("Your role doesn't include search")).toBeInTheDocument();
  });

  it("offers a retry when the report fails", async () => {
    setLocation("/admin/search");
    api.get("/admin/search/analytics", fail(500, "Boom"));
    const { user } = renderUI(<AdminSearchView />);
    expect(await screen.findByText("The search analytics didn't load.")).toBeInTheDocument();
    api.get("/admin/search/analytics", analytics());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1,240")).toBeInTheDocument();
  });
});

describe("AdminSearchView — settings", () => {
  async function openSettings(value = settings()) {
    setLocation("/admin/search?tab=settings");
    api.get("/admin/search/settings", value);
    const view = renderUI(<AdminSearchView />);
    await screen.findByRole("button", { name: "Save search settings" });
    return view;
  }

  it("goes to the settings tab through the address bar", async () => {
    setLocation("/admin/search");
    api.get("/admin/search/analytics", analytics());
    const { user } = renderUI(<AdminSearchView />);
    await screen.findByText("1,240");
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/search?tab=settings", { scroll: false });
  });

  it("shows the curated list, synonyms, dictionary size and last rebuild", async () => {
    await openSettings();
    expect(screen.getByRole("radio", { name: /Curated/ })).toBeChecked();
    expect(screen.getByText("kurta")).toBeInTheDocument();
    expect(screen.getByText("saree")).toBeInTheDocument();
    expect(screen.getByLabelText("Synonym group 1")).toHaveValue("tee, tshirt");
    expect(screen.getByText("4,200 words")).toBeInTheDocument();
    expect(screen.queryByText("Never")).not.toBeInTheDocument();
  });

  it("saves the mode, the curated list and the synonym groups", async () => {
    const { user } = await openSettings();
    api.put("/admin/search/settings", (request) => settings(request.body));

    await user.click(screen.getByRole("button", { name: "Remove saree" }));
    await user.type(screen.getByLabelText("Curated popular searches"), "cotton kurta{Enter}");
    await user.click(screen.getByRole("button", { name: "Add synonym group" }));
    await user.type(screen.getByLabelText("Synonym group 2"), "Sofa, couch, settee");
    await user.click(screen.getByRole("radio", { name: /Automatic/ }));
    expect(screen.getByRole("list", { name: "Automatic popular searches" })).toHaveTextContent("shirt");

    await user.click(screen.getByRole("button", { name: "Save search settings" }));
    await waitFor(() => expect(api.last("PUT", "/admin/search/settings")).toBeDefined());
    expect(api.last("PUT", "/admin/search/settings")!.body).toEqual({
      popularMode: "auto",
      popularSearches: ["kurta", "cotton kurta"],
      synonyms: [["tee", "tshirt"], ["sofa", "couch", "settee"]],
    });
    await waitFor(() => expect(toasts()).toContain("success:Search settings saved"));
  });

  it("removes a synonym group and refuses a group of one word", async () => {
    const { user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Remove synonym group 1" }));
    await user.click(screen.getByRole("button", { name: "Add synonym group" }));
    await user.type(screen.getByLabelText("Synonym group 1"), "lonely");
    await user.click(screen.getByRole("button", { name: "Save search settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("“lonely” needs at least one other word");
    expect(api.requests("PUT")).toHaveLength(0);
  });

  it("shows the server's words when the settings are refused", async () => {
    const { user } = await openSettings();
    api.put("/admin/search/settings", fail(422, "At most 20 popular searches.", "INVALID_POPULAR_SEARCHES"));
    await user.click(screen.getByRole("button", { name: "Save search settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("At most 20 popular searches.");
  });

  it("rebuilds the index now and shows the new figures", async () => {
    const { user } = await openSettings(settings({ lastRebuildAt: null }));
    expect(screen.getByText("Never")).toBeInTheDocument();
    api.post("/admin/search/rebuild", { terms: 5100, products: 812, unitsSold: 300 });
    api.get("/admin/search/settings", settings({ dictionarySize: 5100 }));

    await user.click(screen.getByRole("button", { name: "Rebuild now" }));
    await waitFor(() => expect(toasts()).toContain("success:Search index rebuilt: 812 products, 5,100 terms."));
    expect(await screen.findByText("5,100 words")).toBeInTheDocument();
    expect(api.requests("POST", "/admin/search/rebuild")).toHaveLength(1);
  });

  it("explains a role without the search permission", async () => {
    setLocation("/admin/search?tab=settings");
    api.get("/admin/search/settings", fail(403, "Forbidden", "FORBIDDEN"));
    renderUI(<AdminSearchView />);
    expect(await screen.findByText("Your role doesn't include search")).toBeInTheDocument();
  });
});
