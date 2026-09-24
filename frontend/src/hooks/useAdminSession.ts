"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

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
 * Module-scoped, so it happens once per page load however many components
 * call the hook.
 */
let verified = false;

/** The signed-in admin, with sign-in and sign-out. */
export function useAdminSession() {
  const hydrated = useAdminHydrated();
  const session = useAdminAuthStore((state) => state.session);
  const setSession = useAdminAuthStore((state) => state.setSession);
  const updateUser = useAdminAuthStore((state) => state.updateUser);

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
    if (!hydrated || verified) return;
    verified = true;
    if (session === null) return;

    void adminAuth.refreshSession().then((user) => {
      if (user) updateUser(user);
      else setSession(null);
    });
  }, [hydrated, session, setSession, updateUser]);

  const signIn = useCallback(
    async (credentials: AdminCredentials) => {
      const result = await adminAuth.signIn(credentials);
      if (result.ok) {
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
    /** True until the store has rehydrated — guards must wait for this. */
    isLoading: !hydrated,
    signIn,
    signOut,
    updateProfile,
    /** UI convenience only; the API must enforce the same rule. */
    can: (permission: adminAuth.Permission) => adminAuth.can(user, permission),
  };
}
