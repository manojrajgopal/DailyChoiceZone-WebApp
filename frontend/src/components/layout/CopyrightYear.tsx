"use client";

import { useHydrated } from "@/hooks/useHydrated";

/**
 * The current year, resolved in the browser.
 *
 * The footer is prerendered, and this site is exported as static HTML that may
 * not be rebuilt for months — so a year baked in at build time would quietly
 * go stale every January. Renders the build year first (harmless, and keeps
 * the markup stable for hydration), then corrects itself on the client.
 */
export function CopyrightYear() {
  const hydrated = useHydrated();
  return <>{hydrated ? new Date().getFullYear() : ""}</>;
}
