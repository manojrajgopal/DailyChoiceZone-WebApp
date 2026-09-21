"use client";

import { useSyncExternalStore } from "react";

/** Nothing ever changes, so the subscription is a no-op. */
const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Whether the client has taken over rendering.
 *
 * Anything driven by `localStorage` — cart badge, wishlist hearts, recently
 * viewed — cannot be rendered during SSR, because the server has no access to
 * it and React would flag the mismatch. Gating on this hook means the first
 * client render matches the server's, and the persisted value appears on the
 * very next paint.
 *
 * Implemented with `useSyncExternalStore` rather than `useState` plus an
 * effect: the two snapshot functions express "false on the server, true on the
 * client" directly, which is exactly the question being asked, and it avoids
 * the cascading render that setting state inside an effect causes.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}
