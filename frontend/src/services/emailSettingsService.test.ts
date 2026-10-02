import { describe, expect, it } from "vitest";

import { api, fail, ok } from "@/test/api";

import type { EmailType } from "./emailSettingsService";
import {
  disconnectEmailAccount,
  getEmailLog,
  getEmailPreferences,
  getEmailSettings,
  saveEmailAccount,
  saveEmailPreferences,
  saveEmailTypes,
  searchEmailLog,
  sendInvoiceEmail,
  sendTestEmail,
  startGoogleConnect,
} from "./emailSettingsService";

describe("getEmailSettings", () => {
  it("GETs the admin email settings with admin auth", async () => {
    window.localStorage.setItem("dcz:admin-token", "adm");
    api.get("/admin/email", { account: { configured: false, redirectUri: "", providers: [] }, types: [] });
    await getEmailSettings();
    expect(api.last()!.headers.authorization).toBe("Bearer adm");
  });
});

describe("saveEmailAccount", () => {
  it("POSTs the account input and returns the account plus sentTo", async () => {
    api.post("/admin/email/account", (req) => ({ account: req.body, sentTo: "test@x.com" }));
    const input = {
      provider: "smtp" as const,
      senderEmail: "a@b.com",
      senderName: "Store",
      replyTo: "a@b.com",
      testRecipient: "test@x.com",
      clientId: "",
      clientSecret: "",
      refreshToken: "",
      accessToken: "",
      host: "smtp.example.com",
      port: "587",
      security: "starttls" as const,
      username: "user",
      password: "pass",
    };
    const result = await saveEmailAccount(input);
    expect(result.sentTo).toBe("test@x.com");
    expect(api.last()!.body).toMatchObject({ host: "smtp.example.com" });
  });

  it("propagates a failed test send (422) without a generic fallback", async () => {
    api.post("/admin/email/account", fail(422, "The test email could not be sent."));
    await expect(saveEmailAccount({} as never)).rejects.toMatchObject({ status: 422 });
  });
});

describe("sendTestEmail / disconnectEmailAccount", () => {
  it("POSTs the recipient", async () => {
    api.post("/admin/email/test", {});
    await sendTestEmail("a@b.com");
    expect(api.last()!.body).toEqual({ recipient: "a@b.com" });
  });

  it("DELETEs the saved account", async () => {
    api.delete("/admin/email/account", {});
    await expect(disconnectEmailAccount()).resolves.toBeUndefined();
    expect(api.requests("DELETE", "/admin/email/account")).toHaveLength(1);
  });
});

describe("saveEmailTypes", () => {
  it("PUTs only key/enabled/customerCanOptOut per type", async () => {
    api.put("/admin/email/types", (req) => req.body);
    const types: EmailType[] = [{ key: "order", label: "Order emails", description: "d", enabled: true, customerCanOptOut: false }];
    await saveEmailTypes(types);
    expect(api.last()!.body).toEqual([{ key: "order", enabled: true, customerCanOptOut: false }]);
  });
});

describe("getEmailLog", () => {
  it("GETs without a limit by default", async () => {
    api.get("/admin/email/log", ok([]));
    await getEmailLog();
    expect(api.last()!.url).not.toContain("?");
  });

  it("appends a limit when given", async () => {
    api.get(/\/admin\/email\/log/, ok([]));
    await getEmailLog(50);
    expect(api.last()!.url).toContain("limit=50");
  });
});

describe("searchEmailLog", () => {
  it("builds a query string from only the set filters", async () => {
    api.get(/\/admin\/email\/log\/search/, ok({ items: [], pagination: {}, counts: {}, types: [] }));
    await searchEmailLog({ status: "failed", type: "order", q: "", from: undefined, page: 2 });
    const request = api.last()!;
    expect(request.query.get("status")).toBe("failed");
    expect(request.query.get("type")).toBe("order");
    expect(request.query.has("q")).toBe(false);
    expect(request.query.has("from")).toBe(false);
    expect(request.query.get("page")).toBe("2");
  });

  it("GETs with no query string when every filter is empty", async () => {
    api.get(/\/admin\/email\/log\/search/, ok({}));
    await searchEmailLog({});
    expect(api.last()!.url).not.toContain("?");
  });
});

describe("startGoogleConnect", () => {
  it("POSTs and returns the authorization URL", async () => {
    api.post("/admin/email/google/start", { authorizationUrl: "https://accounts.google.com/x", redirectUri: "https://dcz.example/callback" });
    const result = await startGoogleConnect({ clientId: "id", clientSecret: "", senderEmail: "a@b.com", senderName: "Store", replyTo: "a@b.com", testRecipient: "t@b.com" });
    expect(result.authorizationUrl).toContain("google.com");
  });
});

describe("sendInvoiceEmail", () => {
  it("POSTs to the invoice's send endpoint", async () => {
    api.post("/admin/billing/invoices/INV1/send", {});
    await sendInvoiceEmail("INV1");
    expect(api.requests("POST", "/admin/billing/invoices/INV1/send")).toHaveLength(1);
  });
});

describe("customer email preferences", () => {
  it("GETs preferences with customer auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/account/email-preferences", ok([]));
    await getEmailPreferences();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("PUTs the chosen preferences", async () => {
    api.put("/account/email-preferences", (req) => req.body);
    await saveEmailPreferences({ marketing: false, orders: true });
    expect(api.last()!.body).toEqual({ marketing: false, orders: true });
  });
});
