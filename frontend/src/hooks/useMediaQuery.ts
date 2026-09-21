"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Track a CSS media query from JavaScript.
 *
 * Used only where layout genuinely cannot be expressed in CSS — swapping the
 * filter panel between a sidebar and a bottom sheet, which are different
 * components rather than the same one restyled. Anything purely visual should
 * stay in Tailwind's responsive variants instead.
 *
 * `useSyncExternalStore` is the right shape here: `matchMedia` *is* an
 * external store, with a subscription and a snapshot. It also gives a correct
 * server snapshot (`false`) without risking a hydration mismatch.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Matches Tailwind's `lg` breakpoint. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}
