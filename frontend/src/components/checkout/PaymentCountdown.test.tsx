import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, renderUI, screen } from "@/test/render";

import { PaymentCountdown } from "./PaymentCountdown";

const NOW = new Date("2026-10-02T10:00:00.000Z").getTime();

function setup(secondsLeft: number) {
  const onExpire = vi.fn();
  const view = renderUI(<PaymentCountdown deadline={NOW + secondsLeft * 1000} onExpire={onExpire} />);
  return { ...view, onExpire };
}

function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("PaymentCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("formatting", () => {
    it.each([
      [600, "10:00"],
      [125, "2:05"],
      [61, "1:01"],
      [60, "1:00"],
      [9, "0:09"],
      [1, "0:01"],
      [3600, "60:00"],
    ])("shows %i seconds as %s left to pay", (seconds, label) => {
      setup(seconds);
      const timer = screen.getByRole("timer");
      expect(timer).toHaveTextContent(`${label} left to pay`);
      expect(timer).toHaveTextContent("your items are held for you until then");
    });

    it("rounds a part-second to the nearest second", () => {
      const onExpire = vi.fn();
      renderUI(<PaymentCountdown deadline={NOW + 90_400} onExpire={onExpire} />);
      expect(screen.getByRole("timer")).toHaveTextContent("1:30 left to pay");
    });
  });

  describe("urgency", () => {
    it("stays quiet to screen readers with more than a minute left", () => {
      setup(61);
      expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "off");
    });

    it("announces itself assertively in the final minute", () => {
      setup(60);
      expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "assertive");
    });

    it("becomes urgent as it crosses the one-minute mark", () => {
      setup(62);
      const timer = screen.getByRole("timer");
      expect(timer).toHaveAttribute("aria-live", "off");
      tick(2000);
      expect(timer).toHaveTextContent("1:00 left to pay");
      expect(timer).toHaveAttribute("aria-live", "assertive");
    });
  });

  describe("counting down", () => {
    it("ticks once a second, recomputed from the clock", () => {
      setup(5);
      expect(screen.getByRole("timer")).toHaveTextContent("0:05");
      tick(1000);
      expect(screen.getByRole("timer")).toHaveTextContent("0:04");
      tick(2000);
      expect(screen.getByRole("timer")).toHaveTextContent("0:02");
    });

    it("jumps straight to the right figure after the tab was suspended", () => {
      setup(300);
      // The clock moves on four minutes while no interval fired.
      vi.setSystemTime(NOW + 240_000);
      tick(1000);
      expect(screen.getByRole("timer")).toHaveTextContent(/0:59|1:00/);
    });

    it("calls onExpire exactly once when the time runs out and says time is up", () => {
      const { onExpire } = setup(2);
      tick(1000);
      expect(onExpire).not.toHaveBeenCalled();
      tick(1000);
      expect(onExpire).toHaveBeenCalledOnce();
      expect(screen.getByRole("timer")).toHaveTextContent("Time is up");
      expect(screen.getByRole("timer")).not.toHaveTextContent("left to pay");
      tick(10_000);
      expect(onExpire).toHaveBeenCalledOnce();
    });

    it("does not fire again when the parent re-renders with a new callback after expiry", () => {
      const first = vi.fn();
      const { rerender } = renderUI(<PaymentCountdown deadline={NOW + 1000} onExpire={first} />);
      tick(1000);
      expect(first).toHaveBeenCalledOnce();
      const second = vi.fn();
      rerender(<PaymentCountdown deadline={NOW + 1000} onExpire={second} />);
      tick(1000);
      expect(second).not.toHaveBeenCalled();
    });

    it("stops its interval when unmounted", () => {
      const clear = vi.spyOn(window, "clearInterval");
      const { unmount, onExpire } = setup(3);
      unmount();
      expect(clear).toHaveBeenCalled();
      tick(10_000);
      expect(onExpire).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it.each([
      ["already passed", -30],
      ["exactly now", 0],
    ])("expires immediately when the deadline is %s", (_, seconds) => {
      const { onExpire } = setup(seconds);
      expect(onExpire).toHaveBeenCalledOnce();
      expect(screen.getByRole("timer")).toHaveTextContent("Time is up");
      expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "assertive");
    });

    it("treats under half a second as time up", () => {
      const onExpire = vi.fn();
      renderUI(<PaymentCountdown deadline={NOW + 400} onExpire={onExpire} />);
      expect(onExpire).toHaveBeenCalledOnce();
    });
  });
});
