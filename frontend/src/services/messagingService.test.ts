import { describe, expect, it } from "vitest";

import { api, ok } from "@/test/api";

import {
  followCampaignLink,
  getChannelPreferences,
  getReorderable,
  reorder,
  saveChannelPreferences,
  unsubscribe,
} from "./messagingService";

describe("reorder", () => {
  it("getReorderable GETs the order's reorderable lines with customer auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/orders/O1/reorder", { orderId: "O1", orderNumber: "N1", placedAt: "", items: [], addable: 0, unavailable: 0 });
    await getReorderable("O1");
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("reorder POSTs with no body when no keys are given", async () => {
    api.post("/orders/O1/reorder", (req) => ({ added: [], skipped: [], message: "", units: 0, echo: req.body }));
    await reorder("O1");
    expect(api.last()!.body).toEqual({});
  });

  it("reorder POSTs the chosen keys", async () => {
    api.post("/orders/O1/reorder", { added: [], skipped: [], message: "", units: 0 });
    await reorder("O1", ["item-1", "item-2"]);
    expect(api.last()!.body).toEqual({ keys: ["item-1", "item-2"] });
  });
});

describe("notification preferences", () => {
  it("getChannelPreferences GETs with customer auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/account/notification-preferences", { phone: "999", phoneUsable: true, choices: [] });
    await getChannelPreferences();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("saveChannelPreferences PUTs the chosen channel settings", async () => {
    api.put("/account/notification-preferences", (req) => ({ phone: "", phoneUsable: true, choices: req.body }));
    const choices = [{ channel: "email" as const, category: "marketing" as const, enabled: false }];
    await saveChannelPreferences(choices);
    expect(api.last()!.body).toEqual(choices);
  });
});

describe("links in messages", () => {
  it("unsubscribe POSTs the token without auth", async () => {
    api.post("/notifications/unsubscribe", ok({ channel: "email", unsubscribed: true }));
    const result = await unsubscribe("tok-123");
    expect(result.unsubscribed).toBe(true);
    expect(api.last()!.body).toEqual({ token: "tok-123" });
    expect(api.last()!.headers.authorization).toBeUndefined();
  });

  it("followCampaignLink POSTs the token, destination and signature", async () => {
    api.post("/campaigns/click", { url: "https://dcz.example/product/P1" });
    const result = await followCampaignLink("tok", "/product/P1", "sig123");
    expect(result.url).toBe("https://dcz.example/product/P1");
    expect(api.last()!.body).toEqual({ token: "tok", to: "/product/P1", s: "sig123" });
  });
});
