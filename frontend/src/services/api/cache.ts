import { cache } from "react";

/**
 * Read something once per page, not once per process.
 *
 * The configuration documents are read by several components on the same page
 * — the FAQ, a form's state list, the currency `formatMoney` needs — so
 * fetching per caller would be a handful of identical requests to render one
 * screen. They want caching.
 *
 * What they do **not** want is caching that outlives the page, and that is the
 * trap this exists to avoid. Module state on a Node server lives as long as
 * the process: a plain `let cached` meant an administrator could save a change,
 * see it in the portal, and never see it on a server-rendered page again until
 * somebody restarted the server. Exactly the staleness that moving this data
 * into a database was meant to end.
 *
 * So the lifetime differs by where the code is running, because "one page" is
 * a different thing in each:
 *
 * - **On the server** React's `cache` scopes it to the request. Several
 *   components rendering the same page share one fetch; the next request
 *   starts clean.
 * - **In the browser** a module lives as long as the document, which is the
 *   right lifetime already. `invalidate` exists for the one case that is not
 *   true: the portal saving the very document it is looking at.
 */
export interface PageCache<T> {
  read: () => Promise<T>;
  /** Drop the browser's copy, so the next read sees a change just saved. */
  invalidate: () => void;
}

export function pageCache<T>(fetcher: () => Promise<T>): PageCache<T> {
  const perRequest = cache(fetcher);
  let inDocument: Promise<T> | null = null;

  return {
    read: () => {
      if (typeof window === "undefined") return perRequest();
      // A failure is not kept: a request made with an expired session would
      // otherwise be the answer for the rest of the page's life, however many
      // times the user signed in again.
      inDocument ??= fetcher().catch((error: unknown) => {
        inDocument = null;
        throw error;
      });
      return inDocument;
    },
    invalidate: () => {
      inDocument = null;
    },
  };
}
