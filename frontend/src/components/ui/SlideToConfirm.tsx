"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronsRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/** How far, as a share of the track, the handle must travel to count. */
const THRESHOLD = 0.9;

/**
 * "Slide to place order" — a deliberate gesture for a commitment a tap could
 * make by accident (cash on delivery places the order with no payment step
 * after it).
 *
 * Works without a pointer, too: the handle is a `slider` that the keyboard
 * moves with the arrow keys, Home and End, and Enter or Space completes, so a
 * keyboard or screen-reader user commits with one deliberate key press.
 * Letting go short of the end springs it back. `busy` holds it at the end
 * with a spinner; when `busy` clears without success (the order was refused),
 * it returns to the start so they can try again.
 */
export function SlideToConfirm({
  label,
  busyLabel = "Working…",
  onConfirm,
  disabled = false,
  busy = false,
  className,
}: {
  label: string;
  busyLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; offset: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);
  // How far the handle can travel, measured (and re-measured on resize).
  const [travel, setTravel] = useState(1);

  useEffect(() => {
    const measure = () =>
      setTravel(Math.max(1, (track.current?.clientWidth ?? 0) - (handle.current?.offsetWidth ?? 0) - 8));
    measure();
    if (typeof ResizeObserver === "undefined" || !track.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(track.current);
    return () => observer.disconnect();
  }, []);

  const max = () => travel;
  const progress = done || busy ? 1 : Math.min(1, offset / travel);

  // Refused or failed — `busy` came on and went off again — back to the start.
  // If the caller never reports busy at all (it refused straight away), the
  // handle comes back after a moment rather than staying stuck at the end.
  const sawBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      sawBusy.current = true;
      return;
    }
    if (!done) return;
    const timer = setTimeout(() => {
      sawBusy.current = false;
      setDone(false);
      setOffset(0);
    }, sawBusy.current ? 0 : 1500);
    return () => clearTimeout(timer);
  }, [busy, done]);

  const complete = () => {
    if (disabled || busy || done) return;
    setDone(true);
    setOffset(max());
    onConfirm();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || busy || done) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = { x: event.clientX, offset };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    setOffset(Math.max(0, Math.min(max(), start.current.offset + event.clientX - start.current.x)));
  };

  const onPointerUp = () => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    if (offset / max() >= THRESHOLD) complete();
    else setOffset(0);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || busy || done) return;
    const step = max() / 4;
    if (event.key === "Enter" || event.key === " " || event.key === "End") {
      event.preventDefault();
      complete();
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.min(max(), offset + step);
      if (next / max() >= THRESHOLD) complete();
      else setOffset(next);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "Home") {
      event.preventDefault();
      setOffset(event.key === "Home" ? 0 : Math.max(0, offset - step));
    }
  };

  return (
    <div
      ref={track}
      className={cn(
        "relative h-14 w-full select-none overflow-hidden rounded-pill border border-ink bg-ink text-cream",
        (disabled && !busy) && "opacity-50",
        className,
      )}
    >
      {/* What's behind the handle fills as it moves, so progress is visible. */}
      <div
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 bg-copper-600", !dragging && "transition-[width] duration-200 ease-out")}
        style={{ width: `calc(${progress * 100}% + ${progress < 1 ? 28 : 0}px)` }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center pl-14 pr-4 text-sm font-medium"
      >
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
            {busyLabel}
          </span>
        ) : (
          <span className={cn("transition-opacity", progress > 0.4 && "opacity-0")}>{label}</span>
        )}
      </span>
      <div
        ref={handle}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-valuetext={busy ? busyLabel : done ? "Confirmed" : `${label}: press Enter, or slide to the end`}
        aria-disabled={disabled || busy}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className={cn(
          "absolute left-1 top-1 inline-flex h-12 w-12 touch-none items-center justify-center rounded-pill bg-cream text-ink shadow-md",
          "outline-none focus-visible:ring-2 focus-visible:ring-copper-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink",
          disabled || busy ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing",
          !dragging && "transition-transform duration-200 ease-out motion-reduce:transition-none",
        )}
        style={{ transform: `translateX(${done || busy ? travel : offset}px)` }}
      >
        <ChevronsRight className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
      </div>
    </div>
  );
}
