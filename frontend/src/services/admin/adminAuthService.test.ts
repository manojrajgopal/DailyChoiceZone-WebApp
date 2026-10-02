import { beforeEach, describe, expect, it } from "vitest";

import type { AdminUser } from "@/types/admin";

import { api, fail, networkError } from "@/test/api";
import { useAdminAuthStore } from "@/store/adminAuthStore";

import * as adminAuth from "./adminAuthService";

beforeEach(() => {
  api.get(/.*/, {});
  api.post(/.*/, {});
  api.put(/.*/, {});
});

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return { id: "A1", name: "Admin", email: "admin@x.com", role: "admin", status: "active", lastLoginAt: null, createdAt: "2024-01-01", avatarInitials: "A", ...overrides };
}

describe("signIn", () => {
  it("refuses an empty email or password without calling the API", async () => {
    await expect(adminAuth.signIn({ email: "", password: "x" })).resolves.toEqual({ ok: false, reason: "Enter your email address." });
    await expect(adminAuth.signIn({ email: "a@b.com", password: "" })).resolves.toEqual({ ok: false, reason: "Enter your password." });
    expect(api.requests("POST")).toHaveLength(0);
  });

  it("trims and lower-cases the email before sending", async () => {
    api.post("/admin/auth/login", { token: { accessToken: "tok", tokenType: "Bearer", expiresIn: 3600 }, admin: user() });
    await adminAuth.signIn({ email: "  Admin@X.com  ", password: "secret" });
    expect(api.last("POST", "/admin/auth/login")!.body).toEqual({ email: "admin@x.com", password: "secret" });
  });

  it("stores the token and resolves with the session on success", async () => {
    api.post("/admin/auth/login", { token: { accessToken: "tok123", tokenType: "Bearer", expiresIn: 3600 }, admin: user({ name: "Nina" }) });
    const result = await adminAuth.signIn({ email: "a@b.com", password: "secret" });
    expect(result).toMatchObject({ ok: true, data: { user: { name: "Nina" }, token: "tok123" } });
    expect(localStorage.getItem("dcz:admin-token")).toBe("tok123");
  });

  it("passes through the server's rejection message", async () => {
    api.post("/admin/auth/login", fail(401, "Wrong email or password"));
    const result = await adminAuth.signIn({ email: "a@b.com", password: "bad" });
    expect(result).toEqual({ ok: false, reason: "Wrong email or password" });
  });

  it("surfaces a network failure's own message (it is still an ApiError)", async () => {
    api.post("/admin/auth/login", networkError());
    const result = await adminAuth.signIn({ email: "a@b.com", password: "bad" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/connect|internet/i);
  });
});

describe("signOut", () => {
  it("clears the token and the store even when the API call fails", async () => {
    localStorage.setItem("dcz:admin-token", "tok123");
    useAdminAuthStore.setState({ session: { user: user(), token: "tok123", issuedAt: "2024-01-01" } });
    api.post("/admin/auth/logout", fail(500));
    await adminAuth.signOut();
    expect(localStorage.getItem("dcz:admin-token")).toBeNull();
    expect(useAdminAuthStore.getState().session).toBeNull();
  });

  it("calls the logout endpoint when it succeeds", async () => {
    api.post("/admin/auth/logout", {});
    await adminAuth.signOut();
    expect(api.requests("POST", "/admin/auth/logout")).toHaveLength(1);
  });
});

describe("refreshSession", () => {
  it("resolves the current admin on success", async () => {
    api.get("/admin/auth/me", user({ name: "Refreshed" }));
    await expect(adminAuth.refreshSession()).resolves.toMatchObject({ name: "Refreshed" });
  });

  it("resolves null rather than throwing on failure", async () => {
    api.get("/admin/auth/me", fail(401));
    await expect(adminAuth.refreshSession()).resolves.toBeNull();
  });
});

describe("getSession / currentActorId", () => {
  it("reads straight from the store", () => {
    expect(adminAuth.getSession()).toBeNull();
    expect(adminAuth.currentActorId()).toBe("");

    useAdminAuthStore.setState({ session: { user: user({ id: "A9" }), token: "t", issuedAt: "2024-01-01" } });
    expect(adminAuth.getSession()?.user.id).toBe("A9");
    expect(adminAuth.currentActorId()).toBe("A9");
  });
});

describe("can", () => {
  it("is false for no user, or a disabled one", () => {
    expect(adminAuth.can(null, "view:dashboard")).toBe(false);
    expect(adminAuth.can(user({ status: "disabled" }), "view:dashboard")).toBe(false);
  });

  it("a super-admin may do everything, even without a permissions list", () => {
    expect(adminAuth.can(user({ role: "super-admin", permissions: undefined }), "manage:adminUsers")).toBe(true);
  });

  it("checks the server's own permission list when the user carries one", () => {
    const withPermissions = user({ role: "editor", permissions: ["products"] });
    expect(adminAuth.can(withPermissions, "manage:catalogue")).toBe(true);
    expect(adminAuth.can(withPermissions, "manage:orders")).toBe(false);
  });

  it("view:dashboard needs no specific server permission", () => {
    expect(adminAuth.can(user({ role: "editor", permissions: [] }), "view:dashboard")).toBe(true);
  });

  it("falls back to the role's permissions when the user carries none (an assembled, not signed-in, user)", () => {
    expect(adminAuth.can(user({ role: "manager", permissions: undefined }), "manage:orders")).toBe(true);
    expect(adminAuth.can(user({ role: "manager", permissions: undefined }), "manage:adminUsers")).toBe(false);
  });
});

describe("permissionsFor", () => {
  it("lists what each role may do by default", () => {
    expect(adminAuth.permissionsFor("editor")).toEqual(["view:dashboard", "manage:catalogue", "manage:storefront"]);
    expect(adminAuth.permissionsFor("super-admin")).toContain("manage:adminUsers");
  });
});
