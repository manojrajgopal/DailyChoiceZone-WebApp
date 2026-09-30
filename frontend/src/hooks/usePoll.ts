"use client";

import { useEffect, useRef } from "react";

/**
 * Call `task` every `intervalMs` while the page is visible.
 *
 * The support chat and the desk refresh this way rather than over a socket:
 * the backend keeps unread counts and typing times on the ticket, so a
 * short poll is all a conversation needs, with no extra server to run. A
 * hidden tab stops asking, and catches up the moment it is shown again.
 */
export function usePoll(task: () => void, intervalMs: number, enabled = true): void {
  const saved = useRef(task);

  useEffect(() => {
    saved.current = task;
  }, [task]);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (typeof document === "undefined" || !document.hidden) saved.current();
    };
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!document.hidden) saved.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, enabled]);
}
