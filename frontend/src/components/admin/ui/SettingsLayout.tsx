"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { AdminButton } from "./AdminChrome";

/**
 * A long settings page split into sections, with a sub-menu down the side —
 * the pattern the Support setup page uses, shared so every sectioned page in
 * the portal behaves the same way:
 *
 * - one section on screen at a time, instead of a wall of cards;
 * - the section is in the address (`?section=footer`), so a refresh, the back
 *   button or a shared link lands on the same place;
 * - sections with unsaved edits carry a dot, because one Save still covers
 *   the whole page;
 * - below `lg` the menu becomes a row of chips that scrolls sideways.
 */

export interface SettingsSection {
  id: string;
  label: string;
  /** Heading shown above a run of items in the menu. */
  group?: string;
  /** A count shown beside the label, e.g. how many entries a list has. */
  count?: number;
  /** Has unsaved edits. */
  dirty?: boolean;
  /** Has a field that failed validation — shown in red, ahead of the unsaved dot. */
  error?: boolean;
  content: React.ReactNode;
}

/** The active section, kept in the query string under `key`. */
export function useSettingsSection(ids: string[], key = "section") {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const requested = params.get(key) ?? "";
  const active = ids.includes(requested) ? requested : (ids[0] ?? "");

  // The first section is the default, so it is left out of the address.
  const first = ids[0] ?? "";
  const setActive = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      if (id === first) next.delete(key);
      else next.set(key, id);
      const text = next.toString();
      router.replace(`${pathname}${text ? `?${text}` : ""}`, { scroll: false });
    },
    [params, pathname, router, key, first],
  );

  return [active, setActive] as const;
}

export function SettingsLayout({
  sections,
  active,
  onChange,
  label = "Sections",
}: {
  sections: SettingsSection[];
  active: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  const index = Math.max(0, sections.findIndex((section) => section.id === active));
  const current = sections[index];
  const previous = sections[index - 1];
  const next = sections[index + 1];
  const top = useRef<HTMLDivElement>(null);

  const go = (id: string) => {
    onChange(id);
    // Back to the top of the section, not wherever the last one was scrolled to.
    const box = top.current?.getBoundingClientRect();
    if (box && box.top < 0) top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div ref={top} className="grid scroll-mt-4 items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label={label} className="min-w-0 lg:sticky lg:top-4">
        {/* Phones and tablets: one sideways-scrolling row. */}
        <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 lg:hidden">
          {sections.map((section) => (
            <MenuButton key={section.id} section={section} active={section.id === current?.id} onClick={() => go(section.id)} chip />
          ))}
        </div>

        {/* Desktop: a grouped column. */}
        <div className="hidden flex-col gap-0.5 lg:flex">
          {sections.map((section, at) => {
            const heading = section.group && section.group !== sections[at - 1]?.group ? section.group : null;
            return (
              <div key={section.id}>
                {heading ? (
                  <p className={cn("px-3 pb-1 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-admin-faint", at > 0 ? "pt-4" : "pt-0.5")}>
                    {heading}
                  </p>
                ) : null}
                <MenuButton section={section} active={section.id === current?.id} onClick={() => go(section.id)} />
              </div>
            );
          })}
        </div>
      </nav>

      <div className="min-w-0">
        {current?.content}

        {previous || next ? (
          <div className="mt-4 flex items-center justify-between gap-3 pb-20">
            {previous ? (
              <button
                type="button"
                onClick={() => go(previous.id)}
                className="inline-flex items-center gap-1.5 rounded-[3px] px-2 py-1.5 text-xs text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {previous.label}
              </button>
            ) : (
              <span />
            )}
            {next ? (
              <button
                type="button"
                onClick={() => go(next.id)}
                className="inline-flex items-center gap-1.5 rounded-[3px] px-2 py-1.5 text-xs text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
              >
                {next.label}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : (
          <div className="pb-20" />
        )}
      </div>
    </div>
  );
}

function MenuButton({
  section,
  active,
  onClick,
  chip = false,
}: {
  section: SettingsSection;
  active: boolean;
  onClick: () => void;
  chip?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 whitespace-nowrap text-left text-[0.8125rem] transition-colors",
        chip ? "shrink-0 rounded-[3px] px-3 py-1.5 ring-1 ring-inset" : "w-full rounded-[3px] px-3 py-2",
        active
          ? chip
            ? "bg-admin-ink font-medium text-white ring-admin-ink"
            : "bg-admin-ink font-medium text-white"
          : chip
            ? "bg-admin-surface text-admin-muted ring-admin-border hover:text-admin-ink"
            : "text-admin-muted hover:bg-admin-raised hover:text-admin-ink",
      )}
    >
      <span className={cn(!chip && "min-w-0 flex-1 truncate")}>{section.label}</span>
      {section.count !== undefined ? (
        <span
          className={cn(
            "rounded-[3px] px-1 text-[0.625rem] tabular-nums",
            active ? "bg-white/20 text-white" : "bg-admin-raised text-admin-muted",
          )}
        >
          {section.count}
        </span>
      ) : null}
      {section.error ? (
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-pill", active ? "bg-[#ffb4b4]" : "bg-[#d03b3b]")}
          aria-label="Needs attention"
          title="Needs attention"
        />
      ) : section.dirty ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-copper-500" aria-label="Unsaved changes" title="Unsaved changes" />
      ) : null}
    </button>
  );
}

/**
 * The save bar pinned to the bottom of a sectioned page. It names the
 * sections with unsaved edits (they may be off screen), and the browser asks
 * before leaving the page while there are any.
 */
export function SettingsSaveBar({
  dirtySections,
  saving,
  onSave,
  onDiscard,
  saveLabel,
}: {
  /** Labels of the sections with unsaved edits. */
  dirtySections: string[];
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel: string;
}) {
  const dirty = dirtySections.length > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-admin-border bg-admin-surface/95 px-4 py-3 backdrop-blur-sm lg:left-60">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <p className="mr-auto min-w-0 truncate text-xs text-admin-muted" aria-live="polite">
          {dirty ? (
            <>
              <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-pill bg-copper-500 align-middle" aria-hidden="true" />
              Unsaved changes in <span className="font-medium text-admin-ink">{dirtySections.join(", ")}</span>
            </>
          ) : (
            "All changes saved"
          )}
        </p>
        <AdminButton variant="ghost" onClick={onDiscard} disabled={!dirty || saving}>
          Discard changes
        </AdminButton>
        <AdminButton variant="primary" loading={saving} onClick={onSave} disabled={!dirty}>
          {saveLabel}
        </AdminButton>
      </div>
    </div>
  );
}

/** Whether two values differ — for marking a section's unsaved edits. */
export function changed(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}
