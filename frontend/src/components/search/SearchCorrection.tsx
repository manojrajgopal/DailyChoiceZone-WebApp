import Link from "next/link";

import type { SearchMeta } from "@/types";

/**
 * "Showing results for *steel bottle* — no results for *stel botle*."
 *
 * The API only substitutes its dictionary correction when the typed term
 * found nothing at all, so there is no "search for the original instead"
 * link: that search is, by definition, empty. Instead the corrected term is
 * a real link, so the shopper can make it their own search (and URL).
 */
export function SearchCorrection({ meta }: { meta: SearchMeta | null | undefined }) {
  const corrected = meta?.correctedTerm?.trim();
  if (!meta || !corrected) return null;

  return (
    <div role="status" className="mb-5 rounded-card border border-ink-200 bg-cream-deep px-4 py-3 text-sm text-ink-700">
      <p>
        Showing results for{" "}
        <Link
          href={`/search?q=${encodeURIComponent(corrected)}`}
          className="font-medium text-ink underline underline-offset-2 hover:text-copper-700"
        >
          {corrected}
        </Link>
      </p>
      <p className="mt-0.5 text-xs text-ink-500">
        You searched for &ldquo;{meta.term}&rdquo;, which found no matches.
      </p>
    </div>
  );
}
