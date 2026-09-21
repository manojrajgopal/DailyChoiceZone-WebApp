"use client";

import { useId, useState } from "react";
import { Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface AccordionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** Right-aligned hint, e.g. a count of applied filters. */
  meta?: React.ReactNode;
  className?: string;
}

/**
 * A disclosure section. Used for filter groups and product detail panels.
 *
 * Deliberately a button controlling a region rather than `<details>`: it needs
 * `aria-expanded` and `aria-controls` to pair with the styled +/- affordance,
 * and consistent behaviour across browsers.
 */
export function Accordion({
  title,
  children,
  defaultOpen = false,
  meta,
  className,
}: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const panelId = `${id}-panel`;

  return (
    <div className={cn("border-b border-ink-200", className)}>
      <h3>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-center justify-between gap-3 py-3.5 text-left transition-colors hover:text-copper-700"
        >
          <span className="label-wide text-ink">{title}</span>
          <span className="flex items-center gap-2">
            {meta}
            {open ? (
              <Minus className="h-4 w-4 shrink-0 text-ink-500" strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4 shrink-0 text-ink-500" strokeWidth={1.5} aria-hidden="true" />
            )}
          </span>
        </button>
      </h3>

      {/* Kept in the DOM but hidden, so in-page find still works. */}
      <div id={panelId} hidden={!open} className="pb-4">
        {children}
      </div>
    </div>
  );
}
