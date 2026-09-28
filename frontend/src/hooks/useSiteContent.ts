"use client";

import { useEffect, useState } from "react";

import type { SiteContent } from "@/types";

import { getSiteContent } from "@/services/siteService";

/**
 * The lists a client component renders — states, topics, methods, dropdowns.
 *
 * Null until it arrives. Callers render their surrounding form and leave the
 * one select empty for that tick, which is preferable to shipping a second
 * copy of the data in the bundle so it can be shown a moment sooner.
 *
 * `getSiteContent` shares one request between every caller, so a page with
 * four of these hooks makes one call.
 */
export function useSiteContent(): SiteContent | null {
  const [content, setContent] = useState<SiteContent | null>(null);

  useEffect(() => {
    let active = true;

    getSiteContent()
      .then((result) => {
        if (active) setContent(result);
      })
      .catch(() => {
        /* the page renders without it */
      });

    return () => {
      active = false;
    };
  }, []);

  return content;
}
