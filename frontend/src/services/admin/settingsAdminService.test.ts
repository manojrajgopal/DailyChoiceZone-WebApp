import { beforeEach, describe, expect, it } from "vitest";

import type { AdminUser, StoreSettings } from "@/types/admin";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as settings from "./settingsAdminService";

function storeSettings(overrides: Partial<StoreSettings> = {}): StoreSettings {
  return {
    general: { storeName: "Daily Choice Zone", tagline: "", description: "", logoUrl: "" },
    contact: { email: "support@dcz.test", phone: "1", supportHours: "", addressLine: "", city: "", state: "", pincode: "", country: "" },
    currency: { code: "INR", symbol: "₹", locale: "en-IN" },
    shipping: { freeDeliveryThreshold: 999, standardFee: 49, expressFee: 99, standardEstimate: "", expressEstimate: "" },
    tax: { enabled: true, ratePercent: 5, pricesIncludeTax: true, gstin: "" },
    notifications: { orderConfirmation: true, shippingUpdates: true, lowStockAlerts: true, reviewAlerts: true, marketingEmails: false },
    social: { instagram: "", facebook: "", youtube: "" },
    returns: { windowDays: 7, policyNote: "" },
    ...overrides,
  } as StoreSettings;
}

function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return { id: "", name: "New Admin", email: "new@x.com", role: "editor", status: "active", lastLoginAt: null, createdAt: "2024-01-01", avatarInitials: "", ...overrides };
}

beforeEach(() => {
  setUpAdmin();
});

describe("getSettings / saveSettings", () => {
  it("GETs /admin/settings/store", async () => {
    await settings.getSettings();
    expect(api.last("GET", "/admin/settings/store")!.headers.authorization).toBe("Bearer test-token");
  });

  it("refuses a store name shorter than 2 characters", async () => {
    const result = await settings.saveSettings(storeSettings({ general: { storeName: "A", tagline: "", description: "", logoUrl: "" } }));
    expect(result).toEqual({ ok: false, reason: "Enter a store name." });
  });

  it("refuses an invalid support email", async () => {
    const result = await settings.saveSettings(storeSettings({ contact: { email: "not-an-email", phone: "1", supportHours: "", addressLine: "", city: "", state: "", pincode: "", country: "" } }));
    expect(result).toEqual({ ok: false, reason: "Enter a valid support email address." });
  });

  it("refuses negative delivery charges", async () => {
    const result = await settings.saveSettings(storeSettings({ shipping: { freeDeliveryThreshold: -1, standardFee: 49, expressFee: 99, standardEstimate: "", expressEstimate: "" } }));
    expect(result).toEqual({ ok: false, reason: "Delivery charges cannot be negative." });
  });

  it("refuses a tax rate outside 0-28 while tax is enabled", async () => {
    const result = await settings.saveSettings(storeSettings({ tax: { enabled: true, ratePercent: 30, pricesIncludeTax: true, gstin: "" } }));
    expect(result).toEqual({ ok: false, reason: "Enter a tax rate between 0 and 28 percent." });
  });

  it("ignores the tax rate bound while tax is disabled", async () => {
    api.put("/admin/settings/store", {});
    const result = await settings.saveSettings(storeSettings({ tax: { enabled: false, ratePercent: 99, pricesIncludeTax: true, gstin: "" } }));
    expect(result.ok).toBe(true);
  });

  it("saves valid settings", async () => {
    const valid = storeSettings();
    api.put("/admin/settings/store", valid);
    const result = await settings.saveSettings(valid);
    expect(result).toEqual({ ok: true, data: valid });
    expect(api.last("PUT", "/admin/settings/store")!.body).toEqual(valid);
  });
});

describe("listAdminUsers", () => {
  it("GETs /admin/users", async () => {
    api.get("/admin/users", []);
    await settings.listAdminUsers();
    expect(api.last("GET", "/admin/users")).toBeTruthy();
  });
});

describe("saveAdminUser", () => {
  beforeEach(() => {
    api.get("/admin/users", []);
  });

  it("refuses a name shorter than 2 characters", async () => {
    const result = await settings.saveAdminUser(adminUser({ name: "A" }), "password123");
    expect(result).toEqual({ ok: false, reason: "Enter a name." });
  });

  it("refuses an invalid email", async () => {
    const result = await settings.saveAdminUser(adminUser({ email: "nope" }), "password123");
    expect(result).toEqual({ ok: false, reason: "Enter a valid email address." });
  });

  it("refuses a new account with a short password", async () => {
    const result = await settings.saveAdminUser(adminUser(), "short");
    expect(result).toEqual({ ok: false, reason: "Set a password of at least eight characters." });
  });

  it("refuses an existing account's short new password", async () => {
    const result = await settings.saveAdminUser(adminUser({ id: "ADM1" }), "short");
    expect(result).toEqual({ ok: false, reason: "A new password must be at least eight characters." });
  });

  it("allows an existing account with no password change", async () => {
    api.put("/admin/users/ADM1", {});
    const result = await settings.saveAdminUser(adminUser({ id: "ADM1" }));
    expect(result.ok).toBe(true);
  });

  it("refuses an email already used by another account", async () => {
    api.get("/admin/users", [{ id: "ADM2", email: "new@x.com" }]);
    const result = await settings.saveAdminUser(adminUser(), "password123");
    expect(result).toEqual({ ok: false, reason: "new@x.com already has an account." });
  });

  it("derives initials from the name and creates a new account", async () => {
    api.post("/admin/users", (req) => req.body);
    const result = await settings.saveAdminUser(adminUser({ name: "Priya Shah" }), "password123");
    expect(result).toMatchObject({ ok: true, data: { avatarInitials: "PS" } });
    expect(api.last("POST", "/admin/users")!.body).toMatchObject({ password: "password123" });
  });

  it("does not send a password field when none is given for an edit", async () => {
    api.put("/admin/users/ADM1", (req) => req.body);
    await settings.saveAdminUser(adminUser({ id: "ADM1" }));
    expect(api.last("PUT", "/admin/users/ADM1")!.body).not.toHaveProperty("password");
  });
});

describe("deleteAdminUser", () => {
  it("refuses when missing", async () => {
    api.get("/admin/users", []);
    const result = await settings.deleteAdminUser("missing");
    expect(result).toEqual({ ok: false, reason: "That admin user no longer exists." });
  });

  it("refuses to delete the only active super admin", async () => {
    api.get("/admin/users", [{ id: "ADM1", name: "Owner", role: "super-admin", status: "active" }]);
    const result = await settings.deleteAdminUser("ADM1");
    expect(result).toEqual({ ok: false, reason: "This is the only active super admin. Add another one first." });
  });

  it("allows deleting one of two active super admins", async () => {
    api.get("/admin/users", [
      { id: "ADM1", name: "Owner", role: "super-admin", status: "active" },
      { id: "ADM2", name: "Co-owner", role: "super-admin", status: "active" },
    ]);
    api.delete("/admin/users/ADM1", {});
    const result = await settings.deleteAdminUser("ADM1");
    expect(result).toEqual({ ok: true, data: "Owner" });
  });

  it("allows deleting a non-super-admin", async () => {
    api.get("/admin/users", [{ id: "ADM1", name: "Editor", role: "editor", status: "active" }]);
    api.delete("/admin/users/ADM1", {});
    const result = await settings.deleteAdminUser("ADM1");
    expect(result).toEqual({ ok: true, data: "Editor" });
  });
});

describe("setAdminUserStatus", () => {
  it("refuses when missing", async () => {
    api.get("/admin/users", []);
    const result = await settings.setAdminUserStatus("missing", "disabled");
    expect(result).toEqual({ ok: false, reason: "That admin user no longer exists." });
  });

  it("refuses to disable the only active super admin", async () => {
    api.get("/admin/users", [{ id: "ADM1", role: "super-admin", status: "active" }]);
    const result = await settings.setAdminUserStatus("ADM1", "disabled");
    expect(result).toEqual({ ok: false, reason: "This is the only active super admin." });
  });

  it("allows disabling any other admin", async () => {
    api.get("/admin/users", [{ id: "ADM1", role: "editor", status: "active" }]);
    api.put("/admin/users/ADM1", (req) => req.body);
    const result = await settings.setAdminUserStatus("ADM1", "disabled");
    expect(result).toMatchObject({ ok: true, data: { status: "disabled" } });
  });
});

describe("emptyAdminUser", () => {
  it("is a blank, active editor with no id", () => {
    const user = settings.emptyAdminUser();
    expect(user).toMatchObject({ id: "", role: "editor", status: "active", name: "", email: "" });
  });
});
