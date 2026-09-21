"use client";

import { useRef, useState } from "react";

import { ProductImage } from "@/components/common/ProductImage";
import { cn } from "@/lib/utils/cn";

/**
 * The product gallery.
 *
 * Desktop gets thumbnail selection plus a hover zoom that tracks the cursor —
 * implemented by moving the image's `transform-origin` to the pointer and
 * scaling, which keeps it a single composited layer rather than a second
 * magnifier image.
 *
 * Mobile gets a horizontally swipeable, scroll-snapped strip with dots. That
 * is the native gesture, so it needs no touch handlers and cannot fight the
 * browser's own momentum scrolling.
 */
export function ProductGallery({ images, name }: { images: string[]; name: string }) {
  const [active, setActive] = useState(0);
  const [zooming, setZooming] = useState(false);
  const [origin, setOrigin] = useState("50% 50%");
  const stripRef = useRef<HTMLUListElement>(null);

  const gallery = images.length > 0 ? images : [""];
  const current = gallery[active] ?? gallery[0];

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    setOrigin(`${x}% ${y}%`);
  };

  /** Keep the dots in step with a swipe. */
  const onStripScroll = () => {
    const strip = stripRef.current;
    if (!strip) return;
    const index = Math.round(strip.scrollLeft / strip.clientWidth);
    setActive(Math.max(0, Math.min(gallery.length - 1, index)));
  };

  return (
    <div className="flex flex-col gap-4 lg:flex-row-reverse lg:gap-5">
      {/* ------------------------------------------------- desktop main image */}
      <div
        className="relative hidden flex-1 cursor-zoom-in overflow-hidden rounded-card bg-cream-deep lg:block"
        onPointerEnter={() => setZooming(true)}
        onPointerLeave={() => {
          setZooming(false);
          setOrigin("50% 50%");
        }}
        onPointerMove={onPointerMove}
      >
        <ProductImage
          src={current}
          alt={name}
          priority
          sizes="(min-width: 1024px) 45vw, 100vw"
          wrapperClassName="aspect-[3/4] w-full"
          // The origin follows the pointer, so the area under the cursor is
          // what grows — the behaviour people expect from a shop zoom.
          style={{ transformOrigin: origin }}
          className={cn(
            "transition-transform duration-300 ease-brand",
            zooming ? "scale-[1.7]" : "scale-100",
          )}
        />
      </div>

      {/* --------------------------------------------- mobile swipe strip */}
      {/*
        `min-w-0` matters: this sits inside a grid cell, and grid and flex
        items default to `min-width: auto`, which lets them grow to their
        content rather than clipping it.

        Slides are sized `w-full` — 100% of the scroll container — rather than
        `w-screen`. Viewport units ignore the container and include the
        scrollbar's width, so `w-screen` slides pushed the whole page into a
        horizontal scroll several screens wide.
      */}
      <div className="min-w-0 lg:hidden">
        <ul
          ref={stripRef}
          onScroll={onStripScroll}
          className="no-scrollbar flex w-full snap-x snap-mandatory overflow-x-auto"
          aria-label={`${name} images`}
        >
          {gallery.map((image, index) => (
            <li key={`${image}-${index}`} className="w-full shrink-0 snap-center">
              <ProductImage
                src={image}
                alt={index === 0 ? name : `${name} — view ${index + 1}`}
                priority={index === 0}
                sizes="100vw"
                wrapperClassName="aspect-[3/4] w-full rounded-card"
              />
            </li>
          ))}
        </ul>

        {gallery.length > 1 ? (
          <div className="mt-3 flex justify-center gap-1.5" aria-hidden="true">
            {gallery.map((image, index) => (
              <span
                key={`dot-${image}-${index}`}
                className={cn(
                  "h-1.5 rounded-pill transition-all duration-200",
                  index === active ? "w-5 bg-ink" : "w-1.5 bg-ink-300",
                )}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------ desktop thumbnails */}
      {gallery.length > 1 ? (
        <ul
          className="hidden shrink-0 flex-col gap-2.5 lg:flex"
          role="tablist"
          aria-label={`${name} images`}
        >
          {gallery.map((image, index) => (
            <li key={`thumb-${image}-${index}`}>
              <button
                type="button"
                role="tab"
                aria-selected={index === active}
                aria-label={`View image ${index + 1} of ${gallery.length}`}
                onClick={() => setActive(index)}
                className={cn(
                  "relative block h-24 w-20 overflow-hidden rounded-card border transition-colors",
                  index === active ? "border-ink" : "border-ink-200 hover:border-ink-400",
                )}
              >
                <ProductImage
                  src={image}
                  alt=""
                  sizes="80px"
                  wrapperClassName="absolute inset-0"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
