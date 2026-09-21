import type { Metadata } from "next";
import { Suspense } from "react";

import { SearchView } from "@/components/search/SearchView";
import { ProductGridSkeleton } from "@/components/ui/Skeleton";

export const metadata: Metadata = {
  title: "Search",
  description: "Search the Daily Choice Zone catalogue by product, brand, category or material.",
  // Search result pages should not be indexed.
  robots: { index: false, follow: true },
};

/**
 * Server wrapper for metadata.
 *
 * The results themselves are client-side: `useSearchParams` needs a Suspense
 * boundary, and the term cannot be read on the server in a static export.
 */
export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="page-shell py-8 sm:py-10">
          <ProductGridSkeleton count={12} />
        </div>
      }
    >
      <SearchView />
    </Suspense>
  );
}
