import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/types";

import { api, fail } from "@/test/api";
import { useSessionStore } from "@/store/sessionStore";
import { useToastStore } from "@/store/toastStore";

import { useCustomerStatus, useSession } from "./useSession";

const SESSION: AuthSession = {
  user: {
    id: "U1",
    firstName: "Asha",
    lastName: "Menon",
    email: "asha@example.com",
    phone: "9999999999",
    memberSince: "2024-01-01",
    emailVerified: true,
  },
  token: "customer-token",
};

describe("useSession family", () => {
  describe("no stored session", () => {
    it("useCustomerStatus is settled and signed out immediately, with no API call", async () => {
      const { result } = renderHook(() => useCustomerStatus());
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.isSignedIn).toBe(false);
      expect(api.calls).toHaveLength(0);
    });

    it("useSession reports a signed-out, non-loading state", () => {
      const { result } = renderHook(() => useSession());
      expect(result.current.isSignedIn).toBe(false);
      expect(result.current.user).toBeNull();
    });
  });

  describe("sign in / register / sign out / profile", () => {
    it("signIn stores the session and toasts a welcome message", async () => {
      api.post("/auth/login", {
        token: { accessToken: "tok", tokenType: "Bearer", expiresIn: 3600 },
        customer: { id: "U2", email: "x@y.com", firstName: "Rae", lastName: "K", name: "Rae K", phone: "1", status: "active", joinedAt: "2024-01-01" },
      });
      const { result } = renderHook(() => useSession());
      const response = await act(() => result.current.signIn({ email: "x@y.com", password: "secret" }));
      expect(response.ok).toBe(true);
      expect(useSessionStore.getState().session?.user.firstName).toBe("Rae");
      expect(useToastStore.getState().toasts.some((t) => /Welcome back, Rae/.test(t.message))).toBe(true);
    });

    it("signIn toasts the reason on failure and leaves the session untouched", async () => {
      api.post("/auth/login", fail(401, "Wrong email or password"));
      const { result } = renderHook(() => useSession());
      const response = await act(() => result.current.signIn({ email: "x@y.com", password: "bad" }));
      expect(response).toEqual({ ok: false, reason: "Wrong email or password" });
      expect(useSessionStore.getState().session).toBeNull();
      expect(useToastStore.getState().toasts.some((t) => t.message === "Wrong email or password")).toBe(true);
    });

    it("register stores the session on success", async () => {
      api.post("/auth/register", {
        token: { accessToken: "tok", tokenType: "Bearer", expiresIn: 3600 },
        customer: { id: "U3", email: "n@x.com", firstName: "Neel", lastName: "P", name: "Neel P", phone: "1", status: "active", joinedAt: "2024-01-01" },
      });
      const { result } = renderHook(() => useSession());
      const response = await act(() =>
        result.current.register({ email: "n@x.com", password: "secret", firstName: "Neel", lastName: "P" }),
      );
      expect(response.ok).toBe(true);
      expect(useSessionStore.getState().session?.user.firstName).toBe("Neel");
    });

    it("register toasts the reason on failure and leaves the session untouched", async () => {
      api.post("/auth/register", fail(409, "That email is already registered"));
      const { result } = renderHook(() => useSession());
      const response = await act(() =>
        result.current.register({ email: "x@y.com", password: "secret", firstName: "X", lastName: "Y" }),
      );
      expect(response).toEqual({ ok: false, reason: "That email is already registered" });
      expect(useSessionStore.getState().session).toBeNull();
      expect(useToastStore.getState().toasts.some((t) => t.message === "That email is already registered")).toBe(true);
    });

    it("signOut clears the session and calls the API", async () => {
      useSessionStore.setState({ session: SESSION });
      api.post("/auth/logout", {});
      const { result } = renderHook(() => useSession());
      await act(() => result.current.signOut());
      expect(useSessionStore.getState().session).toBeNull();
      expect(api.requests("POST", "/auth/logout")).toHaveLength(1);
      expect(useToastStore.getState().toasts.some((t) => t.message === "Signed out")).toBe(true);
    });

    it("updateProfile patches the local user and toasts", () => {
      useSessionStore.setState({ session: SESSION });
      api.put("/account/profile", { ...SESSION.user, firstName: "Changed", name: "Changed Menon" });
      const { result } = renderHook(() => useSession());
      act(() => result.current.updateProfile({ firstName: "Changed" }));
      expect(useSessionStore.getState().session?.user.firstName).toBe("Changed");
      expect(useToastStore.getState().toasts.some((t) => t.message === "Profile updated")).toBe(true);
    });
  });

  /**
   * The "has the server confirmed this token yet" check is deliberately
   * module-scoped (once per real page load, not once per component) — see the
   * hook's own docstring. That means it can only be observed fresh once per
   * module instance, so each of these scenarios resets the module graph and
   * re-imports the hook (and the stores it closes over) from scratch, seeding
   * `localStorage` first so the store's own rehydration — not a manual
   * `setState` racing it — produces the starting session.
   */
  describe("confirming a stored session against the server (fresh module per test)", () => {
    async function freshWithStoredSession(session: AuthSession | null) {
      if (session) {
        window.localStorage.setItem("dcz:session", JSON.stringify({ state: { session }, version: 1 }));
      }
      vi.resetModules();
      const [storeMod, hookMod] = await Promise.all([
        import("@/store/sessionStore"),
        import("./useSession"),
      ]);
      for (let i = 0; i < 50 && !storeMod.useSessionStore.persist?.hasHydrated?.(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(storeMod.useSessionStore.getState().session?.user.id).toBe(session?.user.id);
      return hookMod;
    }

    it("is pending, then confirmed, once the server confirms the token", async () => {
      const { useCustomerStatus: fresh } = await freshWithStoredSession(SESSION);
      api.get("/auth/me", {
        id: "U1", email: "asha@example.com", firstName: "Asha", lastName: "Menon",
        name: "Asha Menon", phone: "9999999999", status: "active", joinedAt: "2024-01-01", emailVerified: true,
      });
      const { result } = renderHook(() => fresh());
      expect(result.current.isPending).toBe(true);
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.isSignedIn).toBe(true);
      expect(api.requests("GET", "/auth/me")).toHaveLength(1);
    });

    it("drops the session when the server no longer recognises it", async () => {
      const { useConfirmedCustomer: fresh } = await freshWithStoredSession(SESSION);
      api.get("/auth/me", fail(401, "Session expired"));
      const { result } = renderHook(() => fresh());
      await waitFor(() => expect(result.current).toBe(false));
    });

    it("confirms only once across multiple hook instances on the same page", async () => {
      const { useCustomerStatus: fresh } = await freshWithStoredSession(SESSION);
      api.get("/auth/me", {
        id: "U1", email: "a@x.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01",
      });
      renderHook(() => fresh());
      renderHook(() => fresh());
      await waitFor(() => expect(api.requests("GET", "/auth/me")).toHaveLength(1));
    });
  });
});
