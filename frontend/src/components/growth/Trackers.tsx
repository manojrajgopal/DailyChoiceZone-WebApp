"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { rememberReferralCode, trackEvent } from "@/services/growthService";

/**
 * In the storefront layout: records one visit per browsing session (the
 * server also keeps only one a day per visitor), and keeps a `?ref=` code
 * from a friend's link until the shopper signs up.
 */
export function VisitTracker() {
  const params = useSearchParams();
  const pathname = usePathname();
  const done = useRef(false);

  useEffect(() => {
    const ref = params.get("ref");
    if (ref) rememberReferralCode(ref);
  }, [params]);

  useEffect(() => {
    if (done.current || pathname.startsWith("/admin")) return;
    done.current = true;
    try {
      if (sessionStorage.getItem("dcz:visit")) return;
      sessionStorage.setItem("dcz:visit", "1");
    } catch {
      /* storage off: the server still de-duplicates */
    }
    trackEvent("visit", { utmSource: params.get("utm_source") ?? "" });
  }, [params, pathname]);

  return null;
}

/** On a product page: one product view. */
export function ProductViewTracker({ productId }: { productId: string }) {
  useEffect(() => {
    trackEvent("product_view", { productId });
  }, [productId]);
  return null;
}

/** On checkout: checkout opened. */
export function CheckoutTracker() {
  useEffect(() => {
    trackEvent("checkout_start");
  }, []);
  return null;
}
