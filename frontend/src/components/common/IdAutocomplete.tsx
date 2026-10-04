"use client";

import { forwardRef, useId, useImperativeHandle, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";

import { useIdSuggestions } from "@/hooks/useIdSuggestions";
import { idLabel as labelFor, idPlaceholder, type LookupEntity, type LookupScope } from "@/lib/lookup/entities";
import { lookupErrorMessage } from "@/lib/lookup/errors";
import { cn } from "@/lib/utils/cn";
import { normaliseId, resolveId, type IdPreview } from "@/services/lookupService";

/**
 * Pick a record by its ID (docs/id-lookup.md).
 *
 * A WAI-ARIA combobox: type part of an ID, the matching IDs appear, arrow keys
 * move through them, Enter picks, Escape closes (and, pressed again, clears).
 * Suggestions are IDs only — the server matches identifiers, never names — and
 * a pick hands back the exact ID. Typing a whole ID and pressing Enter checks
 * it exactly, so a full ID never needs the list.
 *
 * Shared by the portal (`tone="admin"`) and the storefront (`tone="store"`).
 * The list is as wide as the field and scrolls inside itself, so it never
 * runs off a phone's screen.
 */

export interface IdAutocompleteProps {
  entity: LookupEntity;
  scope?: LookupScope;
  /** Defaults to "Product ID". */
  label?: string;
  hideLabel?: boolean;
  /** Defaults to "Search Product ID…". */
  placeholder?: string;
  hint?: string;
  /** Called with the exact ID chosen, and its preview when Enter checked it. */
  onSelect: (id: string, preview?: IdPreview) => void;
  minChars?: number;
  debounceMs?: number;
  limit?: number;
  /** IDs already chosen: shown, but not choosable again. */
  exclude?: readonly string[];
  disabled?: boolean;
  autoFocus?: boolean;
  required?: boolean;
  tone?: "admin" | "store";
  className?: string;
  /** Escape on an empty field (e.g. "stop changing, keep what was chosen"). */
  onCancel?: () => void;
}

export interface IdAutocompleteHandle {
  focus: () => void;
}

const TONES = {
  admin: {
    label: "text-xs font-medium text-admin-ink",
    input:
      "h-9 w-full rounded-[3px] border border-admin-border bg-admin-surface pl-8 pr-8 text-[0.8125rem] text-admin-ink " +
      "placeholder:text-admin-faint hover:border-admin-border-strong focus:border-copper-500 disabled:cursor-not-allowed disabled:bg-admin-raised",
    icon: "text-admin-faint",
    list: "rounded-[3px] border border-admin-border bg-admin-surface shadow-raised",
    option: "text-admin-ink",
    active: "bg-admin-raised",
    muted: "text-admin-muted",
    hint: "text-[0.6875rem] text-admin-muted",
    error: "text-[0.6875rem] text-[#c23434]",
  },
  store: {
    label: "label-wide text-ink-700",
    input:
      "h-11 w-full rounded-control border border-ink-200 bg-shell pl-9 pr-9 text-[0.9375rem] text-ink placeholder:text-ink-400 " +
      "hover:border-ink-300 focus:border-copper-500 disabled:cursor-not-allowed disabled:bg-cream-deep",
    icon: "text-ink-400",
    list: "rounded-control border border-ink-200 bg-shell shadow-raised",
    option: "text-ink",
    active: "bg-cream-deep",
    muted: "text-ink-400",
    hint: "text-xs text-ink-400",
    error: "text-xs text-danger",
  },
} as const;

export const IdAutocomplete = forwardRef<IdAutocompleteHandle, IdAutocompleteProps>(function IdAutocomplete(
  {
    entity,
    scope = "admin",
    label,
    hideLabel = false,
    placeholder,
    hint,
    onSelect,
    minChars = 1,
    debounceMs,
    limit,
    exclude = [],
    disabled = false,
    autoFocus = false,
    required = false,
    tone = "admin",
    className,
    onCancel,
  },
  ref,
) {
  const styles = TONES[tone];
  const fieldLabel = label ?? labelFor(entity);
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const statusId = `${baseId}-status`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;

  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const { items, hasMore, error, isSearching, active: asking } = useIdSuggestions(scope, entity, text, {
    debounceMs,
    minChars,
    limit,
    enabled: !disabled,
  });
  const taken = new Set(exclude.map(normaliseId));
  const choosable = (index: number) => index >= 0 && index < items.length && !taken.has(normaliseId(items[index]!.id));

  const showList = open && asking;
  const listProblem = error ? lookupErrorMessage(error, { idLabel: fieldLabel }) : null;

  let status = "";
  if (showList) {
    if (isSearching) status = "Searching IDs…";
    else if (listProblem) status = listProblem;
    else if (items.length === 0) status = "No matching IDs found.";
    else status = `${items.length}${hasMore ? "+" : ""} matching ${items.length === 1 ? "ID" : "IDs"}.`;
  }

  const choose = (id: string, preview?: IdPreview) => {
    setText("");
    setOpen(false);
    setActive(-1);
    setProblem(null);
    onSelect(id, preview);
  };

  /** Enter on typed text with nothing highlighted: is it an ID, exactly? */
  const checkExact = async () => {
    const typed = text.trim();
    if (!typed) return;
    setChecking(true);
    setProblem(null);
    try {
      const preview = await resolveId(scope, entity, typed);
      if (taken.has(normaliseId(preview.id))) setProblem(`${fieldLabel} ${preview.id} is already chosen.`);
      else choose(preview.id, preview);
    } catch (failure) {
      setProblem(lookupErrorMessage(failure, { idLabel: fieldLabel, id: normaliseId(typed) }));
      setOpen(false);
    } finally {
      setChecking(false);
    }
  };

  const move = (step: 1 | -1) => {
    if (items.length === 0) return;
    setOpen(true);
    setActive((current) => {
      let next = current;
      for (let i = 0; i < items.length; i += 1) {
        next = (next + step + items.length) % items.length;
        if (choosable(next)) return next;
      }
      return -1;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Enter":
        // Never submits the surrounding form: Enter here means "this ID".
        event.preventDefault();
        if (showList && choosable(active)) choose(items[active]!.id);
        else void checkExact();
        break;
      case "Escape":
        if (showList) {
          event.preventDefault();
          setOpen(false);
          setActive(-1);
        } else if (text) {
          event.preventDefault();
          setText("");
          setProblem(null);
        } else if (onCancel) {
          event.preventDefault();
          onCancel();
        }
        break;
      default:
        break;
    }
  };

  const describedBy = [problem ? errorId : null, hint && !problem ? hintId : null, statusId].filter(Boolean).join(" ");
  const activeOptionId = showList && choosable(active) ? `${listId}-${active}` : undefined;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={inputId} className={cn(styles.label, hideLabel && "sr-only")}>
        {fieldLabel}
        {required ? (
          <span className="ml-0.5 text-[#c23434]" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <div className="relative">
        <Search
          className={cn("pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2", styles.icon)}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={activeOptionId}
          aria-describedby={describedBy || undefined}
          aria-invalid={problem ? true : undefined}
          aria-required={required || undefined}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="search"
          autoFocus={autoFocus}
          disabled={disabled}
          value={text}
          placeholder={placeholder ?? idPlaceholder(entity)}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
            setActive(-1);
            setProblem(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className={cn(styles.input, "font-mono tracking-wide", problem && "border-[#c23434]")}
        />
        {isSearching || checking ? (
          <Loader2
            className={cn("absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin", styles.icon)}
            aria-hidden="true"
          />
        ) : null}

        <ul
          id={listId}
          role="listbox"
          aria-label={`${fieldLabel} suggestions`}
          hidden={!showList || isSearching || items.length === 0}
          className={cn(
            "scroll-panel absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto py-1",
            styles.list,
          )}
        >
          {items.map((item, index) => {
            const isTaken = taken.has(normaliseId(item.id));
            return (
              <li
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                aria-disabled={isTaken || undefined}
                // mousedown, not click: the input keeps focus, so blur never closes the list first.
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (!isTaken) choose(item.id);
                }}
                onMouseEnter={() => !isTaken && setActive(index)}
                className={cn(
                  "flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-[0.8125rem]",
                  styles.option,
                  index === active && styles.active,
                  isTaken && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="truncate font-mono tracking-wide">{item.id}</span>
                {isTaken ? (
                  <span className={cn("shrink-0 text-[0.6875rem]", styles.muted)}>Already chosen</span>
                ) : item.match ? (
                  <span className={cn("shrink-0 truncate font-mono text-[0.6875rem]", styles.muted)}>
                    matched {item.match}
                  </span>
                ) : null}
              </li>
            );
          })}
          {hasMore ? (
            <li role="presentation" className={cn("px-3 py-1.5 text-[0.6875rem]", styles.muted)}>
              Keep typing to narrow these down.
            </li>
          ) : null}
        </ul>

        {showList && (isSearching || items.length === 0) ? (
          <div
            aria-hidden="true"
            className={cn("absolute left-0 right-0 top-full z-50 mt-1 px-3 py-2.5 text-xs", styles.list, styles.muted)}
          >
            {status}
          </div>
        ) : null}
      </div>

      <p id={statusId} role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      {hint && !problem ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {problem ? (
        <p id={errorId} role="alert" className={styles.error}>
          {problem}
        </p>
      ) : null}
    </div>
  );
});
