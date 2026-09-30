"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Briefcase,
  Bug,
  CircleHelp,
  CreditCard,
  Crown,
  FileText,
  Film,
  LifeBuoy,
  Loader2,
  MessageSquare,
  Package,
  Paperclip,
  RotateCcw,
  Shirt,
  Star,
  Truck,
  User,
  X,
} from "lucide-react";

import type { TicketAttachment, TicketStatus } from "@/services/supportService";

import { cn } from "@/lib/utils/cn";
import { ACCEPTED_FILES, checkFiles, formatBytes } from "@/lib/support/format";
import { toast } from "@/store/toastStore";

/* ------------------------------------------------------------------- icons */

/**
 * Category icons, by the name the store saves on the category. The tree is
 * configuration; only the drawing of each name lives here.
 */
const CATEGORY_ICONS: Record<string, typeof Package> = {
  package: Package,
  shirt: Shirt,
  truck: Truck,
  rotate: RotateCcw,
  card: CreditCard,
  crown: Crown,
  user: User,
  bug: Bug,
  briefcase: Briefcase,
  message: MessageSquare,
  help: CircleHelp,
};

export const CATEGORY_ICON_NAMES = Object.keys(CATEGORY_ICONS);

export function CategoryIcon({ name, className }: { name: string; className?: string }) {
  const Icon = CATEGORY_ICONS[name] ?? LifeBuoy;
  return <Icon className={className} strokeWidth={1.5} aria-hidden="true" />;
}

/* ------------------------------------------------------ customer statuses */

const CUSTOMER_TONES: Record<TicketStatus, string> = {
  submitted: "bg-cream-deep text-ink-700",
  triaged: "bg-cream-deep text-ink-700",
  assigned: "bg-blush-200 text-copper-800",
  acknowledged: "bg-blush-200 text-copper-800",
  "in-progress": "bg-blush-200 text-copper-800",
  "waiting-customer": "bg-clay-500 text-white",
  "waiting-internal": "bg-blush-200 text-copper-800",
  escalated: "bg-copper-100 text-copper-800",
  resolved: "bg-sage-100 text-sage-600",
  closed: "bg-ink-200 text-ink-700",
  reopened: "bg-cream-deep text-ink-700",
};

/** A request's status as the customer reads it. The label comes from the API. */
export function CustomerStatusBadge({ status, label, className }: { status: TicketStatus; label: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-control px-2 py-1 label-wide",
        CUSTOMER_TONES[status] ?? CUSTOMER_TONES.submitted,
        className,
      )}
    >
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ stars */

/** A 1–5 star input, keyboard-operable as a radio group. */
export function StarInput({
  value,
  onChange,
  label = "Your rating",
  size = "md",
}: {
  value: number;
  onChange: (value: number) => void;
  label?: string;
  size?: "md" | "lg";
}) {
  const [hover, setHover] = useState(0);
  const name = useId();
  const words = ["", "Very poor", "Poor", "Okay", "Good", "Excellent"];
  const shown = hover || value;

  return (
    <fieldset>
      <legend className="sr-only">{label}</legend>
      <div className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((star) => (
          <label key={star} className="cursor-pointer" onMouseEnter={() => setHover(star)}>
            <input
              type="radio"
              name={name}
              value={star}
              checked={value === star}
              onChange={() => onChange(star)}
              className="peer sr-only"
            />
            <span className="sr-only">
              {star} {star === 1 ? "star" : "stars"} — {words[star]}
            </span>
            <Star
              aria-hidden="true"
              strokeWidth={1.25}
              className={cn(
                "rounded-control transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-copper-500",
                size === "lg" ? "h-8 w-8" : "h-6 w-6",
                star <= shown ? "fill-copper-500 text-copper-500" : "text-ink-300",
              )}
            />
          </label>
        ))}
        <span className="ml-2 min-w-[5.5rem] text-sm text-ink-500" aria-live="polite">
          {words[shown]}
        </span>
      </div>
    </fieldset>
  );
}

/* ----------------------------------------------------------- file picker */

export interface FileLimits {
  maxFiles: number;
  maxSizeMb: number;
  maxVideoSizeMb: number;
}

/**
 * Choose files to attach, by button or by dropping them. Checked here for
 * type and size so a mistake is caught before the upload — the server checks
 * again, by the file's contents.
 */
export function AttachmentPicker({
  files,
  onChange,
  limits,
  hint,
  variant = "store",
  compact = false,
  disabled = false,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  limits: FileLimits;
  hint?: string;
  variant?: "store" | "admin";
  /** Just the button and chips — for a chat composer. */
  compact?: boolean;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const describedBy = useId();

  const add = (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const next = [...files, ...Array.from(picked)];
    const problem = checkFiles(next, limits);
    setError(problem);
    if (problem) {
      if (compact) toast.error(problem);
      return;
    }
    onChange(next);
  };

  const remove = (index: number) => {
    setError(null);
    onChange(files.filter((_, at) => at !== index));
  };

  const chips =
    files.length > 0 ? (
      <ul className={cn("flex flex-wrap gap-2", !compact && "mt-3")} aria-label="Files to attach">
        {files.map((file, index) => (
          <li
            key={`${file.name}-${index}`}
            className={cn(
              "flex max-w-full items-center gap-2 py-1 pl-2.5 pr-1 text-xs",
              variant === "admin"
                ? "rounded-[3px] border border-admin-border bg-admin-raised text-admin-ink"
                : "rounded-pill border border-ink-200 bg-shell text-ink-700",
            )}
          >
            <Paperclip className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span className="max-w-[12rem] truncate">{file.name}</span>
            <span className="shrink-0 tabular-nums opacity-60">{formatBytes(file.size)}</span>
            <button
              type="button"
              onClick={() => remove(index)}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill hover:bg-ink/10"
              aria-label={`Remove ${file.name}`}
            >
              <X className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    ) : null;

  const picker = (
    <input
      ref={input}
      type="file"
      multiple
      accept={ACCEPTED_FILES}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        add(event.target.files);
        event.target.value = "";
      }}
    />
  );

  if (compact) {
    return (
      <>
        {picker}
        <button
          type="button"
          disabled={disabled || files.length >= limits.maxFiles}
          onClick={() => input.current?.click()}
          className={cn(
            "inline-flex h-10 w-10 shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            variant === "admin"
              ? "rounded-[3px] text-admin-muted hover:bg-admin-raised hover:text-admin-ink"
              : "rounded-pill text-ink-500 hover:bg-cream-deep hover:text-ink",
          )}
          aria-label="Attach files"
          title={`Attach up to ${limits.maxFiles} files`}
        >
          <Paperclip className="h-4.5 w-4.5" strokeWidth={1.5} aria-hidden="true" />
        </button>
        {chips ? <div className="basis-full">{chips}</div> : null}
      </>
    );
  }

  return (
    <div>
      {picker}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled) add(event.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 border border-dashed px-4 py-6 text-center transition-colors",
          variant === "admin" ? "rounded-[3px]" : "rounded-card",
          dragging ? "border-copper-500 bg-copper-50" : "border-ink-300 bg-shell",
          disabled && "opacity-60",
        )}
      >
        <Paperclip className="h-5 w-5 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
        <p className="text-sm text-ink-700">
          <button
            type="button"
            disabled={disabled}
            onClick={() => input.current?.click()}
            aria-describedby={describedBy}
            className="font-medium text-copper-700 underline underline-offset-2 hover:text-ink disabled:cursor-not-allowed"
          >
            Choose files
          </button>{" "}
          or drop them here
        </p>
        <p id={describedBy} className="text-xs text-ink-400">
          Images, PDFs, text files or short videos · up to {limits.maxFiles} files, {limits.maxSizeMb} MB each
          {limits.maxVideoSizeMb !== limits.maxSizeMb ? ` (${limits.maxVideoSizeMb} MB for videos)` : ""}
        </p>
        {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {chips}
    </div>
  );
}

/* ------------------------------------------------------ attachment links */

type LinkFetcher = (id: number) => Promise<{ url: string }>;

// Signed links last five minutes on the server; reuse one for four.
const links = new Map<string, { url: string; until: number }>();

async function signedLink(scope: string, id: number, fetcher: LinkFetcher): Promise<string> {
  const key = `${scope}:${id}`;
  const cached = links.get(key);
  if (cached && cached.until > Date.now()) return cached.url;
  const { url } = await fetcher(id);
  links.set(key, { url, until: Date.now() + 4 * 60_000 });
  return url;
}

/**
 * One file on a message. Opening it asks the API for a short-lived link —
 * the file is never at a permanent public address. Images show a thumbnail.
 */
export function AttachmentChip({
  attachment,
  scope,
  fetchLink,
  variant = "store",
  onDark = false,
}: {
  attachment: TicketAttachment;
  /** Distinguishes the customer's links from the desk's in the cache. */
  scope: string;
  fetchLink: LinkFetcher;
  variant?: "store" | "admin";
  /** Sits on a dark message bubble. */
  onDark?: boolean;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!attachment.isImage) return;
    let active = true;
    signedLink(scope, attachment.id, fetchLink)
      .then((url) => active && setThumb(url))
      .catch(() => active && setThumb(null));
    return () => {
      active = false;
    };
  }, [attachment.id, attachment.isImage, scope, fetchLink]);

  const open = async () => {
    // Opened synchronously so a popup blocker sees a click, then pointed at the link.
    const tab = window.open("about:blank", "_blank");
    setOpening(true);
    try {
      const url = await signedLink(scope, attachment.id, fetchLink);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch {
      tab?.close();
      toast.error("We couldn't open that file. Please try again.");
    } finally {
      setOpening(false);
    }
  };

  const Icon = attachment.contentType.startsWith("video/") ? Film : FileText;

  if (attachment.isImage && thumb) {
    return (
      <button
        type="button"
        onClick={open}
        className={cn(
          "group relative block overflow-hidden border",
          variant === "admin" ? "rounded-[3px] border-admin-border" : "rounded-card border-ink-200",
        )}
        aria-label={`Open ${attachment.name}`}
      >
        {/* A signed, expiring link: next/image would try to optimise a URL that changes. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={thumb} alt={attachment.name} className="h-24 w-32 object-cover transition-transform group-hover:scale-[1.03]" />
        {attachment.internal ? (
          <span className="absolute left-1 top-1 rounded-[3px] bg-[#fdf3dd] px-1 text-[0.5625rem] font-medium text-[#8a5d00]">
            Internal
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={opening}
      className={cn(
        "inline-flex max-w-full items-center gap-2 border px-2.5 py-1.5 text-left text-xs transition-colors",
        variant === "admin"
          ? "rounded-[3px] border-admin-border bg-admin-surface text-admin-ink hover:border-admin-border-strong"
          : onDark
            ? "rounded-card border-cream/30 bg-cream/10 text-cream hover:bg-cream/20"
            : "rounded-card border-ink-200 bg-shell text-ink-700 hover:border-ink-400",
      )}
    >
      {opening ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      )}
      <span className="min-w-0 truncate">{attachment.name}</span>
      <span className="shrink-0 tabular-nums opacity-60">{formatBytes(attachment.size)}</span>
      {attachment.internal ? <span className="shrink-0 font-medium text-[#8a5d00]">Internal</span> : null}
    </button>
  );
}
