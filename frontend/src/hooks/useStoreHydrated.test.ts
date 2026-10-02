import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useCheckoutStore } from "@/store/checkoutStore";

import { useCheckoutHydrated } from "./useStoreHydrated";

describe("useCheckoutHydrated", () => {
  it("is true once the checkout store has rehydrated from storage", () => {
    const { result } = renderHook(() => useCheckoutHydrated());
    expect(result.current).toBe(true);
  });

  it("reflects the store's own hydration flag rather than a separate one", () => {
    expect(useCheckoutStore.persist?.hasHydrated?.()).toBe(true);
    const { result } = renderHook(() => useCheckoutHydrated());
    expect(result.current).toBe(true);
  });
});
