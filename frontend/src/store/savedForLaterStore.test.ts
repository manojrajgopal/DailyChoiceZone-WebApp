import { describe, expect, it } from "vitest";

import { MAX_GUEST_SAVED, useSavedForLaterStore } from "./savedForLaterStore";

const saved = () => useSavedForLaterStore.getState();

describe("useSavedForLaterStore (a guest's saved lines)", () => {
  it("starts empty", () => {
    expect(saved().lines).toEqual([]);
  });

  it("saves a line with its variant and quantity, newest first", () => {
    saved().save({ productId: "A", size: "M", color: "Navy", quantity: 2 });
    saved().save({ productId: "B" });
    expect(saved().lines.map((line) => [line.productId, line.size, line.color, line.quantity])).toEqual([
      ["B", null, null, 1],
      ["A", "M", "Navy", 2],
    ]);
  });

  it("merges the same variant instead of adding a second line", () => {
    saved().save({ productId: "A", size: "M", quantity: 2 });
    saved().save({ productId: "A", size: "M", quantity: 3 });
    expect(saved().lines).toHaveLength(1);
    expect(saved().lines[0]?.quantity).toBe(5);
  });

  it("keeps two sizes of one product apart", () => {
    saved().save({ productId: "A", size: "M" });
    saved().save({ productId: "A", size: "L" });
    expect(saved().lines).toHaveLength(2);
  });

  it("caps quantities at the bag's line limit", () => {
    saved().save({ productId: "A", quantity: 8 });
    saved().save({ productId: "A", quantity: 8 });
    expect(saved().lines[0]?.quantity).toBe(10);
    saved().setQuantity(saved().lines[0]!.lineId, 0);
    expect(saved().lines[0]?.quantity).toBe(1);
  });

  it("keeps the list short", () => {
    for (let i = 0; i < MAX_GUEST_SAVED + 5; i++) saved().save({ productId: `P${i}` });
    expect(saved().lines).toHaveLength(MAX_GUEST_SAVED);
    expect(saved().lines[0]?.productId).toBe(`P${MAX_GUEST_SAVED + 4}`);
  });

  it("removes and clears", () => {
    saved().save({ productId: "A" });
    saved().save({ productId: "B" });
    saved().remove(saved().lines[0]!.lineId);
    expect(saved().lines.map((line) => line.productId)).toEqual(["A"]);
    saved().clear();
    expect(saved().lines).toEqual([]);
  });

  it("persists ids, variants and quantities — never a price", () => {
    saved().save({ productId: "A", size: "M", quantity: 2 });
    const stored = JSON.parse(localStorage.getItem("dcz:saved-for-later")!);
    expect(stored.state.lines[0]).toMatchObject({ productId: "A", size: "M", quantity: 2 });
    expect(JSON.stringify(stored)).not.toMatch(/price/i);
  });
});
