"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Seconds left until a moment, ticking once a second.
 *
 * Measured against the clock rather than counted down, so a throttled
 * background tab still shows the right number when it comes back. `restart`
 * starts it again from a new number of seconds (a fresh code, or "wait 30
 * seconds" from the API).
 */
export function useCountdown(initialSeconds: number): [number, (seconds: number) => void] {
  const [endsAt, setEndsAt] = useState(() => Date.now() + Math.max(0, initialSeconds) * 1000);
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil(initialSeconds)));

  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setRemaining(left);
      return left;
    };
    const id = setInterval(() => {
      if (tick() === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  const restart = useCallback((seconds: number) => {
    setEndsAt(Date.now() + Math.max(0, seconds) * 1000);
    setRemaining(Math.max(0, Math.ceil(seconds)));
  }, []);

  return [remaining, restart];
}

/** 75 → "1:15". */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
