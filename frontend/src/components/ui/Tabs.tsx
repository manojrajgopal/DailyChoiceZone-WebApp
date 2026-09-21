"use client";

import { useId, useState } from "react";

import { cn } from "@/lib/utils/cn";

export interface Tab {
  id: string;
  label: string;
  content: React.ReactNode;
}

/**
 * Tabs, following the ARIA tabs pattern.
 *
 * Arrow keys move between tabs and only the active tab is in the tab order —
 * that combination is what the pattern requires, and it is the part people
 * usually leave out.
 */
export function Tabs({ tabs, className }: { tabs: Tab[]; className?: string }) {
  const baseId = useId();
  const [active, setActive] = useState(tabs[0]?.id ?? "");

  if (tabs.length === 0) return null;

  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === active),
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (activeIndex + step + tabs.length) % tabs.length;
    const nextTab = tabs[next];
    if (!nextTab) return;
    setActive(nextTab.id);
    document.getElementById(`${baseId}-tab-${nextTab.id}`)?.focus();
  };

  return (
    <div className={className}>
      <div role="tablist" className="flex gap-6 border-b border-ink-200">
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              id={`${baseId}-tab-${tab.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={onKeyDown}
              className={cn(
                "-mb-px border-b-2 pb-3 pt-1 label-wide transition-colors",
                selected
                  ? "border-ink text-ink"
                  : "border-transparent text-ink-400 hover:text-ink-700",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`${baseId}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={tab.id !== active}
          className="pt-6"
        >
          {tab.id === active ? tab.content : null}
        </div>
      ))}
    </div>
  );
}
