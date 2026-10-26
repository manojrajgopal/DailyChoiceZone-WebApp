"use client";

import { useId, useState } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Before and after, one over the other, with a handle to slide between them.
 * The handle is a real range input, so it works with a keyboard and a screen
 * reader as well as a finger or a mouse.
 */
export function CompareSlider({
  before,
  after,
  beforeLabel = "Your photo",
  afterLabel = "Try-on",
  className,
}: {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  className?: string;
}) {
  const [position, setPosition] = useState(50);
  const id = useId();

  return (
    <div className={cn("relative overflow-hidden rounded-card bg-cream-deep", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a private object URL, not an optimisable asset */}
      <img src={after} alt={afterLabel} className="block h-full w-full object-contain" />
      <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
        <img src={before} alt="" className="block h-full w-full object-contain" />
      </div>
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.15)]"
        style={{ left: `${position}%` }}
        aria-hidden="true"
      />
      <span className="pointer-events-none absolute left-2 top-2 rounded-control bg-ink/70 px-2 py-1 text-[0.6875rem] text-cream">
        {beforeLabel}
      </span>
      <span className="pointer-events-none absolute right-2 top-2 rounded-control bg-ink/70 px-2 py-1 text-[0.6875rem] text-cream">
        {afterLabel}
      </span>
      <label htmlFor={id} className="sr-only">
        Compare your photo with the try-on
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        value={position}
        onChange={(event) => setPosition(Number(event.target.value))}
        className="absolute inset-x-0 bottom-3 mx-auto w-[85%] accent-copper-500"
      />
    </div>
  );
}
