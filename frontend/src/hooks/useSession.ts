"use client";

import { useCallback, useEffect } from "react";

import type { Credentials, RegisterInput, User } from "@/types";

import * as authService from "@/services/authService";
import { useSessionStore } from "@/store/sessionStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";

/**
 * Whether the stored session has been checked against the server.
 *
 * Module-scoped, so it happens once per page load however many components
 * call the hook.
 */
let verified = false;

/**
 * The signed-in customer.
 *
 * What local storage holds is who *was* signed in. The token behind it
 * expires, so the hook asks the server once per page load and drops the
 * session if the answer is no — otherwise the account area renders a
 * signed-in shell whose every figure comes back empty.
 */
export function useSession() {
  const hydrated = useHydrated();
  const session = useSessionStore((state) => state.session);
  const setSession = useSessionStore((state) => state.setSession);
  const updateUser = useSessionStore((state) => state.updateUser);
  const clearSession = useSessionStore((state) => state.signOut);

  useEffect(() => {
    if (!hydrated || verified) return;
    verified = true;
    if (session === null) return;

    void authService.getCurrentUser().then((user) => {
      if (user) updateUser(user);
      else clearSession();
    });
  }, [hydrated, session, updateUser, clearSession]);

  const signIn = useCallback(
    async (credentials: Credentials) => {
      const result = await authService.signIn(credentials);
      if (result.ok) {
        setSession(result.session);
        toast.success(`Welcome back, ${result.session.user.firstName}`);
      } else {
        toast.error(result.reason);
      }
      return result;
    },
    [setSession],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const result = await authService.register(input);
      if (result.ok) {
        setSession(result.session);
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
    signOut,
    updateProfile,
  };
}
