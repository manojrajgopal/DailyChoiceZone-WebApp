"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/** The four checkout steps, in order. */
export const CHECKOUT_STEPS = [
  { href: "/checkout", label: "Contact" },
  { href: "/checkout/address", label: "Delivery" },
  { href: "/checkout/payment", label: "Payment" },
  { href: "/checkout/review", label: "Review" },
] as const;

/**
 * The checkout progress indicator.
 *
 * Completed steps link backwards so someone can correct a typo without
 * restarting; steps ahead are not links, because reaching them out of order
 * would leave the order incomplete. `aria-current` marks where they are.
 */
export function CheckoutSteps() {
  const pathname = usePathname();
  const activeIndex = Math.max(
    0,
    CHECKOUT_STEPS.findIndex((step) => step.href === pathname),
  );

  return (
    <nav aria-label="Checkout progress">
      <ol className="flex items-center gap-1.5 sm:gap-3">
        {CHECKOUT_STEPS.map((step, index) => {
          const isDone = index < activeIndex;
          const isActive = index === activeIndex;

          const content = (
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill text-[0.6875rem] font-medium tabular-nums transition-colors",
                  isDone
                    ? "bg-sage-500 text-white"
                    : isActive
                      ? "bg-ink text-cream"
                      : "bg-ink-100 text-ink-400",
                )}
              >
                {isDone ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </span>

              <span
                className={cn(
                  "hidden label-wide sm:inline",
                  isActive ? "text-ink" : isDone ? "text-ink-700" : "text-ink-400",
                )}
              >
                {step.label}
              </span>
            </span>
          );

          return (
            <li key={step.href} className="flex items-center gap-1.5 sm:gap-3">
              {isDone ? (
                <Link
                  href={step.href}
                  className="rounded-control transition-opacity hover:opacity-75"
                >
                  {content}
                </Link>
              ) : (
                <span aria-current={isActive ? "step" : undefined}>{content}</span>
              )}

              {index < CHECKOUT_STEPS.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-px w-5 sm:w-10",
                    index < activeIndex ? "bg-sage-500" : "bg-ink-200",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
