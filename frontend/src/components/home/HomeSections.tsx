"use client";

import { useEffect, useState, type ReactNode } from "react";

import type { HomeSectionLayout } from "@/types";
import { getHomeSectionLayout } from "@/services/siteService";

/**
 * Applies the live homepage layout to sections rendered at build time.
 *
 * The sections themselves have to be rendered on the server — each one runs a
 * merchandising query, and they are the page's actual content, so they belong
 * in the static HTML rather than appearing after a round trip. But whether a
 * section is switched on, and where it sits, is editorial state that changes
 * in the portal long after the build.
 *
 * So the server renders every section the config defines and hands them here
 * in build order, along with the layout as it stood at build time. That is
 * what the static HTML contains and what hydration matches. Once mounted this
 * re-reads the layout and applies whatever an administrator has since changed.
 *
 * Sections switched off are rendered and then hidden rather than never
 * rendered, because the switch works both ways — one turned back on has to be
 * able to appear without a rebuild.
 */
export function HomeSections({
  sections,
  initialLayout,
}: {
  sections: { id: string; node: ReactNode }[];
  initialLayout: HomeSectionLayout[];
}) {
  const [layout, setLayout] = useState(initialLayout);

  useEffect(() => {
    let active = true;
    void getHomeSectionLayout().then((fresh) => {
      if (active) setLayout(fresh);
    });
    return () => {
      active = false;
    };
  }, []);

  const byId = new Map(sections.map((section) => [section.id, section.node]));

  const ordered = layout
    .filter((entry) => entry.active && byId.has(entry.id))
    .map((entry) => ({ id: entry.id, node: byId.get(entry.id) }));

  /**
   * A section the layout has never heard of still renders, at the end. The
   * layout is editorial state and can lag a deploy that adds a rail; dropping
   * the rail silently would be the worse failure.
   */
  const known = new Set(layout.map((entry) => entry.id));
  const unlisted = sections.filter((section) => !known.has(section.id));

  return (
    <div className="flex flex-col gap-16 py-10 sm:gap-20 sm:py-12">
      {[...ordered, ...unlisted].map((section) => (
        <div key={section.id}>{section.node}</div>
      ))}
    </div>
  );
}
