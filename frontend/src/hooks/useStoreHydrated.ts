"use client";

import { useSyncExternalStore } from "react";

import { useCheckoutStore } from "@/store/checkoutStore";

/**
 * Whether the checkout store has finished reading local storage.
 *
 * This matters more than it looks. Checkout's step guards redirect anyone who
 * arrives without the previous step filled in — and if that check runs before
 * persisted state is restored, it sees empty values and bounces a shopper with
 * a perfectly good half-finished checkout back to step one. Refreshing the
 * payment page would lose your place.
 *
 * `useHydrated` is not sufficient here: it says the client has rendered, not
 * that the store has rehydrated. Zustand's own hydration signal is the only
 * thing that answers the actual question — and it is a subscribable external
 * store, so `useSyncExternalStore` fits it exactly.
 *
 * Both accesses are optional-chained: during prerendering there is no storage
 * to rehydrate from and zustand does not attach its `persist` API at all.
 * `false` is also the right server answer, keeping the guards inert until the
 * client says otherwise.
 */
const subscribe = (onChange: () => void) =>
  useCheckoutStore.persist?.onFinishHydration(onChange) ?? (() => {});

const getSnapshot = () => useCheckoutStore.persist?.hasHydrated?.() ?? false;

export function useCheckoutHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
