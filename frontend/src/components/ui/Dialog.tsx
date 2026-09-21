"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Modals and drawers.
 *
 * Built on Radix rather than hand-rolled, because the parts that matter here
 * are the parts that are easy to get wrong: focus is trapped while open and
 * restored on close, Escape and outside-clicks dismiss, the rest of the page
 * is hidden from assistive tech, and body scroll is locked.
 *
 * Enter and exit animations are CSS keyframes keyed off Radix's
 * `data-state` attribute — Radix waits for the exit animation before
 * unmounting, so no animation library is needed for this.
 */

interface BaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: it labels the dialog for assistive technology. */
  title: string;
  /** Hide the title visually while keeping it for screen readers. */
  hideTitle?: boolean;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

const OVERLAY =
  "fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px] " +
  "data-[state=open]:animate-[dcz-fade-in_200ms_var(--ease-brand)] " +
  "data-[state=closed]:animate-[dcz-fade-out_160ms_var(--ease-brand)]";

/**
 * Radix warns when a dialog renders no `Description`, because that is usually
 * an oversight. Passing `aria-describedby` explicitly as `undefined` is its
 * documented way to say "intentionally undescribed" — the title alone is
 * enough for a quick view or a filter sheet. When a description *is* supplied,
 * Radix wires the attribute up itself and this contributes nothing.
 */
function describedByProps(description?: string) {
  return description ? {} : { "aria-describedby": undefined };
}

function CloseButton({ className }: { className?: string }) {
  return (
    <RadixDialog.Close
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-pill text-ink",
        "transition-colors hover:bg-cream-deep",
        className,
      )}
      aria-label="Close"
    >
      <X className="h-4 w-4" strokeWidth={1.5} />
    </RadixDialog.Close>
  );
}

/** A centred modal. Used for quick view and confirmations. */
export function Modal({
  open,
  onOpenChange,
  title,
  hideTitle,
  description,
  children,
  className,
}: BaseProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY} />
        <RadixDialog.Content
          {...describedByProps(description)}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-3xl",
            "max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto",
            "rounded-card bg-shell shadow-overlay",
            "data-[state=open]:animate-[dcz-modal-in_240ms_var(--ease-brand)]",
            "data-[state=closed]:animate-[dcz-modal-out_160ms_var(--ease-brand)]",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 p-4 sm:p-5">
            <div className={cn(hideTitle && "sr-only")}>
              <RadixDialog.Title className="font-display text-lg text-ink">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-sm text-ink-500">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <CloseButton className="-mr-1 -mt-1 shrink-0" />
          </div>
          <div className="px-4 pb-5 sm:px-5">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

type Side = "left" | "right" | "bottom";

const SIDES: Record<Side, string> = {
  left:
    "inset-y-0 left-0 h-full w-[min(22rem,88vw)] " +
    "data-[state=open]:animate-[dcz-slide-in-left_280ms_var(--ease-brand)] " +
    "data-[state=closed]:animate-[dcz-slide-out-left_200ms_var(--ease-brand)]",
  right:
    "inset-y-0 right-0 h-full w-[min(26rem,90vw)] " +
    "data-[state=open]:animate-[dcz-slide-in-right_280ms_var(--ease-brand)] " +
    "data-[state=closed]:animate-[dcz-slide-out-right_200ms_var(--ease-brand)]",
  // A bottom sheet, for filters on mobile. Capped so the grid stays visible.
  bottom:
    "inset-x-0 bottom-0 max-h-[85dvh] w-full rounded-t-[1rem] " +
    "data-[state=open]:animate-[dcz-slide-in-bottom_300ms_var(--ease-brand)] " +
    "data-[state=closed]:animate-[dcz-slide-out-bottom_200ms_var(--ease-brand)]",
};

export interface DrawerProps extends BaseProps {
  side?: Side;
  /** Pinned to the bottom, outside the scroll area — e.g. "Show 48 results". */
  footer?: React.ReactNode;
}

/** A sheet anchored to an edge. Mobile nav, filters and the mini cart. */
export function Drawer({
  open,
  onOpenChange,
  title,
  hideTitle,
  description,
  side = "right",
  footer,
  children,
  className,
}: DrawerProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY} />
        <RadixDialog.Content
          {...describedByProps(description)}
          className={cn(
            "fixed z-50 flex flex-col bg-cream shadow-overlay",
            SIDES[side],
            className,
          )}
        >
          <div className="flex items-center justify-between gap-4 border-b border-ink-200 px-4 py-3.5">
            <div className={cn(hideTitle && "sr-only")}>
              <RadixDialog.Title className="label-wide text-ink">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-sm text-ink-500">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <CloseButton className="-mr-1 shrink-0" />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>

          {footer ? (
            <div className="border-t border-ink-200 bg-cream px-4 py-3">{footer}</div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
