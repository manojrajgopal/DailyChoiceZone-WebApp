import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAdminResource } from "./useAdminResource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAdminResource", () => {
  describe("loading", () => {
    it("loads on mount and exposes the result", async () => {
      const load = vi.fn(() => Promise.resolve(["a", "b"]));
      const { result } = renderHook(() => useAdminResource(load));
      expect(result.current.isLoading).toBe(true);
      expect(result.current.data).toBeNull();

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.data).toEqual(["a", "b"]);
      expect(result.current.error).toBeNull();
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("does not load, and is not loading, while disabled", () => {
      const load = vi.fn(() => Promise.resolve([]));
      const { result } = renderHook(() => useAdminResource(load, [], { enabled: false }));
      expect(load).not.toHaveBeenCalled();
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("error cases", () => {
    it("captures a rejection as an Error", async () => {
      const load = vi.fn(() => Promise.reject(new Error("failed to load")));
      const { result } = renderHook(() => useAdminResource(load));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error?.message).toBe("failed to load");
      expect(result.current.data).toBeNull();
    });

    it("wraps a non-Error rejection", async () => {
      const load = vi.fn(() => Promise.reject("oops"));
      const { result } = renderHook(() => useAdminResource(load));
      await waitFor(() => expect(result.current.error?.message).toBe("oops"));
    });
  });

  describe("reload", () => {
    it("re-reads and reports isRefreshing while data is already present", async () => {
      let resolveCount = 0;
      const load = vi.fn(() => Promise.resolve(++resolveCount));
      const { result } = renderHook(() => useAdminResource(load));
      await waitFor(() => expect(result.current.data).toBe(1));

      const pending = deferred<number>();
      load.mockReturnValueOnce(pending.promise);
      act(() => {
        void result.current.reload();
      });
      expect(result.current.isRefreshing).toBe(true);
      // Stale data stays on screen during a refresh rather than flashing empty.
      expect(result.current.data).toBe(1);

      pending.resolve(2);
      await waitFor(() => expect(result.current.data).toBe(2));
      expect(result.current.isRefreshing).toBe(false);
    });

    it("clears a previous error on reload", async () => {
      let fail = true;
      const load = vi.fn(() => (fail ? Promise.reject(new Error("nope")) : Promise.resolve("ok")));
      const { result } = renderHook(() => useAdminResource(load));
      await waitFor(() => expect(result.current.error?.message).toBe("nope"));

      fail = false;
      await act(async () => {
        await result.current.reload();
      });
      expect(result.current.error).toBeNull();
      expect(result.current.data).toBe("ok");
    });
  });

  describe("re-running on deps", () => {
    it("re-fetches when a dependency changes", async () => {
      const load = vi.fn((id: string) => Promise.resolve(`data-${id}`));
      const { result, rerender } = renderHook(({ id }) => useAdminResource(() => load(id), [id]), {
        initialProps: { id: "1" },
      });
      await waitFor(() => expect(result.current.data).toBe("data-1"));

      rerender({ id: "2" });
      await waitFor(() => expect(result.current.data).toBe("data-2"));
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("discards a stale response when a newer run has superseded it", async () => {
      const slow = deferred<string>();
      const fast = deferred<string>();
      let call = 0;
      const load = vi.fn(() => (call++ === 0 ? slow.promise : fast.promise));

      const { result, rerender } = renderHook(({ key }) => useAdminResource(() => load(), [key]), {
        initialProps: { key: "a" },
      });
      rerender({ key: "b" });

      fast.resolve("second");
      await waitFor(() => expect(result.current.data).toBe("second"));

      slow.resolve("first (stale)");
      await Promise.resolve();
      expect(result.current.data).toBe("second");
    });
  });

  describe("unmount", () => {
    it("does not update state after unmount", async () => {
      const pending = deferred<string>();
      const { unmount } = renderHook(() => useAdminResource(() => pending.promise));
      unmount();
      pending.resolve("too late");
      await act(async () => {
        await Promise.resolve();
      });
    });
  });
});
