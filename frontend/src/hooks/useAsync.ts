"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
  /** Re-run the task, e.g. from a "Try again" button on an error state. */
  reload: () => void;
}

/**
 * Run an async task and expose loading, error and data as state.
 *
 * Small on purpose. It handles the three things that actually go wrong when
 * hand-rolling this in a component:
 *
 *   - a slow first request resolving after a faster second one and overwriting
 *     it, so responses are ignored unless they belong to the latest run;
 *   - setting state after unmount;
 *   - losing the previous data during a reload, which makes lists flicker.
 *
 * If this app later adopts TanStack Query for caching, every consumer keeps
 * the same `{ data, error, isLoading }` shape and only this file goes away.
 */
export function useAsync<T>(
  task: () => Promise<T>,
  deps: readonly unknown[],
  options: { initialData?: T | null; enabled?: boolean } = {},
): AsyncState<T> {
  const { initialData = null, enabled = true } = options;

  const [data, setData] = useState<T | null>(initialData);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);

  // Identifies the newest run, so stale resolutions can be discarded.
  const runRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Memoise the task against the caller's dependency list.
   *
   * `task` itself is excluded: callers pass an inline closure, so it is a new
   * reference every render and depending on it would re-run the request
   * forever. `deps` is the contract — the same one `useEffect` offers — and no
   * static analyser can verify a dependency list supplied as a parameter,
   * which is why both rules are suppressed here rather than satisfied.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  const run = useCallback(task, deps);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    runRef.current += 1;
    const runId = runRef.current;

    setIsLoading(true);
    setError(null);

    run()
      .then((result) => {
        if (!mountedRef.current || runId !== runRef.current) return;
        setData(result);
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current || runId !== runRef.current) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        if (!mountedRef.current || runId !== runRef.current) return;
        setIsLoading(false);
      });
  }, [run, enabled, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, error, isLoading, reload };
}
