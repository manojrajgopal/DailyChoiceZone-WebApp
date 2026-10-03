import { describe, expect, it } from "vitest";

import { api } from "@/test/api";

import { clickTracker, productIdFromHref } from "./tracking";

describe("discovery tracking", () => {
  it.each([
    ["/product/PRD012", "PRD012"],
    ["/product/PRD012?color=Navy%20Blue", "PRD012"],
    ["https://shop.example/product/PRD9#reviews", "PRD9"],
    ["/category/women", null],
    [null, null],
  ])("reads the product id from %s", (href, id) => {
    expect(productIdFromHref(href)).toBe(id);
  });

  it("reports a followed product link with its rail", async () => {
    localStorage.setItem("dcz:visitor", "visitor-12345678");
    api.post("/analytics/events", { recorded: true });
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "/product/PRD7");
    const span = document.createElement("span");
    anchor.appendChild(span);

    clickTracker("recommendation_click", "rec:pdp-related")({ target: span } as never);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.last("POST", "/analytics/events")?.body).toMatchObject({
      event: "recommendation_click",
      productId: "PRD7",
      placement: "rec:pdp-related",
    });
  });

  it("ignores clicks that aren't on a product link", () => {
    clickTracker("recently_viewed_click", "recently-viewed:home")({ target: document.createElement("button") } as never);
    expect(api.requests("POST", "/analytics/events")).toHaveLength(0);
  });
});
