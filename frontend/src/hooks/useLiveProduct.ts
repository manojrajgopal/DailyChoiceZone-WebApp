"use client";

import { useEffect, useState } from "react";

import type { Product } from "@/types";
import { getProductBySlug } from "@/services/productService";

/**
 * Keep a prerendered product honest about price and availability.
 *
 * Product pages are static HTML written at build time, which is right for
 * first paint and for search engines but means the page cannot know about a
 * catalogue change made since. Listing pages read the catalogue in the browser
 * and so pick those changes up; a detail page, left alone, would keep quoting
 * a price that is no longer current — and it is the buy box that decides what
 * goes into the bag, so a stale figure there is a wrong charge, not a cosmetic
 * lag.
 *
 * The fix is to start from the prerendered record and re-read once on mount.
 * The build-time value is what renders on the server and on the first client
 * pass, so there is no hydration mismatch; the fresher record replaces it
 * immediately afterwards.
 *
 * Against a real API this hook is where a cache-revalidation or a websocket
 * price feed would go, and the component above it needs no change.
 */
export function useLiveProduct(initial: Product): Product {
  const [product, setProduct] = useState(initial);

  useEffect(() => {
    let active = true;

    void getProductBySlug(initial.slug).then((fresh) => {
      // A product withdrawn since the build resolves to null. Keep showing the
      // prerendered copy rather than blanking the page — the stock and status
      // on the fresh record are what gate the Add to bag button anyway.
      if (active && fresh) setProduct(fresh);
    });

    return () => {
      active = false;
    };
  }, [initial.slug]);

  // A navigation to a different product must not show the previous one's
  // price while the re-read is in flight.
  return product.slug === initial.slug ? product : initial;
}
