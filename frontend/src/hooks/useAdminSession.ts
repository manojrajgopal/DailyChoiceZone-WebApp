"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { AdminCredentials } from "@/services/admin/adminAuthService";
import type { AdminUser } from "@/types/admin";

import * as adminAuth from "@/services/admin/adminAuthService";
import { useAdminAuthStore } from "@/store/adminAuthStore";
import { toast } from "@/store/toastStore";

/**
 * Whether the admin session store has finished reading local storage.
 *
 * The route guard depends on this. Redirecting on a session that has not
 * rehydrated yet would bounce a signed-in admin back to the login page on every
 * refresh — the same trap the customer checkout hit.
 */
const subscribeHydration = (onChange: () => void) =>
  useAdminAuthStore.persist?.onFinishHydration(onChange) ?? (() => {});

const getHydrated = () => useAdminAuthStore.persist?.hasHydrated?.() ?? false;

export function useAdminHydrated(): boolean {
  return useSyncExternalStore(subscribeHydration, getHydrated, () => false);
}

/**
 * Whether the persisted session has been checked against the server.
 *
 * Module-scoped, so the check happens once per page load however many
 * components call the hook — and so it survives a re-render, which is what
 * lets the shell hold its children back until the answer is in.
 */
let checkStarted = false;
let settled = false;

/** Reset by a fresh sign-in: a new session is verified by definition. */
export function markSessionVerified(): void {
  checkStarted = true;
  settled = true;
}

/** The signed-in admin, with sign-in and sign-out. */
export function useAdminSession() {
  const hydrated = useAdminHydrated();
  const session = useAdminAuthStore((state) => state.session);
  const setSession = useAdminAuthStore((state) => state.setSession);
  const updateUser = useAdminAuthStore((state) => state.updateUser);

  // Re-rendered when the check finishes, so the shell can stop waiting.
  const [checked, setChecked] = useState(settled);

  /**
   * Confirm the stored session with the server.
   *
   * What local storage holds is who *was* signed in. The account may since
   * have been disabled or had its role changed, and the token expires — so the
   * portal asks, and drops the session if the answer is no. It is not a
   * security measure (the API refuses the request either way); it is what
   * stops the portal rendering a menu the person can no longer use.
   */
  useEffect(() => {
    if (!hydrated) return;

    if (session === null) {
      // Nothing to confirm. The guard redirects to the sign-in page.
      settled = true;
      setChecked(true);
      return;
    }

    if (checkStarted) {
      if (settled) setChecked(true);
      return;
    }

    checkStarted = true;

    void adminAuth.refreshSession().then((user) => {
      if (user) updateUser(user);
      else setSession(null);

      settled = true;
      setChecked(true);
    });
  }, [hydrated, session, setSession, updateUser]);

  const signIn = useCallback(
    async (credentials: AdminCredentials) => {
      const result = await adminAuth.signIn(credentials);
      if (result.ok) {
        // Just came from the server, so there is nothing to confirm — and the
        // shell must not wait on a check that will never run.
        markSessionVerified();
        setSession(result.data);
      }
      return result;
    },
    [setSession],
  );

  const signOut = useCallback(async () => {
    await adminAuth.signOut();
    toast.info("Signed out of the admin portal");
  }, []);

  const updateProfile = useCallback(
    (patch: Partial<AdminUser>) => {
      updateUser(patch);
      toast.success("Profile updated");
    },
    [updateUser],
  );

  const user = hydrated ? (session?.user ?? null) : null;

  return {
    user,
    isSignedIn: hydrated && session !== null,
    /**
     * True until the store has rehydrated **and** the stored session has been
     * confirmed. Guards must wait for it.
     *
     * Waiting for the confirmation, not just the rehydration, is what stops a
     * page firing all of its requests against a token that has expired: seven
     * calls that could only ever return 401, before the one call that was
     * going to find that out.
     */
    isLoading: !hydrated || !checked,
    signIn,
    signOut,
    updateProfile,
    /** UI convenience only; the API must enforce the same rule. */
    can: (permission: adminAuth.Permission) => adminAuth.can(user, permission),
  };
}
