"use client";

import { useCallback, useEffect, useState } from "react";

import type { AuthSession, Credentials, RegisterInput, User } from "@/types";

import { clearRecentSearches } from "@/lib/search/recent-searches";
import * as authService from "@/services/authService";
import { scheduleSessionRefresh } from "@/services/sessionRefresh";
import { useSessionStore } from "@/store/sessionStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";

/**
 * Whether the stored session has been checked against the server.
 *
 * Module-scoped, so the check happens once per page load however many
 * components call the hook.
 */
let checkStarted = false;
let settled = false;

/** A fresh sign-in needs no confirming: it came from the server. */
function markVerified(): void {
  checkStarted = true;
  settled = true;
}

/**
 * Run the session check, and report whether it has finished.
 *
 * Shared by `useSession` and by anything that must not call an account
 * endpoint on an unconfirmed token — the cart and the wishlist both did, and
 * a stale token meant two requests per page that could only return 401.
 */
function useVerifiedSession() {
  const hydrated = useHydrated();
  const session = useSessionStore((state) => state.session);
  const updateUser = useSessionStore((state) => state.updateUser);
  const clearSession = useSessionStore((state) => state.signOut);

  const [checked, setChecked] = useState(settled);

  useEffect(() => {
    if (!hydrated) return;

    if (session === null) {
      settled = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing to ask the server: settled at once
      setChecked(true);
      return;
    }

    if (checkStarted) {
      if (settled) setChecked(true);
      return;
    }

    checkStarted = true;

    void authService.getCurrentUser().then((user) => {
      if (user) {
        updateUser(user);
        // Keep the token fresh for as long as the page is open.
        scheduleSessionRefresh();
      } else clearSession();

      settled = true;
      setChecked(true);
    });
  }, [hydrated, session, updateUser, clearSession]);

  return { hydrated, session, confirmed: checked };
}

/**
 * Whether there is a signed-in customer whose token the server has confirmed.
 *
 * What the cart and the wishlist gate on. `false` while the check is in
 * flight, so neither asks an account endpoint before it is known that the
 * token still works.
 */
export function useConfirmedCustomer(): boolean {
  const { session, confirmed } = useVerifiedSession();
  return confirmed && session !== null;
}

/**
 * The same answer, plus whether it is still being worked out.
 *
 * `useConfirmedCustomer` on its own is not enough for anything that *acts* on
 * being a guest, because it says `false` twice over: once for "signed out" and
 * once for "we have a token but have not asked yet". The checkout read the
 * second as the first — it resolved an empty guest bag, decided the bag was
 * empty and bounced a signed-in shopper with items in it back to /cart.
 *
 * `isPending` separates them. There is nothing to wait for when no session is
 * stored, so a genuine guest is never held up.
 */
export function useCustomerStatus(): { isSignedIn: boolean; isPending: boolean } {
  const { hydrated, session, confirmed } = useVerifiedSession();

  return {
    isSignedIn: confirmed && session !== null,
    isPending: !hydrated || (session !== null && !confirmed),
  };
}

/**
 * The signed-in customer.
 *
 * What local storage holds is who *was* signed in. The token behind it
 * expires, so the hook asks the server once per page load and drops the
 * session if the answer is no — otherwise the account area renders a
 * signed-in shell whose every figure comes back empty.
 */
export function useSession() {
  const { hydrated, session } = useVerifiedSession();
  const setSession = useSessionStore((state) => state.setSession);
  const updateUser = useSessionStore((state) => state.updateUser);
  const clearSession = useSessionStore((state) => state.signOut);

  const signIn = useCallback(
    async (credentials: Credentials) => {
      const result = await authService.signIn(credentials);
      if (result.ok) {
        // Straight from the server, so there is nothing to confirm.
        markVerified();
        setSession(result.session);
        toast.success(`Welcome back, ${result.session.user.firstName}`);
      } else {
        toast.error(result.reason);
      }
      return result;
    },
    [setSession],
  );

  /**
   * Adopt a session the server has just handed over — a code sign-in, a
   * Google / Apple / Microsoft sign-in, or a registration whose codes have
   * been typed in. The token is already stored by the service.
   */
  const acceptSession = useCallback(
    (next: AuthSession, message?: string) => {
      markVerified();
      setSession(next);
      if (message) toast.success(message);
    },
    [setSession],
  );

  /**
   * Create an account.
   *
   * When the store confirms new accounts with a code, the session is *not*
   * adopted yet: the sign-up page stays up to take the code(s), and calls
   * `acceptSession` when they are done (the token is already stored, so the
   * code endpoints can be called). Otherwise the shopper is signed in at once.
   */
  const register = useCallback(
    async (input: RegisterInput) => {
      const result = await authService.register(input);
      if (result.ok) {
        const awaitingCodes = Boolean(result.verification || result.phoneVerification);
        if (!awaitingCodes) {
          // Straight from the server, so there is nothing to confirm.
          markVerified();
          setSession(result.session);
        }
        toast.success("Account created");
      } else {
        toast.error(result.reason);
      }
      return result;
    },
    [setSession],
  );

  const signOut = useCallback(async () => {
    await authService.signOut();
    clearSession();
    // What this person searched for stays with them, not with the next person on this device.
    clearRecentSearches();
    toast.info("Signed out");
  }, [clearSession]);

  const updateProfile = useCallback(
    (patch: Partial<User>) => {
      updateUser(patch);
      authService.updateProfile(patch);
      toast.success("Profile updated");
    },
    [updateUser],
  );

  return {
    /** Null until hydrated, so server and client markup agree. */
    user: hydrated ? (session?.user ?? null) : null,
    isSignedIn: hydrated && session !== null,
    isLoading: !hydrated,
    signIn,
    register,
    acceptSession,
    signOut,
    updateProfile,
  };
}
