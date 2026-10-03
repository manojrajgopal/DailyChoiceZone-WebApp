import { createElement, forwardRef, Fragment, type HTMLAttributes, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useToastStore, toast } from "@/store/toastStore";
import { act, fireEvent, renderUI, screen } from "@/test/render";

import { Toaster } from "./Toaster";

/**
 * framer-motion's `AnimatePresence` keeps an exiting item mounted until its
 * exit animation finishes. That animation never completes under fake timers
 * (it drives off `requestAnimationFrame`, which fake timers also freeze), so
 * the real library would make "the cleanup effect runs on removal" untestable
 * here. Mocked per the project's rule for animations that block assertions.
 */
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
  motion: {
    li: forwardRef<HTMLLIElement, HTMLAttributes<HTMLLIElement> & { layout?: boolean; initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }>(
      function MotionLi({ layout: _layout, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...rest }, ref) {
        return createElement("li", { ...rest, ref });
      },
    ),
  },
}));

describe("Toaster", () => {
  describe("rendering", () => {
    it("is an empty polite live region with no toasts", () => {
      const { container } = renderUI(<Toaster />);
      expect(container.querySelector("[aria-live='polite']")).not.toBeNull();
      expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    });

    it("shows a toast with its action link", () => {
      renderUI(<Toaster />);
      act(() => {
        toast.success("Added to bag", { label: "View bag", href: "/cart" });
        toast.error("Could not save");
        toast.info("Heads up");
      });
      expect(screen.getByText("Added to bag")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "View bag" })).toHaveAttribute("href", "/cart");
      expect(screen.getByText("Could not save")).toBeInTheDocument();
      expect(screen.getByText("Heads up")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Dismiss notification" })).toHaveLength(3);
    });
  });

  describe("dismissal", () => {
    it("dismisses a toast from its close button", () => {
      renderUI(<Toaster />);
      act(() => {
        toast.info("One");
      });
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("dismisses a toast when its action is followed", () => {
      renderUI(<Toaster />);
      act(() => {
        toast.success("Saved", { label: "Open wishlist", href: "/wishlist" });
      });
      fireEvent.click(screen.getByRole("link", { name: "Open wishlist" }));
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("auto-dismisses each toast four seconds after it appeared, independently", () => {
      vi.useFakeTimers();
      renderUI(<Toaster />);
      act(() => {
        toast.info("First");
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      act(() => {
        toast.info("Second");
      });
      act(() => {
        vi.advanceTimersByTime(1999);
      });
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["First", "Second"]);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["Second"]);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    // The store's docs say the Toaster can pause the timer on hover; it does not.
    it("does not pause auto-dismissal while hovered (no pause is implemented)", () => {
      vi.useFakeTimers();
      renderUI(<Toaster />);
      act(() => {
        toast.info("Hover me");
      });
      fireEvent.mouseEnter(screen.getByText("Hover me"));
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("clears the timer of a toast removed early", () => {
      vi.useFakeTimers();
      const clear = vi.spyOn(globalThis, "clearTimeout");
      renderUI(<Toaster />);
      act(() => {
        toast.info("Gone");
      });
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
      expect(clear).toHaveBeenCalled();
    });

    it("caps the stack at three, dropping the oldest", () => {
      renderUI(<Toaster />);
      act(() => {
        ["a", "b", "c", "d"].forEach((m) => toast.info(m));
      });
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["b", "c", "d"]);
      expect(screen.getByText("d")).toBeInTheDocument();
    });
  });
});
