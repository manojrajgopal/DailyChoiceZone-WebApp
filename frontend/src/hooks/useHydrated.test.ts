import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useHydrated } from "./useHydrated";

describe("useHydrated", () => {
  it("is true once rendered on the client", () => {
    const { result } = renderHook(() => useHydrated());
    expect(result.current).toBe(true);
  });

  it("stays true across re-renders", () => {
    const { result, rerender } = renderHook(() => useHydrated());
    rerender();
    expect(result.current).toBe(true);
  });
});
