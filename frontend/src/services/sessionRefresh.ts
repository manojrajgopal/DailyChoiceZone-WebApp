/**
 * Keeping a signed-in customer signed in.
 *
 * An access token lasts an hour; the session behind it lasts much longer. A
 * little before the token runs out, it is swapped for a fresh one for the
 * same session (`POST /auth/session/refresh`), so nobody is signed out in the
 * middle of a checkout because a clock ran down.
 *
 * Every customer token the app stores goes through `storeCustomerToken`, so
 * the expiry the API sent with it is known. A token found in storage after a
 * reload has no `expiresIn` beside it; its own `exp` claim is read instead.
 * The token is never logged and never stored anywhere but the token store.
 */
import type { ApiToken } from "@/types/identity";

import { ApiError, apiPost, endCustomerSession, getToken, onCustomerSessionEnded, setToken } from "@/services/api/client";

/** Refresh this long before the token expires. */
const EARLY_MS = 2 * 60_000;
/** Never sooner than this after scheduling (a token that is nearly spent is refreshed promptly, not in a loop). */
const MIN_DELAY_MS = 5_000;
/** `setTimeout` overflows past ~24.8 days. */
const MAX_DELAY_MS = 2 ** 31 - 1;
/** After a network failure, try again this much later. */
const RETRY_MS = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
/** The expiry the API told us about, for the token it belongs to. */
let known: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<boolean> | null = null;
let listening = false;

/** `exp` from a JWT, in ms — or null when the token is not one we can read. */
function jwtExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function expiryOf(token: string): number | null {
  if (known && known.token === token) return known.expiresAt;
  return jwtExpiry(token);
}

function clearTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  onCustomerSessionEnded(() => stopSessionRefresh());
  // Timers are throttled in a background tab and paused while a laptop
  // sleeps: on coming back, catch up if the token is close to running out.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const token = getToken("customer");
    const expiresAt = token ? expiryOf(token) : null;
    if (expiresAt !== null && expiresAt - Date.now() <= EARLY_MS) void refreshSessionNow();
  });
}

/** (Re)start the timer for whichever customer token is stored. Does nothing without one. */
export function scheduleSessionRefresh(): void {
  if (typeof window === "undefined") return;
  listen();
  clearTimer();
  const token = getToken("customer");
  if (!token) return;
  const expiresAt = expiryOf(token);
  if (expiresAt === null) return;
  const delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, expiresAt - Date.now() - EARLY_MS));
  timer = setTimeout(() => {
    timer = null;
    void refreshSessionNow();
  }, delay);
}

/** Stop refreshing (signed out). */
export function stopSessionRefresh(): void {
  clearTimer();
  known = null;
}

/** Store a customer token from the API and keep it fresh. */
export function storeCustomerToken(token: ApiToken): void {
  setToken(token.accessToken, "customer");
  if (typeof token.expiresIn === "number" && token.expiresIn > 0) {
    known = { token: token.accessToken, expiresAt: Date.now() + token.expiresIn * 1000 };
  }
  scheduleSessionRefresh();
}

/**
 * Swap the token for a fresh one now. True when it worked.
 *
 * A refused refresh (401) means the session is over on this device; a refresh
 * the server cannot offer (an old token without a session) leaves the token
 * to run its course; a network failure is tried again shortly.
 */
export function refreshSessionNow(): Promise<boolean> {
  if (inFlight) return inFlight;
  const sent = getToken("customer");
  if (!sent) return Promise.resolve(false);

  inFlight = (async () => {
    try {
      const data = await apiPost<{ token: ApiToken }>("/auth/session/refresh", {}, { auth: "customer" });
      // Signed out (or in as someone else) while this was in flight: keep what is there now.
      if (getToken("customer") !== sent) return false;
      storeCustomerToken(data.token);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "SESSION_REFRESH_UNAVAILABLE") {
        clearTimer();
        return false;
      }
      if (error instanceof ApiError && error.status === 401) {
        if (getToken("customer") === sent) endCustomerSession(error.message);
        stopSessionRefresh();
        return false;
      }
      // Offline or the API is down: try again in a minute while the token still works.
      const expiresAt = expiryOf(sent);
      if (expiresAt !== null && expiresAt > Date.now()) {
        clearTimer();
        timer = setTimeout(() => {
          timer = null;
          void refreshSessionNow();
        }, RETRY_MS);
      }
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
