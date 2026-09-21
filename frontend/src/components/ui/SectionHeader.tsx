import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  /** Renders the "View all" link when provided. */
  viewAllHref?: string;
  viewAllLabel?: string;
  /** Use h1 on pages where this is the main heading. */
  as?: "h1" | "h2";
  id?: string;
  className?: string;
}

/**
 * The heading that opens every homepage rail and listing section.
 *
 * One component so the serif/label rhythm — small copper eyebrow, serif
 * headline, quiet "view all" — is identical everywhere, which is most of what
 * makes a storefront feel designed rather than assembled.
 */
export function SectionHeader({
  title,
  subtitle,
  viewAllHref,
  viewAllLabel = "View all",
  as: Heading = "h2",
  id,
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-2", className)}>
      <div className="min-w-0">
        {subtitle ? (
          <p className="label-wide mb-2 text-copper-600">{subtitle}</p>
        ) : null}
        <Heading
          id={id}
          className="font-display text-[1.375rem] leading-tight text-ink sm:text-[1.75rem]"
        >
          {title}
        </Heading>
      </div>

      {viewAllHref ? (
        <Link
          href={viewAllHref}
          className="group inline-flex items-center gap-1.5 border-b border-ink pb-0.5 label-wide text-ink transition-colors hover:border-copper-600 hover:text-copper-700"
        >
          {viewAllLabel}
          <ArrowRight
            className="h-3.5 w-3.5 transition-transform duration-200 ease-brand group-hover:translate-x-0.5"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Link>
      ) : null}
    </div>
  );
}
