import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AdminSession } from "@/types/admin";

import { api, fail } from "@/test/api";
import { useAdminAuthStore } from "@/store/adminAuthStore";
import { useToastStore } from "@/store/toastStore";

import { useAdminSession } from "./useAdminSession";

const SESSION: AdminSession = {
  user: {
    id: "A1",
    name: "Admin One",
    email: "admin@example.com",
    role: "manager",
    status: "active",
    permissions: ["orders", "customers", "products"],
    lastLoginAt: null,
    createdAt: "2024-01-01",
    avatarInitials: "AO",
  },
  token: "admin-token",
  issuedAt: "2024-01-01",
};

describe("useAdminSession", () => {
  describe("no stored session", () => {
    it("is signed out and not loading once hydrated", async () => {
      const { result } = renderHook(() => useAdminSession());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.isSignedIn).toBe(false);
      expect(result.current.user).toBeNull();
      expect(api.calls).toHaveLength(0);
    });
  });

  describe("sign in / sign out / profile", () => {
    it("signIn stores the session and never waits for a confirmation check", async () => {
      api.post("/admin/auth/login", {
        token: { accessToken: "tok", tokenType: "Bearer", expiresIn: 3600 },
        admin: { id: "A2", name: "Nina", email: "n@x.com", role: "admin", status: "active", permissions: [], lastLoginAt: null, createdAt: "2024-01-01", avatarInitials: "N" },
      });
      const { result } = renderHook(() => useAdminSession());
      const response = await act(() => result.current.signIn({ email: "n@x.com", password: "secret" }));
      expect(response.ok).toBe(true);
      expect(useAdminAuthStore.getState().session?.user.name).toBe("Nina");
    });

    it("signIn reports the server's reason on failure", async () => {
      api.post("/admin/auth/login", fail(401, "Wrong email or password"));
      const { result } = renderHook(() => useAdminSession());
      const response = await act(() => result.current.signIn({ email: "n@x.com", password: "bad" }));
      expect(response).toEqual({ ok: false, reason: "Wrong email or password" });
      expect(useAdminAuthStore.getState().session).toBeNull();
    });

    it("signOut clears the session, calls the API and toasts", async () => {
      useAdminAuthStore.setState({ session: SESSION });
      api.post("/admin/auth/logout", {});
      const { result } = renderHook(() => useAdminSession());
      await act(() => result.current.signOut());
      expect(useAdminAuthStore.getState().session).toBeNull();
      expect(api.requests("POST", "/admin/auth/logout")).toHaveLength(1);
      expect(useToastStore.getState().toasts.some((t) => t.message === "Signed out of the admin portal")).toBe(true);
    });

    it("updateProfile patches the local user and toasts", () => {
      useAdminAuthStore.setState({ session: SESSION });
      const { result } = renderHook(() => useAdminSession());
      act(() => result.current.updateProfile({ name: "Changed" }));
      expect(useAdminAuthStore.getState().session?.user.name).toBe("Changed");
      expect(useToastStore.getState().toasts.some((t) => t.message === "Profile updated")).toBe(true);
    });
  });

  describe("permissions", () => {
    it("can() reflects the signed-in user's own permission list", () => {
      useAdminAuthStore.setState({ session: SESSION });
      const { result } = renderHook(() => useAdminSession());
      expect(result.current.can("manage:orders")).toBe(true);
      expect(result.current.can("manage:adminUsers")).toBe(false);
    });

    it("can() is false for every permission while signed out", () => {
      const { result } = renderHook(() => useAdminSession());
      expect(result.current.can("view:dashboard")).toBe(false);
    });
  });

  /**
   * Like the customer session, the server confirmation is module-scoped (once
   * per page load) so each scenario needs its own fresh module graph, seeded
   * through `localStorage` rather than raced with a manual `setState`.
   */
  describe("confirming a stored admin session against the server (fresh module per test)", () => {
    async function freshWithStoredSession(session: AdminSession | null) {
      if (session) {
        window.localStorage.setItem("dcz:admin:session", JSON.stringify({ state: { session }, version: 1 }));
      }
      vi.resetModules();
      const [storeMod, hookMod] = await Promise.all([
        import("@/store/adminAuthStore"),
        import("./useAdminSession"),
      ]);
      for (let i = 0; i < 50 && !storeMod.useAdminAuthStore.persist?.hasHydrated?.(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(storeMod.useAdminAuthStore.getState().session?.user.id).toBe(session?.user.id);
      return { useAdminSession: hookMod.useAdminSession, store: storeMod.useAdminAuthStore };
    }

    it("is loading, then confirmed, once the server confirms the token", async () => {
      const { useAdminSession: fresh } = await freshWithStoredSession(SESSION);
      api.get("/admin/auth/me", {
        id: "A1", name: "Admin One", email: "admin@example.com", role: "manager", status: "active",
        permissions: ["orders"], lastLoginAt: null, createdAt: "2024-01-01", avatarInitials: "AO",
      });
      const { result } = renderHook(() => fresh());
      expect(result.current.isLoading).toBe(true);
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.isSignedIn).toBe(true);
      expect(api.requests("GET", "/admin/auth/me")).toHaveLength(1);
    });

    it("drops the session when the server no longer recognises it", async () => {
      const { useAdminSession: fresh, store } = await freshWithStoredSession(SESSION);
      api.get("/admin/auth/me", fail(401, "Session expired"));
      const { result } = renderHook(() => fresh());
      await waitFor(() => expect(result.current.isSignedIn).toBe(false));
      expect(store.getState().session).toBeNull();
    });
  });
});
