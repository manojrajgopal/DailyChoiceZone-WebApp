import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as messaging from "./messagingAdminService";

beforeEach(() => {
  setUpAdmin();
});

describe("CHANNEL_LABELS", () => {
  it("names every channel", () => {
    expect(messaging.CHANNEL_LABELS).toEqual({ email: "Email", sms: "SMS", whatsapp: "WhatsApp", in_app: "In-app" });
  });
});

describe("notifications", () => {
  it("getNotificationOverview GETs /admin/messaging/overview", async () => {
    await messaging.getNotificationOverview();
    expect(api.last("GET", "/admin/messaging/overview")!.headers.authorization).toBe("Bearer test-token");
  });

  it("listDeliveries spreads every filter into the query string", async () => {
    await messaging.listDeliveries({ channel: "email", status: "failed", q: "order1", page: 2 });
    const request = api.last("GET", "/admin/messaging")!;
    expect(request.query.get("channel")).toBe("email");
    expect(request.query.get("status")).toBe("failed");
    expect(request.query.get("page")).toBe("2");
  });

  it("getDelivery / retryDelivery / saveChannelRouting", async () => {
    await messaging.getDelivery(42);
    expect(api.last("GET", "/admin/messaging/42")).toBeTruthy();

    await messaging.retryDelivery(42);
    expect(api.last("POST", "/admin/messaging/42/retry")!.body).toEqual({});

    const routing = { sms: { enabled: true, events: ["order.shipped"] }, whatsapp: { enabled: false, events: [] } };
    await messaging.saveChannelRouting(routing);
    expect(api.last("PUT", "/admin/messaging/channels")!.body).toEqual(routing);
  });
});

describe("templates", () => {
  it("lists, saves, resets, previews and tests a template", async () => {
    await messaging.listTemplates();
    expect(api.last("GET", "/admin/messaging/templates")).toBeTruthy();

    await messaging.saveTemplate("order.shipped", { subject: "Shipped!" });
    expect(api.last("PUT", "/admin/messaging/templates/order.shipped")!.body).toEqual({ subject: "Shipped!" });

    await messaging.resetTemplate("order.shipped");
    expect(api.last("POST", "/admin/messaging/templates/order.shipped/reset")!.body).toEqual({});

    await messaging.previewTemplate("order.shipped", { subject: "Draft" });
    expect(api.last("POST", "/admin/messaging/templates/order.shipped/preview")!.body).toEqual({ subject: "Draft" });

    await messaging.previewTemplate("order.shipped");
    expect(api.last("POST", "/admin/messaging/templates/order.shipped/preview")!.body).toEqual({});

    await messaging.testTemplate("order.shipped", "email", "a@b.com");
    expect(api.last("POST", "/admin/messaging/templates/order.shipped/test")!.body).toEqual({ channel: "email", recipient: "a@b.com" });
  });
});

describe("campaigns", () => {
  it("covers the full campaign lifecycle of calls", async () => {
    await messaging.listCampaigns({ status: "draft" });
    expect(api.last("GET", "/admin/campaigns")!.query.get("status")).toBe("draft");

    await messaging.getCampaignOptions();
    expect(api.last("GET", "/admin/campaigns/options")).toBeTruthy();

    const audience = { segment: "all" as const };
    await messaging.estimateAudience(audience, ["email"]);
    expect(api.last("POST", "/admin/campaigns/estimate")!.body).toEqual({ audience, channels: ["email"] });

    await messaging.getCampaign(1);
    expect(api.last("GET", "/admin/campaigns/1")).toBeTruthy();

    const input = { name: "Sale", description: "", kind: "promo", channels: ["email" as const], audience, content: {} as never, couponCode: "", startsAt: null, endsAt: null };
    await messaging.createCampaign(input);
    expect(api.last("POST", "/admin/campaigns")!.body).toEqual(input);

    await messaging.updateCampaign(1, input);
    expect(api.last("PUT", "/admin/campaigns/1")!.body).toEqual(input);

    await messaging.deleteCampaign(1);
    expect(api.last("DELETE", "/admin/campaigns/1")).toBeTruthy();

    await messaging.duplicateCampaign(1);
    expect(api.last("POST", "/admin/campaigns/1/duplicate")!.body).toEqual({});

    await messaging.previewCampaign(1);
    expect(api.last("GET", "/admin/campaigns/1/preview")).toBeTruthy();

    await messaging.testCampaign(1, "a@b.com", "9999999999");
    expect(api.last("POST", "/admin/campaigns/1/test")!.body).toEqual({ email: "a@b.com", phone: "9999999999" });

    await messaging.launchCampaign(1, 500, "2024-02-01T00:00:00Z");
    expect(api.last("POST", "/admin/campaigns/1/launch")!.body).toEqual({ confirmMessages: 500, sendAt: "2024-02-01T00:00:00Z" });

    await messaging.cancelCampaign(1);
    expect(api.last("POST", "/admin/campaigns/1/cancel")!.body).toEqual({});

    await messaging.listRecipients(1, { channel: "email", page: 2 });
    expect(api.last("GET", "/admin/campaigns/1/recipients")!.query.get("channel")).toBe("email");
  });
});

describe("backups", () => {
  it("lists, saves settings, runs one, and requests a download link", async () => {
    await messaging.getBackups({ status: "succeeded", page: 1 });
    expect(api.last("GET", "/admin/backups")!.query.get("status")).toBe("succeeded");

    const settings = { enabled: true, frequency: "daily" as const, hour: 2, weekday: 0, keepDailyDays: 7, keepWeeklyWeeks: 4, keepManual: 3 };
    await messaging.saveBackupSettings(settings);
    expect(api.last("PUT", "/admin/backups/settings")!.body).toEqual(settings);

    await messaging.runBackup();
    expect(api.last("POST", "/admin/backups/run")!.body).toEqual({});

    await messaging.backupDownloadLink(9);
    expect(api.last("POST", "/admin/backups/9/download")!.body).toEqual({});
  });
});
