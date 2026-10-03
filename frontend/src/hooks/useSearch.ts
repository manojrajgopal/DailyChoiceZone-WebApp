"use client";

import { useEffect, useState } from "react";

import { EMPTY_SUGGESTIONS, getSearchSuggestions } from "@/services/searchService";
import type { SearchSuggestions } from "@/types";

/**
 * Debounced type-ahead for the header search box (`GET /search/suggest`).
 *
 * The debounce is the point: without it every keystroke fires a request.
 * And a request a newer keystroke has made stale is *aborted*, not merely
 * ignored, so a slow answer for "bo" can never land on top of "bottle".
 * Under two characters nothing is fetched (the empty dropdown shows popular
 * and recent searches instead, see `usePopularSearches`).
 */
export function useSearchSuggestions(term: string, delay = 200) {
  const trimmed = term.trim();
  const [result, setResult] = useState<{ term: string; suggestions: SearchSuggestions } | null>(null);

  useEffect(() => {
    if (trimmed.length < 2) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      getSearchSuggestions(trimmed, { signal: controller.signal })
        .then((suggestions) => {
          if (!controller.signal.aborted) setResult({ term: trimmed, suggestions });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ term: trimmed, suggestions: EMPTY_SUGGESTIONS });
        });
    }, delay);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, delay]);

  // Derived rather than reset in the effect: a result only counts for the term it answered.
  const active = trimmed.length >= 2;
  const current = active && result?.term === trimmed ? result.suggestions : EMPTY_SUGGESTIONS;
  const isSearching = active && result?.term !== trimmed;

  return { suggestions: current, isSearching };
}

/**
 * The store's popular searches (from the search analytics), fetched once.
 *
 * `fallback` (the content document's list) shows until — and unless — the
 * server answers with a non-empty list.
 */
export function usePopularSearches(fallback: string[] = [], enabled = true): string[] {
  const [popular, setPopular] = useState<string[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getSearchSuggestions("", { signal: controller.signal })
      .then((suggestions) => {
        if (!controller.signal.aborted) setPopular(suggestions.popular);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled]);

  return popular && popular.length > 0 ? popular : fallback;
}

/** Debounce any value. Used for the mobile filter drawer's price inputs. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
