/**
 * Where an image address points, for an `<img>` or `next/image`.
 *
 * Photographs uploaded through the portal are stored as `/uploads/products/…`,
 * a path on the API. They are shown through the storefront's own `/media/…`
 * route (see `app/media/[...path]/route.ts`) rather than straight from the API
 * host: same-origin for the browser, and immune to a tunnel's warning page
 * that an `<img>` cannot bypass. Every other address — an Unsplash URL, say —
 * is returned unchanged.
 */
export function mediaUrl(src: string | undefined | null): string | undefined {
  if (!src) return undefined;
  if (src.startsWith("/uploads/")) return `/media/${src.slice("/uploads/".length)}`;
  return src;
}
