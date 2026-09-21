"use client";

import { create } from "zustand";

export type ToastTone = "success" | "info" | "error";

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
  /** Optional inline action, e.g. "View cart". */
  action?: { label: string; href: string };
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
}

/**
 * Notifications.
 *
 * Not persisted — a toast is about something that just happened, so surviving
 * a reload would be wrong. Auto-dismissal is the Toaster component's job, not
 * the store's, so the timer lives with the thing that can also pause it on
 * hover.
 */
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (toast) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Cap the stack so a rapid series of clicks cannot bury the page.
    set({ toasts: [...get().toasts, { ...toast, id }].slice(-3) });
    return id;
  },

  dismiss: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
}));

/** Convenience wrappers so callers do not repeat the tone every time. */
export const toast = {
  success: (message: string, action?: Toast["action"]) =>
    useToastStore.getState().push({ message, tone: "success", action }),
  info: (message: string, action?: Toast["action"]) =>
    useToastStore.getState().push({ message, tone: "info", action }),
  error: (message: string, action?: Toast["action"]) =>
    useToastStore.getState().push({ message, tone: "error", action }),
};
