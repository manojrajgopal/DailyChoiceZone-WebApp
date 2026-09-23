"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AdminSession, AdminUser } from "@/types/admin";

import { OVERLAY_KEYS } from "@/lib/admin/mock-store";

interface AdminAuthState {
  session: AdminSession | null;
  setSession: (session: AdminSession | null) => void;
  updateUser: (patch: Partial<AdminUser>) => void;
  signOut: () => void;
}

/**
 * The signed-in admin.
 *
 * Mock only — see `adminAuthService` for why this provides no security. It is
 * persisted under the same key the service writes, so a page refresh keeps the
 * admin signed in and the two never disagree about who is logged on.
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
      name: OVERLAY_KEYS.session,
      version: 1,
      partialize: (state) => ({ session: state.session }),
    },
  ),
);
