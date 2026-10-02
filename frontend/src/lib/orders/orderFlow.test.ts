import { describe, expect, it } from "vitest";

import {
  ORDER_FLOW,
  availableMoves,
  customerStageLabel,
  flowIndex,
  needsConfirmation,
  stageLabel,
  type Move,
} from "./orderFlow";

describe("stageLabel / customerStageLabel", () => {
  it.each([
    ["pending", "Pending", "Order placed"],
    ["delivered", "Delivered", "Delivered"],
    ["cancelled", "Cancelled", "Cancelled"],
    ["returned", "Returned", "Returned"],
  ])("labels %s", (status, adminLabel, customerLabel) => {
    expect(stageLabel(status)).toBe(adminLabel);
    expect(customerStageLabel(status)).toBe(customerLabel);
  });

  it("falls back to the raw status for an unrecognised value", () => {
    expect(stageLabel("made-up")).toBe("made-up");
    expect(customerStageLabel("made-up")).toBe("made-up");
  });
});

describe("flowIndex", () => {
  it.each([
    ["pending", 0],
    ["delivered", 7],
    ["cancelled", -1],
    ["unknown", -1],
  ])("%s is at index %s", (status, index) => {
    expect(flowIndex(status)).toBe(index);
  });
});

describe("availableMoves", () => {
  it("is empty for a terminal status", () => {
    expect(availableMoves("cancelled")).toEqual([]);
    expect(availableMoves("returned")).toEqual([]);
  });

  it("offers next, skips, cancel from pending", () => {
    const moves = availableMoves("pending");
    const kinds = moves.map((m) => m.kind);
    expect(kinds[0]).toBe("next");
    expect(moves.find((m) => m.target === "confirmed")?.kind).toBe("next");
    expect(moves.find((m) => m.target === "cancelled")?.kind).toBe("cancel");
    expect(moves.some((m) => m.kind === "back")).toBe(false); // nothing before pending
  });

  it("only allows cancelling a pending order awaiting payment", () => {
    const moves = availableMoves("pending", true);
    expect(moves).toEqual([{ target: "cancelled", kind: "cancel", detail: "" }]);
  });

  it("describes a skip with the stages it passes over", () => {
    const moves = availableMoves("pending");
    const skip = moves.find((m) => m.target === "packed");
    expect(skip).toMatchObject({ kind: "skip" });
    expect(skip!.detail).toBe("Skips Confirmed, Processing");
  });

  it("offers back moves from a mid-flow status, but never back to pending", () => {
    const moves = availableMoves("packed");
    const back = moves.filter((m) => m.kind === "back");
    expect(back.map((m) => m.target)).not.toContain("pending");
    expect(back.some((m) => m.target === "confirmed")).toBe(true);
  });

  it("offers return but not cancel from a shipped order", () => {
    const moves = availableMoves("shipped");
    expect(moves.find((m) => m.kind === "return")).toBeTruthy();
    expect(moves.find((m) => m.kind === "cancel")).toBeUndefined();
  });

  it("offers neither back nor forward moves from delivered, only return", () => {
    const moves = availableMoves("delivered");
    expect(moves).toEqual([{ target: "returned", kind: "return", detail: "" }]);
  });

  it("sorts next first, then skip, then back, then exits", () => {
    const moves = availableMoves("processing");
    const order = moves.map((m) => m.kind);
    const nextIndex = order.indexOf("next");
    const skipIndex = order.indexOf("skip");
    const backIndex = order.indexOf("back");
    const cancelIndex = order.indexOf("cancel");
    expect(nextIndex).toBeLessThan(skipIndex);
    expect(skipIndex).toBeLessThan(backIndex);
    expect(backIndex).toBeLessThan(cancelIndex);
  });

  it("is empty for an unrecognised, non-terminal status", () => {
    expect(availableMoves("made-up")).toEqual([]);
  });
});

describe("needsConfirmation", () => {
  it.each([
    [{ target: "packed", kind: "skip", detail: "" } as Move, true],
    [{ target: "confirmed", kind: "back", detail: "" } as Move, true],
    [{ target: "confirmed", kind: "next", detail: "" } as Move, false],
    [{ target: "cancelled", kind: "cancel", detail: "" } as Move, false],
    [undefined, false],
  ])("%j needs confirmation: %s", (move, expected) => {
    expect(needsConfirmation(move)).toBe(expected);
  });
});

describe("ORDER_FLOW", () => {
  it("is the eight non-terminal stages in pipeline order", () => {
    expect(ORDER_FLOW).toEqual([
      "pending", "confirmed", "processing", "packed", "shipped", "in-transit", "out-for-delivery", "delivered",
    ]);
  });
});
