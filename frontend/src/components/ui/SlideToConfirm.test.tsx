import { describe, expect, it, vi } from "vitest";

import { fireEvent, renderUI, screen } from "@/test/render";

import { SlideToConfirm } from "./SlideToConfirm";

// jsdom has no PointerEvent; a MouseEvent carrying a pointerId stands in.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}

describe("SlideToConfirm", () => {
  it("is a labelled slider that a keyboard completes with Enter", async () => {
    const onConfirm = vi.fn();
    const { user } = renderUI(<SlideToConfirm label="Slide to place order" onConfirm={onConfirm} />);
    const slider = screen.getByRole("slider", { name: "Slide to place order" });
    expect(slider).toHaveAttribute("aria-valuenow", "0");
    slider.focus();
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(slider).toHaveAttribute("aria-valuenow", "100");
  });

  it("moves with the arrow keys and completes only at the end", async () => {
    const onConfirm = vi.fn();
    const { user } = renderUI(<SlideToConfirm label="Slide" onConfirm={onConfirm} />);
    const slider = screen.getByRole("slider", { name: "Slide" });
    slider.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(onConfirm).not.toHaveBeenCalled();
    await user.keyboard("{Home}");
    expect(slider).toHaveAttribute("aria-valuenow", "0");
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("springs back when let go short of the end, and completes when dragged all the way", () => {
    const onConfirm = vi.fn();
    renderUI(<SlideToConfirm label="Slide" onConfirm={onConfirm} />);
    const slider = screen.getByRole("slider", { name: "Slide" });
    // jsdom has no layout: the track's travel is 1px, so any real drag reaches the end.
    fireEvent.pointerDown(slider, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 0, pointerId: 1 });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.pointerDown(slider, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 200, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 200, pointerId: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled or busy, and says what's happening", async () => {
    const onConfirm = vi.fn();
    const { user, rerender } = renderUI(<SlideToConfirm label="Slide" onConfirm={onConfirm} disabled />);
    screen.getByRole("slider").focus();
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    rerender(<SlideToConfirm label="Slide" busyLabel="Placing order…" onConfirm={onConfirm} busy />);
    expect(screen.getByText("Placing order…")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toHaveAttribute("aria-disabled", "true");
  });

  it("returns to the start when a confirmed action is refused", async () => {
    const onConfirm = vi.fn();
    const { user, rerender } = renderUI(<SlideToConfirm label="Slide" onConfirm={onConfirm} />);
    screen.getByRole("slider").focus();
    await user.keyboard("{Enter}");
    rerender(<SlideToConfirm label="Slide" onConfirm={onConfirm} busy />);
    rerender(<SlideToConfirm label="Slide" onConfirm={onConfirm} busy={false} />);
    await vi.waitFor(() => expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "0"));
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
