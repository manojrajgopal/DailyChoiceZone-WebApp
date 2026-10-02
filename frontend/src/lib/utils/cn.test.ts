import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it.each([
    [["a", "b"], "a b"],
    [["px-2", "px-4"], "px-4"],
    [["text-sm", false, null, undefined, "font-bold"], "text-sm font-bold"],
    [[{ hidden: true, block: false }], "hidden"],
    [[["p-1", ["m-2"]]], "p-1 m-2"],
    [["bg-red-500", "bg-blue-500 text-white"], "bg-blue-500 text-white"],
    [[], ""],
    [["", 0], ""],
  ])("merges %j into %j, later Tailwind utilities winning", (inputs, expected) => {
    expect(cn(...(inputs as Parameters<typeof cn>))).toBe(expected);
  });
});
