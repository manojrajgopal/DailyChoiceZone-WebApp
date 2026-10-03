import { afterEach, describe, expect, it, vi } from "vitest";

import { api, fail, networkError } from "@/test/api";
import { signIn } from "@/test/render";
import { session } from "@/test/sliceD-acct1-fixtures";
import { useSessionStore } from "@/store/sessionStore";
import { useToastStore } from "@/store/toastStore";

import { apiGet, getToken } from "./api/client";
import { refreshSessionNow, scheduleSessionRefresh, stopSessionRefresh, storeCustomerToken } from "./sessionRefresh";

/** A JWT-shaped token whose `exp` is `secondsFromNow` away (the signature is never checked here). */
function jwt(secondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ sub: "C1", exp: Math.floor(Date.now() / 1000) + secondsFromNow }))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${payload}.signature`;
}

const REFRESHED = { token: { accessToken: "refreshed-token", tokenType: "bearer", expiresIn: 3600 } };

afterEach(() => stopSessionRefresh());

describe("refreshing before the token expires", () => {
  it("swaps the token two minutes before the expiry the API sent with it", async () => {
    vi.useFakeTimers();
    api.post("/auth/session/refresh", REFRESHED);
    storeCustomerToken({ accessToken: "first-token", tokenType: "bearer", expiresIn: 600 });
    expect(getToken()).toBe("first-token");

    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(api.requests("POST", "/auth/session/refresh")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000 + 1_000);
    expect(api.requests("POST", "/auth/session/refresh")).toHaveLength(1);
    expect(api.last("POST", "/auth/session/refresh")!.headers.authorization).toBe("Bearer first-token");
    expect(getToken()).toBe("refreshed-token");
  });

  it("reads the expiry from a stored token's own claim after a reload", async () => {
    vi.useFakeTimers();
    api.post("/auth/session/refresh", REFRESHED);
    signIn("customer", jwt(300));
    scheduleSessionRefresh();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
    expect(getToken()).toBe("refreshed-token");
  });

  it("does nothing for a token whose expiry it can't know", async () => {
    vi.useFakeTimers();
    signIn("customer", "opaque-token");
    scheduleSessionRefresh();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(api.requests("POST", "/auth/session/refresh")).toHaveLength(0);
  });

  it("leaves the token alone when the server can't refresh it", async () => {
    signIn("customer", "old-token");
    api.post("/auth/session/refresh", fail(401, "Sign in again to continue.", "SESSION_REFRESH_UNAVAILABLE"));
    // A 401 that isn't "this session is over" from the general rule, but the
    // refresh endpoint's own: the token is kept until it runs out.
    expect(await refreshSessionNow()).toBe(false);
    expect(getToken()).toBe("old-token");
  });

  it("signs out locally when the refresh is refused", async () => {
    signIn("customer", "old-token");
    useSessionStore.setState({ session: session() });
    api.post("/auth/session/refresh", fail(401, "Your session has ended. Sign in again.", "SESSION_EXPIRED"));
    expect(await refreshSessionNow()).toBe(false);
    expect(getToken()).toBeNull();
    expect(useSessionStore.getState().session).toBeNull();
  });

  it("tries again a minute later after a network failure", async () => {
    vi.useFakeTimers();
    signIn("customer", jwt(3600));
    // Later registrations win: the failure answers first, once.
    api.post("/auth/session/refresh", REFRESHED);
    api.once("POST", "/auth/session/refresh", networkError());
    expect(await refreshSessionNow()).toBe(false);
    expect(getToken()).not.toBe("refreshed-token");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(getToken()).toBe("refreshed-token");
  });
});

describe("a session ended elsewhere", () => {
  it("forgets the token, clears the signed-in session and says why on SESSION_REVOKED", async () => {
    signIn("customer", "revoked-token");
    useSessionStore.setState({ session: session() });
    api.get("/account/addresses", fail(401, "You've been signed out on this device. Sign in again.", "SESSION_REVOKED"));

    await expect(apiGet("/account/addresses", { auth: "customer" })).rejects.toMatchObject({ code: "SESSION_REVOKED" });
    expect(getToken()).toBeNull();
    expect(useSessionStore.getState().session).toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      "You've been signed out on this device. Sign in again.",
    ]);
  });

  it("does the same on SESSION_EXPIRED, and only once for a burst of failures", async () => {
    signIn("customer", "expired-token");
    useSessionStore.setState({ session: session() });
    api.get("/account/orders", fail(401, "Your session has ended. Sign in again.", "SESSION_EXPIRED"));
    await Promise.allSettled([
      apiGet("/account/orders", { auth: "customer" }),
      apiGet("/account/orders", { auth: "customer" }),
    ]);
    expect(getToken()).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("leaves the session alone for any other 401", async () => {
    signIn("customer", "tok");
    useSessionStore.setState({ session: session() });
    api.get("/account/orders", fail(401, "Nope", "UNAUTHORIZED"));
    await expect(apiGet("/account/orders", { auth: "customer" })).rejects.toBeTruthy();
    expect(getToken()).toBe("tok");
    expect(useSessionStore.getState().session).not.toBeNull();
  });

  it("ignores a refusal for a token that has since been replaced", async () => {
    signIn("customer", "old");
    useSessionStore.setState({ session: session() });
    api.get("/account/orders", () => {
      // A refresh lands while this request is in flight.
      window.localStorage.setItem("dcz:auth-token", "new");
      return fail(401, "Your session has ended.", "SESSION_EXPIRED");
    });
    await expect(apiGet("/account/orders", { auth: "customer" })).rejects.toBeTruthy();
    expect(getToken()).toBe("new");
    expect(useSessionStore.getState().session).not.toBeNull();
  });
});
