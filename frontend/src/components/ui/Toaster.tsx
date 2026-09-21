"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Info, TriangleAlert, X } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import { useToastStore, type Toast, type ToastTone } from "@/store/toastStore";

/**
 * The notification surface, mounted once in the root layout.
 *
 * `aria-live="polite"` on the region means additions are announced without
 * interrupting, which is right for "added to bag" — it is useful but not
 * urgent. Each toast owns its own dismissal timer so one expiring does not
 * reset the others.
 */

const TONE_STYLES: Record<ToastTone, string> = {
  success: "border-sage-500/30 bg-shell",
  info: "border-ink-200 bg-shell",
  error: "border-danger/30 bg-danger-bg",
};

const TONE_ICON: Record<ToastTone, React.ReactNode> = {
  success: <Check className="h-4 w-4 text-sage-600" strokeWidth={2} aria-hidden="true" />,
  info: <Info className="h-4 w-4 text-copper-600" strokeWidth={1.75} aria-hidden="true" />,
  error: <TriangleAlert className="h-4 w-4 text-danger" strokeWidth={1.75} aria-hidden="true" />,
};

const DURATION = 4000;

function ToastRow({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((state) => state.dismiss);

  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), DURATION);
    return () => clearTimeout(timer);
  }, [toast.id, dismiss]);

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-card border px-3.5 py-3 shadow-raised",
        TONE_STYLES[toast.tone],
      )}
    >
      <span className="mt-0.5 shrink-0">{TONE_ICON[toast.tone]}</span>

      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">{toast.message}</p>
        {toast.action ? (
          <Link
            href={toast.action.href}
            onClick={() => dismiss(toast.id)}
            className="mt-1 inline-block border-b border-copper-500 pb-0.5 label-wide text-copper-700 transition-colors hover:border-ink hover:text-ink"
          >
            {toast.action.label}
          </Link>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss notification"
        className="-mr-1 -mt-1 shrink-0 rounded-pill p-1 text-ink-400 transition-colors hover:bg-cream-deep hover:text-ink"
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </motion.li>
  );
}

export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);

  return (
    <div
      // Above the mobile sticky bars, and never blocking clicks when empty.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-4 sm:justify-end sm:px-6 sm:pb-6"
      aria-live="polite"
      aria-atomic="false"
    >
      <ul className="flex w-full max-w-sm flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <ToastRow key={toast.id} toast={toast} />
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
