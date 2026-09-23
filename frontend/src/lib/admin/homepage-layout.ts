import adminHomepageJson from "@/data/admin/homepage.json";

import type { AdminHomeSection } from "@/types/admin";
import type { HomeSectionLayout } from "@/types";

import { OVERLAY_KEYS, readDocument } from "./mock-store";

/**
 * Which homepage sections are live, and in what order.
 *
 * The storefront's `homepage.json` says what a section *is* — its title, its
 * merchandising query, how it renders. The portal's `admin/homepage.json` says
 * whether it is switched on and where it sits. They are joined by section id.
 *
 * Keeping them apart is deliberate: the customer payload has no business
 * carrying an editor's display order, and the portal has no business
 * redefining what a rail queries. But the storefront does have to honour the
 * switch — an administrator who hides a section and then sees it still on the
 * homepage has been lied to. This module is that join, and it is the only
 * place either side learns about the other.
 */

const BASE = adminHomepageJson as AdminHomeSection[];

export function homeSectionLayout(): HomeSectionLayout[] {
  const sections = readDocument(OVERLAY_KEYS.homepage, BASE);

  return [...sections]
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((section) => ({ id: section.id, active: section.active }));
}
