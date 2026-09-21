"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AuthSession, User } from "@/types";

import { STORAGE_KEYS } from "@/lib/storage/local-storage";

interface SessionState {
  session: AuthSession | null;
  setSession: (session: AuthSession | null) => void;
  updateUser: (patch: Partial<User>) => void;
  signOut: () => void;
}

/**
 * The signed-in session.
 *
 * Mock only. A real backend should keep the token in an httpOnly cookie rather
 * than anywhere JavaScript can read it; at that point this store holds just
 * the user profile and `setSession` is fed by a `/auth/me` call.
 */
export const useSessionStore = create<SessionState>()(
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
      name: STORAGE_KEYS.session,
      version: 1,
      partialize: (state) => ({ session: state.session }),
    },
  ),
);
