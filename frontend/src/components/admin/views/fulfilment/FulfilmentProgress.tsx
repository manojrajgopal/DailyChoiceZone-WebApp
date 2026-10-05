"use client";

import { AlertTriangle, Check, CircleSlash, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import type { FulfilmentProgress as Progress, LifecycleStep, StepState } from "@/types/fulfilment";

/**
 * The order's lifecycle, every step marked by the server: completed, current,
 * upcoming, skipped, exception or cancelled. Nothing here works out a state
 * for itself, so a future step can never read as done.
 *
 * Each state has its own icon and a text label for screen readers; colour is
 * never the only signal.
 */

const STATE_LABEL: Record<StepState, string> = {
  completed: "Completed",
  current: "Current step",
  upcoming: "Upcoming",
  skipped: "Skipped",
  exception: "Exception",
  cancelled: "Not reached",
};

const DOT: Record<StepState, string> = {
  completed: "bg-[#0ca30c] text-white",
  current: "bg-copper-600 text-white ring-4 ring-copper-500/20",
  upcoming: "bg-admin-surface text-admin-faint ring-1 ring-inset ring-admin-border-strong",
  skipped: "border border-dashed border-admin-border-strong bg-admin-raised text-admin-muted",
  exception: "bg-[#fab219] text-[#5c3d00]",
  cancelled: "bg-admin-raised text-admin-faint",
};

const TEXT: Record<StepState, string> = {
  completed: "text-admin-ink",
  current: "font-semibold text-admin-ink",
  upcoming: "text-admin-muted",
  skipped: "text-admin-muted italic",
  exception: "font-semibold text-[#8a5d00]",
  cancelled: "text-admin-faint line-through",
};

const PHASES: Record<LifecycleStep["phase"], string> = { order: "Order", packing: "Packing", shipment: "Shipment" };

function StepIcon({ step, index }: { step: LifecycleStep; index: number }) {
  const icon = "h-3 w-3";
  if (step.state === "completed") return <Check className={icon} strokeWidth={3} aria-hidden="true" />;
  if (step.state === "exception") return <AlertTriangle className={icon} strokeWidth={2.5} aria-hidden="true" />;
  if (step.state === "skipped") return <Minus className={icon} strokeWidth={2.5} aria-hidden="true" />;
  if (step.state === "cancelled") {
    return step.key === "cancelled" || step.key === "returned"
      ? <X className={icon} strokeWidth={2.5} aria-hidden="true" />
      : <CircleSlash className={icon} strokeWidth={2} aria-hidden="true" />;
  }
  return <span className="text-[0.5625rem] tabular-nums">{index + 1}</span>;
}

export function FulfilmentProgress({ progress }: { progress: Progress }) {
  const steps = progress.steps;
  return (
    <div>
      <ol className="flex flex-col gap-0 lg:flex-row lg:items-start" aria-label="Order progress">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          const phaseStart = index === 0 || steps[index - 1]?.phase !== step.phase;
          return (
            <li
              key={step.key}
              className="flex min-w-0 flex-1 gap-3 lg:flex-col lg:gap-1.5"
              aria-current={step.state === "current" ? "step" : undefined}
              data-state={step.state}
            >
              <div className="flex flex-col items-center lg:w-full lg:flex-row">
                <span
                  className={cn(
                    "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill",
                    DOT[step.state],
                  )}
                >
                  <StepIcon step={step} index={index} />
                </span>
                {!last ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "my-1 w-px flex-1 lg:mx-1 lg:my-0 lg:h-px lg:w-auto",
                      step.state === "completed" || step.state === "skipped" ? "bg-[#0ca30c]/60" : "bg-admin-border",
                      step.state === "skipped" && "bg-admin-border-strong",
                    )}
                  />
                ) : null}
              </div>
              <div className="min-w-0 pb-3 lg:pb-0 lg:pr-1">
                {phaseStart ? (
                  <span className="block text-[0.5625rem] font-medium uppercase tracking-[0.06em] text-admin-faint">
                    {PHASES[step.phase]}
                  </span>
                ) : (
                  <span className="hidden text-[0.5625rem] lg:block" aria-hidden="true">&nbsp;</span>
                )}
                <span className={cn("block text-[0.6875rem] leading-snug", TEXT[step.state])}>{step.label}</span>
                <span className="sr-only">: {STATE_LABEL[step.state]}</span>
                {step.state === "skipped" ? (
                  <span className="block text-[0.5625rem] text-admin-faint" aria-hidden="true">Skipped</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.625rem] text-admin-muted" aria-label="Legend">
        {(["completed", "current", "upcoming", "skipped", "exception"] as StepState[]).map((state) => (
          <li key={state} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("inline-block h-2.5 w-2.5 rounded-pill", DOT[state])} />
            {STATE_LABEL[state]}
          </li>
        ))}
      </ul>
    </div>
  );
}
