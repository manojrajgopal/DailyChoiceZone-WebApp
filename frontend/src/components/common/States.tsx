"use client";

import Link from "next/link";
import { PackageOpen, RefreshCw, SearchX, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";

/**
 * Empty and error states.
 *
 * A storefront should never show a blank region. Each of these says what
 * happened and offers the one action most likely to help, rather than an
 * apology with no way forward.
 */

const ICONS = {
  empty: PackageOpen,
  search: SearchX,
  error: TriangleAlert,
} as const;

export interface EmptyStateProps {
  icon?: keyof typeof ICONS;
  title: string;
  description?: string;
  /** Primary action, usually a route back into the catalogue. */
  action?: { label: string; href: string };
  /** Secondary action, e.g. "Clear filters". */
  secondaryAction?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({
  icon = "empty",
  title,
  description,
  action,
  secondaryAction,
  className,
}: EmptyStateProps) {
  const Icon = ICONS[icon];

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center sm:py-24",
        className,
      )}
    >
      <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-pill bg-cream-deep">
        <Icon className="h-6 w-6 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
      </span>

      <h2 className="font-display text-xl text-ink">{title}</h2>

      {description ? (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-500">{description}</p>
      ) : null}

      {action || secondaryAction ? (
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          {action ? (
            <Link
              href={action.href}
              className="inline-flex h-11 items-center justify-center rounded-control bg-ink px-6 label-wide text-cream transition-colors hover:bg-ink-700"
            >
              {action.label}
            </Link>
          ) : null}

          {secondaryAction ? (
            <Button variant="outline" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description = "We could not load this just now. Please try again.",
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center sm:py-20",
        className,
      )}
    >
      <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-pill bg-danger-bg">
        <TriangleAlert className="h-6 w-6 text-danger" strokeWidth={1.5} aria-hidden="true" />
      </span>

      <h2 className="font-display text-xl text-ink">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-500">{description}</p>

      {onRetry ? (
        <Button variant="outline" className="mt-7" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
