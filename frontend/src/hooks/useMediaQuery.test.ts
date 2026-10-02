import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useIsDesktop, useMediaQuery } from "./useMediaQuery";

/** A matchMedia stub whose `matches` and listeners a test can drive. */
function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const list = {
    get matches() {
      return matches;
    },
    media: "",
    addEventListener: vi.fn((_: string, cb: () => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_: string, cb: () => void) => listeners.delete(cb)),
  };
  vi.spyOn(window, "matchMedia").mockReturnValue(list as unknown as MediaQueryList);
  return {
    change(next: boolean) {
      matches = next;
      act(() => {
        listeners.forEach((cb) => cb());
      });
    },
    listeners,
  };
}

describe("useMediaQuery", () => {
  it("reflects the current match and updates when the media query changes", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);

    media.change(true);
    expect(result.current).toBe(true);

    media.change(false);
    expect(result.current).toBe(false);
  });

  it("starts matched when the query already matches on mount", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(true);
  });

  it("removes its change listener on unmount", () => {
    const media = stubMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("re-subscribes when the query string changes", () => {
    const media = stubMatchMedia(false);
    const { rerender } = renderHook(({ query }) => useMediaQuery(query), {
      initialProps: { query: "(min-width: 1024px)" },
    });
    expect(media.listeners.size).toBe(1);
    rerender({ query: "(min-width: 640px)" });
    // The old listener is torn down and a fresh one attached for the new query.
    expect(media.listeners.size).toBe(1);
  });

  it("is false when matchMedia is unavailable", () => {
    const original = window.matchMedia;
    // @ts-expect-error -- simulating an environment without matchMedia
    delete window.matchMedia;
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
    window.matchMedia = original;
  });

  describe("useIsDesktop", () => {
    it("queries Tailwind's lg breakpoint", () => {
      stubMatchMedia(true);
      const spy = vi.spyOn(window, "matchMedia");
      renderHook(() => useIsDesktop());
      expect(spy).toHaveBeenCalledWith("(min-width: 1024px)");
    });
  });
});
