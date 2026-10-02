import { describe, expect, it } from "vitest";

import { api, ok } from "@/test/api";

import {
  COMPARE_LIMIT,
  addToCompare,
  askQuestion,
  clearCompare,
  fetchCompareIds,
  fetchCompareProducts,
  getMyAlerts,
  getMyQuestions,
  getProductAlerts,
  getQuestions,
  mergeCompare,
  removeFromCompare,
  stopAlert,
  watchPrice,
  watchStock,
} from "./engagementService";

describe("alerts", () => {
  it("getMyAlerts GETs /alerts with customer auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/alerts", { stock: [], price: [] });
    await getMyAlerts();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("getProductAlerts GETs the product's alerts", async () => {
    api.get("/alerts/products/P1", { stock: [], price: null });
    const result = await getProductAlerts("P1");
    expect(result.price).toBeNull();
  });

  it("watchStock POSTs the product and variant, defaulting blank variant fields", async () => {
    api.post("/alerts/stock", (req) => ({ ...(req.body as object), id: 1, kind: "stock", status: "active", createdAt: "", notifiedAt: null, alreadySubscribed: false }));
    await watchStock("P1");
    expect(api.last()!.body).toEqual({ productId: "P1", size: "", color: "" });
    await watchStock("P1", "M", "Red");
    expect(api.last()!.body).toEqual({ productId: "P1", size: "M", color: "Red" });
  });

  it("watchPrice POSTs mode 'any' without a target price", async () => {
    api.post("/alerts/price", (req) => req.body);
    await watchPrice("P1", "any", 999);
    expect(api.last()!.body).toEqual({ productId: "P1", mode: "any", targetPrice: null });
  });

  it("watchPrice POSTs a target price in 'target' mode", async () => {
    api.post("/alerts/price", (req) => req.body);
    await watchPrice("P1", "target", 499);
    expect(api.last()!.body).toEqual({ productId: "P1", mode: "target", targetPrice: 499 });
  });

  it("stopAlert DELETEs the alert by kind and id", async () => {
    api.delete("/alerts/stock/5", {});
    await stopAlert("stock", 5);
    expect(api.requests("DELETE", "/alerts/stock/5")).toHaveLength(1);
  });
});

describe("comparison", () => {
  it("COMPARE_LIMIT is 4", () => {
    expect(COMPARE_LIMIT).toBe(4);
  });

  it("fetchCompareIds / fetchCompareProducts GET with auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/compare/ids", { productIds: ["P1"], limit: 4 });
    api.get("/compare", { items: [], limit: 4 });
    await fetchCompareIds();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
    await fetchCompareProducts();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("addToCompare includes a replace query param only when given", async () => {
    api.post(/\/compare\/P1/, { productIds: ["P1"] });
    await addToCompare("P1");
    expect(api.last()!.url).not.toContain("replace");
    await addToCompare("P1", "P0");
    expect(api.last()!.url).toContain("replace=P0");
  });

  it("removeFromCompare / clearCompare / mergeCompare", async () => {
    api.delete("/compare/P1", { productIds: [] });
    await removeFromCompare("P1");
    expect(api.requests("DELETE", "/compare/P1")).toHaveLength(1);

    api.delete("/compare", { productIds: [] });
    await clearCompare();
    expect(api.requests("DELETE", "/compare")).toHaveLength(1);

    api.post("/compare/merge", (req) => req.body);
    await mergeCompare(["P1", "P2"]);
    expect(api.last()!.body).toEqual({ productIds: ["P1", "P2"] });
  });
});

describe("product questions", () => {
  it("getQuestions GETs with default page/pageSize", async () => {
    api.get(/\/products\/P1\/questions/, ok({ items: [], pagination: {}, answered: 0 }));
    await getQuestions("P1");
    const request = api.last()!;
    expect(request.query.get("page")).toBe("1");
    expect(request.query.get("pageSize")).toBe("5");
  });

  it("getQuestions honours a custom page/pageSize", async () => {
    api.get(/\/products\/P1\/questions/, ok({ items: [], pagination: {}, answered: 0 }));
    await getQuestions("P1", 3, 10);
    const request = api.last()!;
    expect(request.query.get("page")).toBe("3");
    expect(request.query.get("pageSize")).toBe("10");
  });

  it("getMyQuestions GETs the signed-in shopper's own questions", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/products/P1/questions/mine", ok([]));
    await getMyQuestions("P1");
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("askQuestion POSTs the question with blank size/color defaults", async () => {
    api.post("/products/P1/questions", (req) => ({ id: 1, ...(req.body as object), author: "me", askedAt: "", answer: null }));
    await askQuestion("P1", "Does this run small?");
    expect(api.last()!.body).toEqual({ question: "Does this run small?", size: "", color: "" });
  });
});
