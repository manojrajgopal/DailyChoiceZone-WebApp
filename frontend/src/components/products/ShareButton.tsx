"use client";

import { useState } from "react";
import { Check, Link2, Share2 } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { toast } from "@/store/toastStore";

/**
 * Share this page.
 *
 * Two behaviours from one button, chosen by what the browser can do. On a
 * phone `navigator.share` opens the operating system's own share sheet, which
 * is what somebody expects when they want to send a product to a friend. On a
 * desktop there is no such sheet, so it copies the link instead.
 *
 * ## Why the URL comes from the address bar
 *
 * `window.location.href` and not a URL built from a base and the product id.
 * The address bar is the one place guaranteed to hold the URL the person is
 * actually looking at, including whatever proxy or port they reached it
 * through, and a link that only works from one origin is worse than no share
 * button. The product page redirects an old slug URL to the canonical id one
 * before this ever renders, so what gets copied is already canonical.
 */
export function ShareButton({
  title,
  text,
  className,
}: {
  /** What is being shared — the product name. */
  title: string;
  /** A sentence for share sheets that show one. */
  text?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  /**
   * Copy, with a fallback.
   *
   * `navigator.clipboard` needs a secure context, so it is absent over plain
   * HTTP on anything but localhost — a real condition on a LAN address during
   * development. The `execCommand` path is deprecated and still the only thing
   * that works there.
   */
  const copy = async (url: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        return true;
      }
    } catch {
      // Denied, or no clipboard permission. Fall through and try the old way.
    }

    try {
      const field = document.createElement("textarea");
      field.value = url;
      field.setAttribute("readonly", "");
      // Off-screen rather than hidden: `display: none` cannot be selected.
      field.style.cssText = "position:fixed;top:-100vh;opacity:0";
      document.body.append(field);
      field.select();
      const done = document.execCommand("copy");
      field.remove();
      return done;
    } catch {
      return false;
    }
  };

  const onShare = async () => {
    const url = window.location.href;

    // The OS share sheet, where there is one.
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (error) {
        // Dismissing the sheet rejects, and is not a failure to report.
        if (error instanceof Error && error.name === "AbortError") return;
        // Anything else: fall through to copying.
      }
    }

    if (await copy(url)) {
      setCopied(true);
      toast.success("Link copied to clipboard");
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Could not copy the link. Copy it from the address bar.");
    }
  };

  return (
    <Button
      size="lg"
      variant="ghost"
      onClick={onShare}
      aria-label={`Share ${title}`}
      className={cn("shrink-0 border border-ink-200 sm:w-14 sm:px-0", className)}
    >
      {copied ? (
        <Check className="h-4 w-4 animate-pop text-copper-700" strokeWidth={1.75} />
      ) : (
        <Share2 className="h-4 w-4" strokeWidth={1.5} />
      )}

      {/* The icon alone carries it from `sm` up, where the label would not fit. */}
      <span className="inline-flex items-center gap-1.5 sm:hidden">
        {copied ? null : <Link2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />}
        {copied ? "Link copied" : "Share"}
      </span>
    </Button>
  );
}
