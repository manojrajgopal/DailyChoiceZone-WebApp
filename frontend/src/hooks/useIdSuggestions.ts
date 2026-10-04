"use client";

import { useEffect, useState } from "react";

import type { LookupEntity, LookupScope } from "@/lib/lookup/entities";
import { suggestIds, type IdSuggestion } from "@/services/lookupService";

/** The pause in typing before IDs are asked for — the header search's 200ms, plus a little. */
export const ID_DEBOUNCE_MS = 250;

interface Options {
  debounceMs?: number;
  /** Characters needed before asking. One is enough for an ID: "P" narrows to products' PRD…. */
  minChars?: number;
  limit?: number;
  enabled?: boolean;
}

interface Result {
  term: string;
  items: IdSuggestion[];
  hasMore: boolean;
  error: unknown;
}

/**
 * IDs matching what has been typed (`GET …/lookup/{entity}?q=`).
 *
 * Debounced, so "P", "PR", "PRD", "PRD-1" is one request, not four. A request
 * a newer keystroke made stale is aborted — a slow answer for "PRD-1" can
 * never land on top of "PRD-10". A result only counts for the term it
 * answered, so nothing out of date is ever shown.
 */
export function useIdSuggestions(
  scope: LookupScope,
  entity: LookupEntity,
  term: string,
  { debounceMs = ID_DEBOUNCE_MS, minChars = 1, limit, enabled = true }: Options = {},
) {
  const trimmed = term.trim();
  const active = enabled && trimmed.length >= minChars;
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!active) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      suggestIds(scope, entity, trimmed, { limit, signal: controller.signal })
        .then((found) => {
          if (!controller.signal.aborted) {
            setResult({ term: trimmed, items: found.items, hasMore: found.hasMore, error: null });
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setResult({ term: trimmed, items: [], hasMore: false, error });
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, scope, entity, trimmed, limit, debounceMs]);

  const current = active && result?.term === trimmed ? result : null;
  return {
    items: current?.items ?? [],
    hasMore: current?.hasMore ?? false,
    error: current?.error ?? null,
    isSearching: active && result?.term !== trimmed,
    active,
  };
}
