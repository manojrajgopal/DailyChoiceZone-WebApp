"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Load an admin collection, with a way to reload it after a mutation.
 *
 * Admin pages are read-then-write: list something, change one row, show the
 * change. `reload` is what makes that loop correct — after a service call
 * succeeds the page re-reads rather than patching local state, so what is on
 * screen is always what the data layer actually holds. Optimistic patching
 * would be faster and would eventually disagree with the store.
 *
 * `enabled: false` holds the request back. It is for data only one part of a
 * page needs — the catalogue behind a "pick a product" dialog, say — so
 * opening the page does not fetch something nobody has asked to see yet.
 */
export interface AdminResource<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
  /** True during a reload that already has data — for a subtle busy state. */
  isRefreshing: boolean;
  reload: () => Promise<void>;
}

export function useAdminResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
  { enabled = true }: { enabled?: boolean } = {},
): AdminResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // Nothing is loading while it is switched off, so a caller that renders a
  // spinner on `isLoading` shows its closed state rather than a spinner.
  const [isLoading, setIsLoading] = useState(enabled);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const mounted = useRef(true);
  const runId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // `load` is an inline closure at every call site, so it cannot be a
  // dependency. The caller's `deps` is the contract, exactly as with useEffect.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  const run = useCallback(load, deps);

  const fetchData = useCallback(
    async (isReload: boolean) => {
      if (!enabled) return;

      runId.current += 1;
      const id = runId.current;

      if (isReload) setIsRefreshing(true);
      setError(null);

      try {
        const result = await run();
        // Discard a slow response that a newer request has already superseded.
        if (!mounted.current || id !== runId.current) return;
        setData(result);
      } catch (cause) {
        if (!mounted.current || id !== runId.current) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (mounted.current && id === runId.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [run, enabled],
  );

  useEffect(() => {
    void fetchData(false);
  }, [fetchData]);

  const reload = useCallback(() => fetchData(true), [fetchData]);

  return { data, error, isLoading, isRefreshing, reload };
}
