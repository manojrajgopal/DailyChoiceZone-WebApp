import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePoll } from "./usePoll";

describe("usePoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the task every interval while enabled", () => {
    const task = vi.fn();
    renderHook(() => usePoll(task, 1000));

    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(task).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("never calls the task when disabled", () => {
    const task = vi.fn();
    renderHook(() => usePoll(task, 1000, false));
    vi.advanceTimersByTime(5000);
    expect(task).not.toHaveBeenCalled();
  });

  it("stops polling once disabled", () => {
    const task = vi.fn();
    const { rerender } = renderHook(({ enabled }) => usePoll(task, 1000, enabled), {
      initialProps: { enabled: true },
    });
    vi.advanceTimersByTime(1000);
    expect(task).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    vi.advanceTimersByTime(5000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("uses the latest task without restarting the timer, so a changing closure is always called", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ task }) => usePoll(task, 1000), {
      initialProps: { task: first },
    });
    rerender({ task: second });
    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while the document is hidden", () => {
    const task = vi.fn();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    renderHook(() => usePoll(task, 1000));
    vi.advanceTimersByTime(1000);
    expect(task).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("polls immediately when the tab becomes visible again", () => {
    const task = vi.fn();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    renderHook(() => usePoll(task, 5000));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("does not call the task on visibilitychange while hidden", () => {
    const task = vi.fn();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    renderHook(() => usePoll(task, 5000));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(task).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("clears the interval and listener on unmount", () => {
    const task = vi.fn();
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => usePoll(task, 1000));
    unmount();
    vi.advanceTimersByTime(5000);
    expect(task).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("restarts the interval when intervalMs changes", () => {
    const task = vi.fn();
    const { rerender } = renderHook(({ ms }) => usePoll(task, ms), { initialProps: { ms: 1000 } });
    rerender({ ms: 2000 });
    vi.advanceTimersByTime(1000);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
