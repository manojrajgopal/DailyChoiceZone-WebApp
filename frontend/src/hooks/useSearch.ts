"use client";

import { useEffect, useState } from "react";

import { getSearchSuggestions } from "@/services/searchService";
import type { Product } from "@/types";

interface Suggestions {
  products: Product[];
  categories: string[];
  brands: string[];
  total: number;
}

const EMPTY: Suggestions = { products: [], categories: [], brands: [], total: 0 };

/**
 * Debounced type-ahead for the header search box.
 *
 * The debounce is the point: without it, every keystroke fires a query, which
 * is wasteful against JSON and would be worse against a real API.
 */
export function useSearchSuggestions(term: string, delay = 200) {
  const [suggestions, setSuggestions] = useState<Suggestions>(EMPTY);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const trimmed = term.trim();

    if (trimmed.length < 2) {
      setSuggestions(EMPTY);
      setIsSearching(false);
      return;
    }

    let active = true;
    setIsSearching(true);

    const timer = setTimeout(() => {
      getSearchSuggestions(trimmed)
        .then((result) => {
          if (active) setSuggestions(result);
        })
        .catch(() => {
          if (active) setSuggestions(EMPTY);
        })
        .finally(() => {
          if (active) setIsSearching(false);
        });
    }, delay);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [term, delay]);

  return { suggestions, isSearching };
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
