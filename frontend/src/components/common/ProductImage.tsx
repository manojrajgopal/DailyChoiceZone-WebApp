"use client";

import Image from "next/image";
import { useState } from "react";

import { cn } from "@/lib/utils/cn";

export interface ProductImageProps {
  src: string | undefined;
  alt: string;
  /** Passed to next/image so the browser can pick a sensible candidate. */
  sizes?: string;
  priority?: boolean;
  className?: string;
  /** Applied to the wrapper, which owns the aspect ratio. */
  wrapperClassName?: string;
  /** Inline styles for the image element — used for cursor-tracked zoom. */
  style?: React.CSSProperties;
}

/**
 * A product photo that cannot break the layout.
 *
 * Dummy imagery is currently served from Unsplash, so a URL may 404 or the
 * network may simply be unavailable. Rather than leaving a torn image icon in
 * the middle of a grid, a failure falls back to an on-brand placeholder that
 * looks deliberate.
 *
 * When real images move to a CDN, only `products.json` and the `remotePatterns`
 * entry in `next.config.ts` change — this component does not.
 */
export function ProductImage({
  src,
  alt,
  sizes = "(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw",
  priority = false,
  className,
  wrapperClassName,
  style,
}: ProductImageProps) {
  const [failed, setFailed] = useState(false);
  const showFallback = !src || failed;

  return (
    <span
      // The background is a placeholder for while the photograph loads, and it
      // is OPAQUE. If you stack one of these over another, fade the wrapper
      // rather than the inner image — fading only the image leaves this
      // background covering whatever is underneath.
      className={cn(
        "relative block overflow-hidden bg-cream-deep",
        wrapperClassName,
      )}
    >
      {showFallback ? (
        <span
          className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-cream-deep via-sand to-blush-100"
          aria-hidden="true"
        >
          <span className="px-4 text-center font-display text-sm text-copper-700/70">
            Daily Choice Zone
          </span>
        </span>
      ) : (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          onError={() => setFailed(true)}
          style={style}
          className={cn("object-cover", className)}
        />
      )}
    </span>
  );
}
