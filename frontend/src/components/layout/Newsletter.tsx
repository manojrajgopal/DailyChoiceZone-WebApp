"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";

import { toast } from "@/store/toastStore";

/**
 * Newsletter sign-up.
 *
 * The one form with nothing behind it: a valid address simply confirms, and
 * the email is not stored or transmitted anywhere. A mailing list is a
 * third-party service rather than a table in this database, so when one is
 * chosen, only `onSubmit` changes.
 */
export function Newsletter() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }

    setError(null);
    setEmail("");
    toast.success("You are on the list. Watch your inbox for first looks.");
  };

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm">
      <label htmlFor="newsletter-email" className="label-wide text-cream/70">
        Join the list
      </label>
      <p className="mt-2 text-sm leading-relaxed text-cream/60">
        First looks at new arrivals and the occasional member-only reduction. No noise.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          id="newsletter-email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (error) setError(null);
          }}
          placeholder="you@example.com"
          autoComplete="email"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "newsletter-error" : undefined}
          className="h-11 min-w-0 flex-1 rounded-control border border-cream/25 bg-transparent px-3.5 text-sm text-cream placeholder:text-cream/40 focus:border-cream/60"
        />
        <button
          type="submit"
          aria-label="Subscribe to the newsletter"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-cream text-ink transition-colors hover:bg-copper-200"
        >
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      {error ? (
        <p id="newsletter-error" role="alert" className="mt-2 text-xs text-blush-500">
          {error}
        </p>
      ) : null}
    </form>
  );
}
