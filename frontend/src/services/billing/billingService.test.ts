import { afterEach, describe, expect, it } from "vitest";

import { currency, setCurrency } from "@/lib/money";
import { makeBillingConfig } from "@/test/sliceA-fixtures";
import { api } from "@/test/api";

import { getBillingConfig, saveBillingConfig } from "./billingService";

const INR = { code: "INR", symbol: "₹", locale: "en-IN", decimals: 2 };

afterEach(() => {
  setCurrency(INR);
});

describe("getBillingConfig", () => {
  it("GETs the config, adopts its currency for formatMoney, and caches the result for the page", async () => {
    const jpy = { code: "JPY", symbol: "¥", locale: "ja-JP", decimals: 0 };
    api.get("/site/billing-config", makeBillingConfig({ currency: jpy }));
    const result = await getBillingConfig();
    expect(result.currency.code).toBe("JPY");
    expect(currency()).toEqual(jpy);

    const before = api.requests("GET", "/site/billing-config").length;
    await getBillingConfig();
    expect(api.requests("GET", "/site/billing-config")).toHaveLength(before);
  });
});

describe("saveBillingConfig", () => {
  it("PUTs to the admin settings endpoint with admin auth, adopts the currency, and invalidates the cache", async () => {
    window.localStorage.setItem("dcz:admin-token", "adm");
    const gbp = { code: "GBP", symbol: "£", locale: "en-GB", decimals: 2 };
    api.put("/admin/settings/billing", (req) => req.body);
    const next = makeBillingConfig({ currency: gbp });
    const saved = await saveBillingConfig(next);

    expect(saved.currency.code).toBe("GBP");
    expect(currency()).toEqual(gbp);
    expect(api.last()!.headers.authorization).toBe("Bearer adm");

    // Cache invalidated: the next read fetches again rather than reusing
    // whatever an earlier test (or this one's own save) last resolved.
    api.get("/site/billing-config", makeBillingConfig({ currency: gbp }));
    await getBillingConfig();
    expect(api.requests("GET", "/site/billing-config")).toHaveLength(1);
  });
});
