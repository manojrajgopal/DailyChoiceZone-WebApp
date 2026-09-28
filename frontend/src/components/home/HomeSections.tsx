import type { ReactNode } from "react";

import type { HomeSectionLayout } from "@/types";

/**
 * Applies the homepage layout to the sections the server rendered.
 *
 * Each section runs a merchandising query, so they are rendered on the server
 * and handed here as nodes; this decides which of them appear and in what
 * order.
 *
 * It does **not** fetch the layout. It used to: back when the site was a
 * static export, the HTML carried whatever layout existed at build time and a
 * client read was the only way an administrator's reorder could show. Pages
 * render per request now, so `initialLayout` *is* the live layout and that
 * read asked for an answer the page already had — one wasted request on every
 * visit to the busiest page on the site.
 */
export function HomeSections({
  sections,
  initialLayout,
}: {
  sections: { id: string; node: ReactNode }[];
  initialLayout: HomeSectionLayout[];
}) {
  const layout = initialLayout;

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
