import { describe, expect, it } from "vitest";

import type { AdminSession } from "@/types/admin";

import { useAdminAuthStore } from "./adminAuthStore";

const KEY = "dcz:admin:session";
const SESSION: AdminSession = {
  token: "adm",
  issuedAt: "2026-01-01T00:00:00Z",
  user: {
    id: "A1",
    name: "Admin",
    email: "admin@example.com",
    role: "admin",
    status: "active",
    lastLoginAt: null,
    createdAt: "2025-01-01T00:00:00Z",
    avatarInitials: "AD",
  },
};
const admin = () => useAdminAuthStore.getState();

describe("useAdminAuthStore", () => {
  it("starts signed out", () => {
    expect(admin().session).toBeNull();
  });

  it("sets a session and signs out", () => {
    admin().setSession(SESSION);
    expect(admin().session).toEqual(SESSION);
    admin().signOut();
    expect(admin().session).toBeNull();
  });

  it("patches the user only, keeping the token", () => {
    admin().setSession(SESSION);
    admin().updateUser({ name: "Renamed", permissions: ["orders:write"] });
    expect(admin().session).toEqual({ ...SESSION, user: { ...SESSION.user, name: "Renamed", permissions: ["orders:write"] } });
  });

  it("ignores a patch while signed out", () => {
    admin().updateUser({ name: "Ghost" });
    expect(admin().session).toBeNull();
  });

  it("persists the session under its own key and rehydrates it", async () => {
    admin().setSession(SESSION);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ state: { session: SESSION }, version: 1 });
    admin().signOut();
    localStorage.setItem(KEY, JSON.stringify({ state: { session: SESSION }, version: 1 }));
    await useAdminAuthStore.persist.rehydrate();
    expect(admin().session).toEqual(SESSION);
  });

  it("ignores corrupt stored data", async () => {
    localStorage.setItem(KEY, "{{");
    await useAdminAuthStore.persist.rehydrate();
    expect(admin().session).toBeNull();
  });
});
