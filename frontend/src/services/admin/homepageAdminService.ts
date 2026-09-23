import type { AdminHomeSection, AdminResult, HomeSectionKind } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/**
 * Homepage composition.
 *
 * The storefront renders whatever its homepage configuration describes; this is
 * the admin view of that same document, with `active` and `displayOrder` added
 * so sections can be toggled and reordered rather than deleted and retyped.
 */

export const SECTION_KINDS: { value: HomeSectionKind; label: string; needsSource: boolean }[] = [
  { value: "product-carousel", label: "Product carousel", needsSource: true },
  { value: "product-grid", label: "Product grid", needsSource: true },
  { value: "featured-products", label: "Featured products", needsSource: true },
  { value: "category-grid", label: "Category grid", needsSource: false },
  { value: "collection-grid", label: "Collection grid", needsSource: false },
  { value: "promo-banner", label: "Promo banner", needsSource: false },
];

export const SECTION_SOURCES = [
  { value: "new-arrivals", label: "New arrivals" },
  { value: "trending", label: "Trending now" },
  { value: "bestsellers", label: "Best sellers" },
  { value: "featured", label: "Featured" },
  { value: "recommended", label: "Recommended" },
  { value: "deals", label: "Deals" },
];

export function getSections(): Promise<AdminHomeSection[]> {
  return adminDataSource.getHomepage();
}

export function saveSections(sections: AdminHomeSection[]): Promise<AdminHomeSection[]> {
  return adminDataSource.saveHomepage(sections);
}

/** Move a section one place up or down. The adapter renumbers on save. */
export async function moveSection(
  id: string,
  direction: "up" | "down",
): Promise<AdminHomeSection[]> {
  const sections = await adminDataSource.getHomepage();
  const index = sections.findIndex((section) => section.id === id);
  const target = direction === "up" ? index - 1 : index + 1;

  // Already at the end it is being moved toward — nothing to do.
  if (index === -1 || target < 0 || target >= sections.length) return sections;

  const reordered = [...sections];
  const moved = reordered[index]!;
  reordered[index] = reordered[target]!;
  reordered[target] = moved;

  return adminDataSource.saveHomepage(reordered);
}

export async function toggleSection(id: string): Promise<AdminHomeSection[]> {
  const sections = await adminDataSource.getHomepage();
  return adminDataSource.saveHomepage(
    sections.map((section) =>
      section.id === id ? { ...section, active: !section.active } : section,
    ),
  );
}

export async function saveSection(
  section: AdminHomeSection,
): Promise<AdminResult<AdminHomeSection>> {
  if (section.title.trim().length < 2) {
    return { ok: false, reason: "Enter a section title." };
  }

  const kind = SECTION_KINDS.find((entry) => entry.value === section.type);
  if (kind?.needsSource && !section.source) {
    return { ok: false, reason: "Choose which products feed this section." };
  }
  if (kind?.needsSource && section.limit < 1) {
    return { ok: false, reason: "Show at least one product." };
  }

  const sections = await adminDataSource.getHomepage();
  const exists = sections.some((entry) => entry.id === section.id);
  const next = exists
    ? sections.map((entry) => (entry.id === section.id ? section : entry))
    : [...sections, section];

  await adminDataSource.saveHomepage(next);
  return { ok: true, data: section };
}

export async function deleteSection(id: string): Promise<AdminResult<string>> {
  const sections = await adminDataSource.getHomepage();
  const section = sections.find((entry) => entry.id === id);
  if (!section) return { ok: false, reason: "That section no longer exists." };

  await adminDataSource.saveHomepage(sections.filter((entry) => entry.id !== id));
  return { ok: true, data: section.title };
}

export function emptySection(order: number): AdminHomeSection {
  return {
    id: `section_${Date.now()}`,
    type: "product-carousel",
    title: "",
    subtitle: "",
    source: "new-arrivals",
    limit: 6,
    active: true,
    displayOrder: order,
  };
}
