import { describe, expect, it } from "vitest";

import { toast, useToastStore } from "./toastStore";

const toasts = () => useToastStore.getState().toasts;

describe("useToastStore", () => {
  it("starts with no toasts and is not persisted", () => {
    expect(toasts()).toEqual([]);
    useToastStore.getState().push({ message: "Hi", tone: "info" });
    expect(localStorage.length).toBe(0);
  });

  it("pushes a toast with a unique generated id and returns it", () => {
    const first = useToastStore.getState().push({ message: "Saved", tone: "success" });
    const second = useToastStore.getState().push({ message: "Saved", tone: "success" });
    expect(first).toMatch(/^toast_\d+_[a-z0-9]+$/);
    expect(first).not.toBe(second);
    expect(toasts().map((t) => t.id)).toEqual([first, second]);
  });

  it("keeps only the newest three", () => {
    ["1", "2", "3", "4", "5"].forEach((message) => useToastStore.getState().push({ message, tone: "info" }));
    expect(toasts().map((t) => t.message)).toEqual(["3", "4", "5"]);
  });

  it("dismisses by id and ignores an unknown id", () => {
    const id = useToastStore.getState().push({ message: "A", tone: "info" });
    useToastStore.getState().push({ message: "B", tone: "info" });
    useToastStore.getState().dismiss("nope");
    expect(toasts()).toHaveLength(2);
    useToastStore.getState().dismiss(id);
    expect(toasts().map((t) => t.message)).toEqual(["B"]);
  });

  it.each(["success", "info", "error"] as const)("toast.%s pushes with that tone and an optional action", (tone) => {
    const action = { label: "View cart", href: "/cart" };
    const id = toast[tone]("Message", action);
    expect(toasts()).toEqual([{ id, message: "Message", tone, action }]);
    toast[tone]("Plain");
    expect(toasts()[1]).toMatchObject({ message: "Plain", tone, action: undefined });
  });
});
