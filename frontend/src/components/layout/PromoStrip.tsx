"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { PromoBanner } from "@/types";
import { getBanners } from "@/services/siteService";

/**
 * The thin promotional strip above the header.
 *
 * It rotates through the configured messages rather than stacking them, which
 * keeps the storefront's first pixels for products. The rotation pauses when
 * the tab is hidden, and `prefers-reduced-motion` users get a static first
 * message instead of a cycling one.
 *
 * The strip is baked into every prerendered page, so the messages are re-read
 * once on mount: a banner switched on or scheduled to end in the portal takes
 * effect without a rebuild.
 */
export function PromoStrip({ banners: initial }: { banners: PromoBanner[] }) {
  const [banners, setBanners] = useState(initial);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let active = true;
    void getBanners().then((fresh) => {
      if (!active) return;
      setBanners(fresh);
      // A shorter list must not leave the rotation pointing past its end.
      setIndex(0);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (banners.length <= 1) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    const timer = setInterval(() => {
      // Skip advancing while the tab is in the background.
      if (document.hidden) return;
      setIndex((current) => (current + 1) % banners.length);
    }, 5000);

    return () => clearInterval(timer);
  }, [banners.length]);

  if (banners.length === 0) return null;

  const banner = banners[index] ?? banners[0];
  if (!banner) return null;

  return (
    <div className="border-b border-copper-700/20 bg-ink text-cream">
      <div className="page-shell flex h-9 items-center justify-center">
        {/* Polite, not assertive: a rotating promo must never interrupt. */}
        <p className="truncate text-center text-[0.6875rem] tracking-[0.1em] sm:text-xs" aria-live="polite">
          {banner.href ? (
            <Link href={banner.href} className="transition-opacity hover:opacity-80">
              {banner.message}
            </Link>
          ) : (
            banner.message
          )}
        </p>
      </div>
    </div>
  );
}
