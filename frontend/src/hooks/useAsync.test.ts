import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAsync } from "./useAsync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAsync", () => {
  describe("success", () => {
    it("starts loading and resolves with the data", async () => {
      const task = vi.fn(() => Promise.resolve("hello"));
      const { result } = renderHook(() => useAsync(task, []));
      expect(result.current.isLoading).toBe(true);
      expect(result.current.data).toBeNull();

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.data).toBe("hello");
      expect(result.current.error).toBeNull();
    });

    it("uses the given initial data until the task resolves", () => {
      const d = deferred<string>();
      const { result } = renderHook(() => useAsync(() => d.promise, [], { initialData: "placeholder" }));
      expect(result.current.data).toBe("placeholder");
    });

    it("does not run the task while disabled", () => {
      const task = vi.fn(() => Promise.resolve("x"));
      const { result } = renderHook(() => useAsync(task, [], { enabled: false }));
      expect(task).not.toHaveBeenCalled();
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("error cases", () => {
    it("captures a rejection as an Error", async () => {
      const task = vi.fn(() => Promise.reject(new Error("boom")));
      const { result } = renderHook(() => useAsync(task, []));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("boom");
      expect(result.current.data).toBeNull();
    });

    it("wraps a non-Error rejection in an Error", async () => {
      const task = vi.fn(() => Promise.reject("plain string"));
      const { result } = renderHook(() => useAsync(task, []));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("plain string");
    });
  });

  describe("re-running", () => {
    it("re-runs when a dependency changes", async () => {
      const task = vi.fn((n: number) => Promise.resolve(n * 2));
      const { result, rerender } = renderHook(({ n }) => useAsync(() => task(n), [n]), {
        initialProps: { n: 1 },
      });
      await waitFor(() => expect(result.current.data).toBe(2));

      rerender({ n: 5 });
      await waitFor(() => expect(result.current.data).toBe(10));
      expect(task).toHaveBeenCalledTimes(2);
    });

    it("reload triggers another run and clears the previous error", async () => {
      let shouldFail = true;
      const task = vi.fn(() => (shouldFail ? Promise.reject(new Error("nope")) : Promise.resolve("ok")));
      const { result } = renderHook(() => useAsync(task, []));
      await waitFor(() => expect(result.current.error?.message).toBe("nope"));

      shouldFail = false;
      act(() => result.current.reload());
      // Immediately after reload, loading resumes and the old error is cleared.
      expect(result.current.isLoading).toBe(true);
      expect(result.current.error).toBeNull();

      await waitFor(() => expect(result.current.data).toBe("ok"));
    });

    it("discards a stale response when a newer run has already started", async () => {
      const slow = deferred<string>();
      const fast = deferred<string>();
      let call = 0;
      const task = vi.fn(() => (call++ === 0 ? slow.promise : fast.promise));

      const { result, rerender } = renderHook(({ key }) => useAsync(() => task(), [key]), {
        initialProps: { key: "a" },
      });
      rerender({ key: "b" });

      fast.resolve("second");
      await waitFor(() => expect(result.current.data).toBe("second"));

      // The stale first call resolving afterwards must not overwrite it.
      slow.resolve("first (stale)");
      await Promise.resolve();
      expect(result.current.data).toBe("second");
    });
  });

  describe("unmount", () => {
    it("does not update state after unmount", async () => {
      const d = deferred<string>();
      const { unmount } = renderHook(() => useAsync(() => d.promise, []));
      unmount();
      d.resolve("too late");
      // No React "update on unmounted component" warning, and nothing throws.
      await act(async () => {
        await Promise.resolve();
      });
    });
  });
});
