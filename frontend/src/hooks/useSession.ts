"use client";

import { useCallback } from "react";

import type { Credentials, RegisterInput, User } from "@/types";

import * as authService from "@/services/authService";
import { useSessionStore } from "@/store/sessionStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";

/**
 * The signed-in customer.
 *
 * Mock authentication — see `authService`. The shape is what a real auth
 * integration would expose, so swapping the service out will not touch the
 * account pages.
 */
export function useSession() {
  const hydrated = useHydrated();
  const session = useSessionStore((state) => state.session);
  const setSession = useSessionStore((state) => state.setSession);
  const updateUser = useSessionStore((state) => state.updateUser);
  const clearSession = useSessionStore((state) => state.signOut);

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
