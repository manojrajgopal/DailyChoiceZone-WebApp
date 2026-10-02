import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as ops from "./operationsAdminService";

beforeEach(() => {
  setUpAdmin();
});

describe("pincodes", () => {
  it("listPincodes GETs with every filter in the query string", async () => {
    await ops.listPincodes({ q: "600", state: "TN", active: "true", serviceable: "true", cod: "true", page: 2, pageSize: 10 });
    const request = api.last("GET", "/admin/delivery/pincodes")!;
    expect(request.query.get("q")).toBe("600");
    expect(request.query.get("state")).toBe("TN");
    expect(request.query.get("page")).toBe("2");
    expect(request.headers.authorization).toBe("Bearer test-token");
  });

  it("createPincode POSTs the input as the body", async () => {
    const input = { pincode: "600001", city: "Chennai", district: "Chennai", state: "TN", serviceable: true, codAvailable: true, expressAvailable: false, minDays: 2, maxDays: 5, deliveryFee: 0, courier: "BlueDart", notes: "", active: true };
    await ops.createPincode(input);
    expect(api.last("POST", "/admin/delivery/pincodes")!.body).toEqual(input);
  });

  it("updatePincode PUTs to /admin/delivery/pincodes/:id", async () => {
    await ops.updatePincode(7, { pincode: "600002" } as never);
    expect(api.last("PUT", "/admin/delivery/pincodes/7")).toBeTruthy();
  });

  it("deletePincode DELETEs /admin/delivery/pincodes/:id", async () => {
    await ops.deletePincode(7);
    expect(api.last("DELETE", "/admin/delivery/pincodes/7")).toBeTruthy();
  });

  it("importPincodes posts the raw file content", async () => {
    await ops.importPincodes("pincode,city\n600001,Chennai");
    expect(api.last("POST", "/admin/delivery/pincodes/import")!.body).toEqual({ content: "pincode,city\n600001,Chennai" });
  });

  it("exportPincodes / saveDeliverySettings hit their own endpoints", async () => {
    await ops.exportPincodes();
    expect(api.last("GET", "/admin/delivery/pincodes/export")).toBeTruthy();

    await ops.saveDeliverySettings({ restrictToListed: true });
    expect(api.last("PUT", "/admin/delivery/settings")!.body).toEqual({ restrictToListed: true });
  });
});

describe("abandoned carts", () => {
  it("listAbandonedCarts / metrics / settings", async () => {
    await ops.listAbandonedCarts({ status: "abandoned", days: "7" });
    expect(api.last("GET", "/admin/carts/abandoned")!.query.get("status")).toBe("abandoned");

    await ops.abandonedCartMetrics("30");
    expect(api.last("GET", "/admin/carts/abandoned/metrics")!.query.get("days")).toBe("30");

    await ops.getAbandonedCartSettings();
    expect(api.last("GET", "/admin/carts/settings")).toBeTruthy();

    const settings = { enabled: true, abandonAfterMinutes: 60, reminders: [{ afterMinutes: 1440 }], expireAfterDays: 7 };
    await ops.saveAbandonedCartSettings(settings);
    expect(api.last("PUT", "/admin/carts/settings")!.body).toEqual(settings);
  });
});

describe("webhooks", () => {
  it("lists, reads metrics, gets one and replays it", async () => {
    await ops.listWebhookEvents({ status: "failed" });
    expect(api.last("GET", "/admin/payments/webhooks")!.query.get("status")).toBe("failed");

    await ops.webhookMetrics("7");
    expect(api.last("GET", "/admin/payments/webhooks/metrics")).toBeTruthy();

    await ops.getWebhookEvent("evt_1");
    expect(api.last("GET", "/admin/payments/webhooks/evt_1")).toBeTruthy();

    await ops.replayWebhookEvent("evt_1");
    expect(api.last("POST", "/admin/payments/webhooks/evt_1/replay")!.body).toEqual({});
  });

  it("encodes an event id with special characters", async () => {
    await ops.getWebhookEvent("evt/weird id");
    expect(api.last("GET")!.path).toBe("/admin/payments/webhooks/evt%2Fweird%20id");
  });
});

describe("reconciliation", () => {
  it("lists, runs, reads one, rechecks, resolves and reopens", async () => {
    await ops.listReconciliation({ status: "mismatch" });
    expect(api.last("GET", "/admin/payments/reconciliation")!.query.get("status")).toBe("mismatch");

    await ops.runReconciliation("2024-01-01", "2024-01-31");
    expect(api.last("POST", "/admin/payments/reconciliation/run")!.body).toEqual({ from: "2024-01-01", to: "2024-01-31" });

    await ops.getReconciliation(5);
    expect(api.last("GET", "/admin/payments/reconciliation/5")).toBeTruthy();

    await ops.recheckReconciliation(5);
    expect(api.last("POST", "/admin/payments/reconciliation/5/recheck")!.body).toEqual({});

    await ops.resolveReconciliation(5, "Confirmed with bank");
    expect(api.last("POST", "/admin/payments/reconciliation/5/resolve")!.body).toEqual({ note: "Confirmed with bank" });

    await ops.reopenReconciliation(5, "Actually still open");
    expect(api.last("POST", "/admin/payments/reconciliation/5/reopen")!.body).toEqual({ note: "Actually still open" });
  });
});

describe("account security", () => {
  it("reads and saves the settings", async () => {
    await ops.getAccountSecuritySettings();
    expect(api.last("GET", "/admin/auth/accounts/settings")).toBeTruthy();

    const settings = { verificationHours: 24, resetMinutes: 30, requireVerifiedEmailToOrder: true };
    await ops.saveAccountSecuritySettings(settings);
    expect(api.last("PUT", "/admin/auth/accounts/settings")!.body).toEqual(settings);
  });
});
