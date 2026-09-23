"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Measure a container's width so a chart can render at real pixel size.
 *
 * The alternative — a fixed `viewBox` scaled with CSS — also scales the text,
 * so axis labels end up around 5px on a phone. Measuring keeps typography at
 * its intended size at every width, which is the whole point of putting labels
 * on a chart.
 */
export function useElementWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });

    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
