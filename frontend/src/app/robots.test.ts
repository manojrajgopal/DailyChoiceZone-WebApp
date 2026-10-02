import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { siteConfig } from "@/test/sliceE-fixtures";

import robots, { dynamic } from "./robots";

describe("robots", () => {
  it("is rendered per request, because the site URL is an admin setting", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("allows the shop, disallows private areas and points at the sitemap on the configured URL", async () => {
    api.get("/site/config", siteConfig({ url: "https://shop.example" }));
    const result = await robots();
    expect(result.sitemap).toBe("https://shop.example/sitemap.xml");
    expect(result.rules).toEqual([
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/cart", "/checkout", "/account", "/order-success", "/search"],
      },
    ]);
    expect(api.requests("GET", "/site/config")).toHaveLength(1);
  });

  it("fails when the site configuration cannot be read", async () => {
    api.get("/site/config", fail(500, "Down"));
    await expect(robots()).rejects.toMatchObject({ status: 500 });
  });
});
