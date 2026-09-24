"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AdminSession, AdminUser } from "@/types/admin";

/** Where the session is persisted. Namespaced like every other key this app uses. */
const STORAGE_KEY = "dcz:admin:session";

interface AdminAuthState {
  session: AdminSession | null;
  setSession: (session: AdminSession | null) => void;
  updateUser: (patch: Partial<AdminUser>) => void;
  signOut: () => void;
}

/**
 * The signed-in admin.
 *
 * Persisted so a refresh does not bounce somebody back to the login screen.
 * What it holds is a *claim*, not an authorisation: the API validates the
 * bearer token on every request, and `useAdminSession` re-checks this session
 * against `/admin/auth/me` once per page load so a disabled account stops
 * seeing a portal it can no longer use.
 */
export const useAdminAuthStore = create<AdminAuthState>()(
  persist(
    (set, get) => ({
      session: null,

      setSession: (session) => set({ session }),

      updateUser: (patch) => {
        const current = get().session;
        if (!current) return;
        set({ session: { ...current, user: { ...current.user, ...patch } } });
      },

      signOut: () => set({ session: null }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      partialize: (state) => ({ session: state.session }),
    },
  ),
);
