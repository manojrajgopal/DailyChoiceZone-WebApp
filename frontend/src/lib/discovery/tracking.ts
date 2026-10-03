"use client";

import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

import { trackEvent, type TrackedEvent } from "@/services/growthService";

/**
 * Measuring the discovery rails — through the store's own analytics events
 * (`/analytics/events`), not a second system. The server keeps one event per
 * visitor, product and kind every few minutes, so these can be generous.
 */

/** The product id in a product link: `/product/PRD012?color=Navy` → `PRD012`. */
export function productIdFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const match = /\/product\/([^/?#]+)/.exec(href);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * An `onClickCapture` handler for a rail: whichever product link inside it is
 * followed, report it. Event delegation, so the cards need no changes.
 */
export function clickTracker(event: Extract<TrackedEvent, "recommendation_click" | "recently_viewed_click">,
  placement: string) {
  return (click: ReactMouseEvent<HTMLElement>) => {
    const link = (click.target as HTMLElement | null)?.closest?.("a[href]");
    const productId = productIdFromHref(link?.getAttribute("href"));
    if (productId) trackEvent(event, { productId, placement });
  };
}

const SEEN_KEY = "dcz:rec-seen";

function seenThisSession(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function remember(seen: Set<string>): void {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    /* storage off: the server de-duplicates anyway */
  }
}

/**
 * Report a rail's products as seen, once, when the rail first scrolls into
 * view — and only once per product and rail per browsing session.
 */
export function useImpressions(placement: string, productIds: string[], max = 8) {
  const ref = useRef<HTMLDivElement | null>(null);
  const key = productIds.slice(0, max).join(",");

  useEffect(() => {
    const element = ref.current;
    if (!element || key === "" || typeof IntersectionObserver === "undefined") return;

    let done = false;
    const observer = new IntersectionObserver((entries) => {
      if (done || !entries.some((entry) => entry.isIntersecting)) return;
      done = true;
      observer.disconnect();
      const seen = seenThisSession();
      for (const productId of key.split(",")) {
        const mark = `${placement}:${productId}`;
        if (seen.has(mark)) continue;
        seen.add(mark);
        trackEvent("recommendation_impression", { productId, placement });
      }
      remember(seen);
    }, { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [placement, key]);

  return ref;
}
