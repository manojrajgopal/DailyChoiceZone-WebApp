"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

import { formatMoney } from "@/lib/money";
import {
  adminLookupHref,
  entityHref,
  idLabel as labelFor,
  isLookupEntity,
  type LookupEntity,
  type LookupScope,
} from "@/lib/lookup/entities";
import { lookupErrorMessage } from "@/lib/lookup/errors";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatNumber, humanize } from "@/lib/utils/format";
import { resolveId, type IdPreview, type IdPreviewField } from "@/services/lookupService";

/**
 * The record behind one ID, in short (docs/id-lookup.md).
 *
 * Fetched by exact ID once the ID is chosen — never from the suggestion list,
 * which carries IDs only. Shows the main facts the backend chose for the
 * entity, the IDs it points at (each opens its own preview), and the way to
 * the record's full screen.
 */

export interface IdPreviewCardProps {
  entity: LookupEntity;
  id: string;
  scope?: LookupScope;
  tone?: "admin" | "store";
  /** "Selected Product" by default. */
  heading?: string;
  onChange?: () => void;
  onClear?: () => void;
  /** Hide the "View full details" link (e.g. on the record's own screen). */
  hideDetailsLink?: boolean;
  /** Told once the preview arrives (or fails, with null). */
  onLoaded?: (preview: IdPreview | null) => void;
  className?: string;
}

function show(field: IdPreviewField): string {
  switch (field.format) {
    case "money":
      return formatMoney(Number(field.value), { showDecimals: true });
    case "number":
      return formatNumber(Number(field.value));
    case "date":
      return formatDate(String(field.value));
    default:
      return String(field.value);
  }
}

const TONES = {
  admin: {
    card: "rounded-[3px] border border-admin-border bg-admin-surface",
    heading: "text-[0.625rem] font-medium uppercase tracking-[0.12em] text-admin-faint",
    id: "font-mono text-[0.8125rem] font-medium text-admin-ink",
    title: "text-sm font-medium text-admin-ink",
    muted: "text-xs text-admin-muted",
    term: "text-[0.6875rem] text-admin-muted",
    value: "text-xs text-admin-ink",
    chip: "rounded-[3px] border border-admin-border px-1.5 py-0.5 font-mono text-[0.6875rem] text-admin-ink hover:border-copper-500",
    button:
      "inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-admin-border px-2.5 text-xs text-admin-ink hover:bg-admin-raised",
    status: "rounded-[3px] bg-admin-raised px-1.5 py-0.5 text-[0.6875rem] text-admin-ink",
    error: "text-xs text-[#c23434]",
  },
  store: {
    card: "rounded-card border border-ink-200 bg-shell",
    heading: "label-wide text-ink-400",
    id: "font-mono text-sm font-medium text-ink",
    title: "text-base text-ink",
    muted: "text-sm text-ink-400",
    term: "text-xs text-ink-400",
    value: "text-sm text-ink",
    chip: "rounded-control border border-ink-200 px-2 py-0.5 font-mono text-xs text-ink hover:border-copper-500",
    button:
      "inline-flex h-9 items-center gap-1.5 rounded-control border border-ink-200 px-3 text-sm text-ink hover:bg-cream-deep",
    status: "rounded-control bg-cream-deep px-2 py-0.5 text-xs text-ink",
    error: "text-sm text-danger",
  },
} as const;

export function IdPreviewCard({
  entity,
  id,
  scope = "admin",
  tone = "admin",
  heading,
  onChange,
  onClear,
  hideDetailsLink = false,
  onLoaded,
  className,
}: IdPreviewCardProps) {
  const styles = TONES[tone];
  const label = labelFor(entity);
  const [state, setState] = useState<{ id: string; preview: IdPreview | null; error: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    resolveId(scope, entity, id, { signal: controller.signal, fresh: attempt > 0 })
      .then((preview) => {
        if (controller.signal.aborted) return;
        setState({ id, preview, error: null });
        onLoaded?.(preview);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ id, preview: null, error });
        onLoaded?.(null);
      });
    return () => controller.abort();
    // onLoaded is a notification, not an input: a new callback must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, entity, id, attempt]);

  const current = state?.id === id ? state : null;
  const preview = current?.preview ?? null;
  const loading = current === null;
  const href = preview && !hideDetailsLink ? entityHref(scope, entity, preview.key, preview.id) : undefined;

  return (
    <section
      aria-label={`${heading ?? `Selected ${label.replace(/ ID$/, "")}`}: ${id}`}
      aria-busy={loading}
      className={cn("flex flex-col gap-3 p-3", styles.card, className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={styles.heading}>{heading ?? `Selected ${label.replace(/ ID$/, "")}`}</p>
        <p className={styles.id}>
          <span className="sr-only">{label}: </span>
          {preview?.id ?? id}
        </p>
      </div>

      {loading ? (
        <p role="status" className={styles.muted}>
          Loading details…
        </p>
      ) : preview ? (
        <>
          <div className="flex min-w-0 gap-3">
            {preview.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- admin thumbnails from any host
              <img src={preview.image} alt="" className="h-14 w-14 shrink-0 rounded-[3px] object-cover" />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className={cn("truncate", styles.title)}>{preview.title || preview.id}</p>
              {preview.subtitle ? <p className={cn("truncate", styles.muted)}>{preview.subtitle}</p> : null}
            </div>
            {preview.status ? <span className={cn("h-fit shrink-0", styles.status)}>{humanize(preview.status)}</span> : null}
          </div>

          {preview.fields.length > 0 ? (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {preview.fields.map((field) => (
                <div key={field.label} className="flex min-w-0 justify-between gap-2 sm:block">
                  <dt className={styles.term}>{field.label}</dt>
                  <dd className={cn("truncate text-right sm:text-left", styles.value)}>{show(field)}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {preview.related.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Linked records">
              {preview.related.map((link) => (
                <li key={`${link.entity}-${link.id}`}>
                  {scope === "admin" && isLookupEntity(link.entity) ? (
                    <Link href={adminLookupHref(link.entity, link.id)} className={styles.chip}>
                      <span className="font-sans">{link.label}</span> {link.id}
                    </Link>
                  ) : (
                    <span className={styles.chip}>
                      <span className="font-sans">{link.label}</span> {link.id}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className={styles.error}>
            {lookupErrorMessage(current?.error, { idLabel: label, id })}
          </p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className={styles.button}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </button>
        </div>
      )}

      {href || onChange || onClear ? (
        <div className="flex flex-wrap gap-2">
          {href ? (
            <Link href={href} className={styles.button}>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              View full details
            </Link>
          ) : null}
          {onChange ? (
            <button type="button" onClick={onChange} className={styles.button} aria-label={`Change ${label}`}>
              Change
            </button>
          ) : null}
          {onClear ? (
            <button type="button" onClick={onClear} className={styles.button} aria-label={`Clear ${label}`}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
