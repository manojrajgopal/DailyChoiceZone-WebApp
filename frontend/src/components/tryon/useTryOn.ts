"use client";

import { useEffect, useState } from "react";

import type { Product } from "@/types";

import { type TryOnCatalogue, type TryOnState, type TryOnCapability, getTryOnCatalogue, tryOnFor } from "@/services/tryOnService";

/**
 * The try-on catalogue, shared by every button and badge on the page — one
 * request however many product cards ask. Null while it loads, or when it
 * can't be loaded (try-on then simply doesn't show).
 */
export function useTryOnCatalogue(): TryOnCatalogue | null {
  const [catalogue, setCatalogue] = useState<TryOnCatalogue | null>(null);
  useEffect(() => {
    let active = true;
    getTryOnCatalogue().then(
      (value) => active && setCatalogue(value),
      () => active && setCatalogue(null),
    );
    return () => {
      active = false;
    };
  }, []);
  return catalogue;
}

/** Whether (and how) one product can be tried on. */
export function useTryOnState(
  product: Pick<Product, "id" | "category" | "subcategory">,
): { capability: TryOnCapability | null; state: TryOnState; ready: boolean } {
  const catalogue = useTryOnCatalogue();
  return { ...tryOnFor(product, catalogue), ready: catalogue !== null };
}

/** An object URL for a private image, revoked when the component lets go of it. */
export function useObjectUrl(load: (() => Promise<string>) | null, deps: readonly unknown[]): {
  url: string | null;
  failed: boolean;
} {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key: string; url: string | null; failed: boolean }>({ key: "", url: null, failed: false });
  useEffect(() => {
    if (!load) return;
    let active = true;
    let created: string | null = null;
    load().then(
      (url) => {
        created = url;
        if (active) setState({ key, url, failed: false });
        else URL.revokeObjectURL(url);
      },
      () => active && setState({ key, url: null, failed: true }),
    );
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  // A result for other inputs (or none asked for) is not this one's.
  return load && state.key === key ? { url: state.url, failed: state.failed } : { url: null, failed: false };
}
