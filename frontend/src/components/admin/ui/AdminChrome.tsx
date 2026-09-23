"use client";

import Link from "next/link";
import { AlertTriangle, ChevronRight, Loader2 } from "lucide-react";

import { Modal } from "@/components/ui/Dialog";
import { cn } from "@/lib/utils/cn";

/**
 * Small shared pieces of admin page furniture: buttons, cards, page headers,
 * breadcrumbs and the confirmation dialog.
 *
 * These are deliberately separate from the storefront's UI kit. The storefront
 * is editorial — serif headings, generous spacing, uppercase tracked labels.
 * The admin is dense and read for hours, so it wants smaller radii, tighter
 * rhythm and sentence-case labels. Sharing one Button between them would mean
 * one of the two always looking slightly wrong.
 */

/* ------------------------------------------------------------------ buttons */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-copper-600 text-white hover:bg-copper-700 disabled:bg-copper-300",
  secondary:
    "border border-admin-border-strong bg-admin-surface text-admin-ink hover:bg-admin-raised disabled:text-admin-faint",
  ghost: "text-admin-ink hover:bg-admin-raised disabled:text-admin-faint",
  danger: "bg-[#c23434] text-white hover:bg-[#a32c2c] disabled:bg-[#c23434]/40",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-9 px-4 text-[0.8125rem] gap-2",
};

const BUTTON_BASE =
  "inline-flex items-center justify-center rounded-[3px] font-medium transition-colors " +
  "disabled:cursor-not-allowed whitespace-nowrap";

export interface AdminButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  className?: string;
}

export function AdminButton({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  children,
  className,
  type = "button",
  ...rest
}: AdminButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(BUTTON_BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function AdminButtonLink({
  variant = "secondary",
  size = "md",
  href,
  children,
  className,
}: {
  variant?: Variant;
  size?: Size;
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={cn(BUTTON_BASE, VARIANTS[variant], SIZES[size], className)}>
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------------- cards */

export function AdminCard({
  title,
  description,
  action,
  padded = true,
  children,
  className,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  /** Turn off for a card whose child is a table and owns its own padding. */
  padded?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        // `min-w-0` matters: as a grid or flex item this would otherwise take
        // its content's intrinsic width, and a card holding a wide table would
        // stretch its track past the viewport instead of letting the table's
        // own `overflow-x-auto` scroll.
        "min-w-0 rounded-[3px] border border-admin-border bg-admin-surface",
        className,
      )}
    >
      {title ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-admin-border px-4 py-3">
          <div>
            <h2 className="font-sans text-sm font-semibold tracking-normal text-admin-ink">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-xs text-admin-muted">{description}</p>
            ) : null}
          </div>
          {action}
        </header>
      ) : null}

      <div className={padded ? "p-4" : undefined}>{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------- page header */

export interface Crumb {
  label: string;
  href?: string;
}

export function AdminPageHeader({
  title,
  description,
  breadcrumbs,
  actions,
}: {
  title: string;
  description?: string;
  breadcrumbs?: Crumb[];
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-6">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-admin-muted">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {crumb.href && !isLast ? (
                    <Link href={crumb.href} className="transition-colors hover:text-admin-ink">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={isLast ? "page" : undefined} className="text-admin-ink">
                      {crumb.label}
                    </span>
                  )}
                  {!isLast ? (
                    <ChevronRight className="h-3 w-3 text-admin-faint" aria-hidden="true" />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-sans text-xl font-semibold tracking-tight text-admin-ink">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-admin-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------ confirmation */

/**
 * A confirmation dialog.
 *
 * Destructive admin actions never fire straight from a click — deleting a
 * product or an order is not undoable in a mock store, so the pause is the
 * only safety net there is.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = "Delete",
  destructive = true,
  loading = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} className="max-w-md">
      <div className="flex items-start gap-3">
        {destructive ? (
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] bg-[#fbeaea]">
            <AlertTriangle className="h-4 w-4 text-[#c23434]" strokeWidth={1.75} aria-hidden="true" />
          </span>
        ) : null}
        <div className="text-sm leading-relaxed text-admin-muted">{message}</div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <AdminButton variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
          Cancel
        </AdminButton>
        <AdminButton
          variant={destructive ? "danger" : "primary"}
          onClick={onConfirm}
          loading={loading}
        >
          {confirmLabel}
        </AdminButton>
      </div>
    </Modal>
  );
}
