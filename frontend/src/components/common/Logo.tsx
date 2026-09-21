import Image from "next/image";
import Link from "next/link";

import { cn } from "@/lib/utils/cn";

import logoMark from "../../../public/brand/logo.png";

/**
 * The brand lockup.
 *
 * The supplied logo is a circular badge carrying a wordmark, a tagline and
 * three trust icons. That is a lot of detail, and below roughly 80px the inner
 * type stops being legible — so the disc is paired with a typographic wordmark
 * that repeats the logo's own pairing: the high-contrast serif of
 * "Daily Choice" above the wide-tracked sans of "ZONE".
 *
 * The artwork itself is never altered or recoloured — only the amount of
 * supporting type beside it changes with the available space.
 */

type Variant = "full" | "mark" | "stacked";

const MARK_SIZES = {
  sm: "h-9 w-9",
  md: "h-11 w-11",
  lg: "h-16 w-16",
  xl: "h-28 w-28",
} as const;

export interface LogoProps {
  /**
   * `full` — disc plus wordmark, for the header.
   * `mark` — disc alone, where space is tight.
   * `stacked` — large disc above the wordmark, for the footer.
   */
  variant?: Variant;
  size?: keyof typeof MARK_SIZES;
  /** Render as a link to the storefront. Off for the footer's own heading. */
  asLink?: boolean;
  className?: string;
}

function Wordmark({ align = "left" }: { align?: "left" | "center" }) {
  return (
    <span className={cn("flex flex-col leading-none", align === "center" && "items-center")}>
      <span className="font-display text-[1.0625rem] font-semibold tracking-tight text-ink sm:text-[1.1875rem]">
        Daily <span className="text-clay-500">Choice</span>
      </span>
      <span className="mt-0.5 text-[0.5625rem] font-medium uppercase tracking-[0.34em] text-ink-500">
        Zone
      </span>
    </span>
  );
}

export function Logo({ variant = "full", size = "md", asLink = true, className }: LogoProps) {
  const mark = (
    <Image
      src={logoMark}
      alt=""
      priority={variant !== "mark"}
      // The disc is decorative here; the adjacent text carries the name. On
      // the `mark` variant the link's aria-label does that job instead.
      aria-hidden="true"
      className={cn("shrink-0 rounded-pill object-contain", MARK_SIZES[size])}
      sizes="112px"
    />
  );

  const content =
    variant === "mark" ? (
      mark
    ) : variant === "stacked" ? (
      <span className="flex flex-col items-center gap-3">
        {mark}
        <Wordmark align="center" />
      </span>
    ) : (
      <span className="flex items-center gap-2.5">
        {mark}
        <Wordmark />
      </span>
    );

  if (!asLink) {
    return <span className={cn("inline-flex", className)}>{content}</span>;
  }

  return (
    <Link
      href="/"
      aria-label="Daily Choice Zone — home"
      className={cn(
        "inline-flex items-center rounded-control transition-opacity hover:opacity-90",
        className,
      )}
    >
      {content}
    </Link>
  );
}
