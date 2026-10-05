import { describe, expect, it } from "vitest";

import {
  CUSTOMER_CANCELLABLE,
  ORDER_FLOW,
  customerStageLabel,
  flowIndex,
  stageLabel,
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

describe("labels for the packing stage", () => {
  it("calls processing what it is: packing", () => {
    expect(stageLabel("processing")).toBe("Packing");
    expect(customerStageLabel("processing")).toBe("Being packed");
  });
});

describe("CUSTOMER_CANCELLABLE", () => {
  it("lets a customer cancel only before picking starts", () => {
    expect([...CUSTOMER_CANCELLABLE].sort()).toEqual(["confirmed", "pending"]);
    for (const status of ORDER_FLOW.slice(2)) expect(CUSTOMER_CANCELLABLE.has(status)).toBe(false);
  });
});
