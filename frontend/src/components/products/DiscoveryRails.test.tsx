import { describe, expect, it } from "vitest";

import { api, fail, ok } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { makeProduct, makeServerCart, signInCustomer } from "@/test/sliceD-cart-fixtures";
import { resetRecordedViews } from "@/hooks/useRecentlyViewed";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";

import { RecentlyViewedRail } from "./RecentlyViewedRail";
import { RecommendationRail } from "./RecommendationRail";

const scarf = makeProduct({ id: "P2", name: "Silk Scarf", sizes: [] });
const shirt = makeProduct({ id: "P3", name: "Oxford Shirt", sizes: ["M", "L"] });

describe("RecommendationRail", () => {
  it("renders the list the page already has, without asking again", () => {
    renderUI(<RecommendationRail productId="P1" type="related" title="You may also like" placement="pdp-related"
      initialProducts={[scarf, shirt]} />);
    expect(screen.getByRole("heading", { name: "You may also like" })).toBeInTheDocument();
    expect(screen.getAllByText("Silk Scarf").length).toBeGreaterThan(0);
    expect(api.requests("GET", /related/)).toHaveLength(0);
  });

  it("asks the server for its type, with skeletons meanwhile", async () => {
    api.get("/products/P1/related", [scarf]);
    renderUI(<RecommendationRail productId="P1" type="frequently-bought-together" title="Frequently bought together"
      placement="pdp-fbt" limit={4} />);
    expect(screen.getByLabelText("Loading frequently bought together")).toHaveAttribute("aria-busy", "true");
    expect((await screen.findAllByText("Silk Scarf")).length).toBeGreaterThan(0);
    const request = api.last("GET", "/products/P1/related")!;
    expect(request.query.get("type")).toBe("frequently-bought-together");
    expect(request.query.get("limit")).toBe("4");
  });

  it("is left out entirely when there's nothing to show, or it can't load", async () => {
    api.get("/products/P1/related", []);
    const { unmount } = renderUI(<RecommendationRail productId="P1" type="similar" title="Similar products" placement="pdp-similar" />);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Similar products" })).not.toBeInTheDocument());
    unmount();
    api.get("/products/P1/related", fail(500));
    renderUI(<RecommendationRail productId="P1" type="similar" title="Similar products" placement="pdp-similar" />);
    await waitFor(() => expect(screen.queryByLabelText(/Loading/)).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Similar products" })).not.toBeInTheDocument();
  });

  it("reports a click on a recommended product, with its rail", async () => {
    localStorage.setItem("dcz:visitor", "visitor-12345678");
    api.post("/analytics/events", { recorded: true });
    const { user } = renderUI(<RecommendationRail productId="P1" type="related" title="Related" placement="pdp-related"
      initialProducts={[scarf]} />);
    await user.click(screen.getAllByRole("link", { name: /Silk Scarf/ })[0]!);
    await waitFor(() => expect(api.last("POST", "/analytics/events")?.body).toMatchObject({
      event: "recommendation_click", productId: "P2", placement: "rec:pdp-related",
    }));
  });

  it("adds to the bag from the rail, crediting the rail", async () => {
    signInCustomer();
    api.post("/cart/items", makeServerCart());
    const { user } = renderUI(<RecommendationRail productId="P1" type="related" title="Related" placement="pdp-related"
      initialProducts={[scarf]} />);
    await waitFor(() => expect(api.requests("GET", "/auth/me").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Add Silk Scarf to bag" }));
    await waitFor(() => expect(api.last("POST", "/cart/items")?.body).toMatchObject({
      productId: "P2", quantity: 1, source: "rec:pdp-related",
    }));
  });

  it("sends a sized product to its page to choose, and says when one is sold out", () => {
    renderUI(<RecommendationRail productId="P1" type="related" title="Related" placement="pdp-related"
      initialProducts={[shirt, makeProduct({ id: "P4", name: "Sold Out Tee", stock: 0 })]} />);
    expect(screen.getByRole("link", { name: "Choose size" })).toHaveAttribute("href", "/product/P3");
    expect(screen.getByText("Out of stock", { selector: "p" })).toBeInTheDocument();
  });
});

describe("RecentlyViewedRail", () => {
  it("shows nothing at all on a first visit", () => {
    renderUI(<RecentlyViewedRail />);
    expect(screen.queryByRole("heading", { name: "Recently viewed" })).not.toBeInTheDocument();
  });

  it("records a guest's view in the browser and lists the others", async () => {
    useRecentlyViewedStore.getState().record("P2");
    api.get("/products/P2", scarf);
    renderUI(<RecentlyViewedRail recordId="P1" excludeId="P1" />);
    expect(await screen.findByRole("heading", { name: "Recently viewed" })).toBeInTheDocument();
    expect(useRecentlyViewedStore.getState().productIds).toEqual(["P1", "P2"]);
    // A guest's history never reaches the server.
    expect(api.requests("POST", "/recently-viewed")).toHaveLength(0);
  });

  it("asks before clearing everything", async () => {
    useRecentlyViewedStore.getState().record("P2");
    api.get("/products/P2", scarf);
    const { user } = renderUI(<RecentlyViewedRail />);
    await user.click(await screen.findByRole("button", { name: "Clear all" }));
    const dialog = screen.getByRole("dialog", { name: "Clear recently viewed?" });
    expect(useRecentlyViewedStore.getState().productIds).toEqual(["P2"]);
    await user.click(within(dialog).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(useRecentlyViewedStore.getState().productIds).toEqual([]));
    expect(screen.queryByRole("heading", { name: "Recently viewed" })).not.toBeInTheDocument();
  });

  it("signed in, records the view on the server once and reads the account's history", async () => {
    resetRecordedViews();
    signInCustomer();
    api.post("/recently-viewed", { recorded: true });
    api.get("/recently-viewed", ok([{ productId: "P2", color: null, size: null, viewedAt: "2026-10-01T10:00:00",
      viewCount: 1, available: true, availability: "in-stock", product: scarf }], { total: 9 }));
    const { rerender } = renderUI(<RecentlyViewedRail recordId="P1" excludeId="P1" />);
    expect(await screen.findByRole("heading", { name: "Recently viewed" })).toBeInTheDocument();
    rerender(<RecentlyViewedRail recordId="P1" excludeId="P1" />);
    await waitFor(() => expect(api.requests("POST", "/recently-viewed")).toHaveLength(1));
    expect(api.last("POST", "/recently-viewed")?.body).toMatchObject({ productId: "P1" });
    expect(api.last("GET", "/recently-viewed")?.query.get("exclude")).toBe("P1");
    // More than the rail shows: a way to see them all.
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/account/recently-viewed");
    expect(useRecentlyViewedStore.getState().productIds).toEqual([]);
  });

  it("signed in, stays out of the way when the history can't be read", async () => {
    resetRecordedViews();
    signInCustomer();
    api.get("/recently-viewed", fail(500));
    renderUI(<RecentlyViewedRail />);
    await waitFor(() => expect(api.requests("GET", "/recently-viewed")).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "Recently viewed" })).not.toBeInTheDocument();
  });
});
