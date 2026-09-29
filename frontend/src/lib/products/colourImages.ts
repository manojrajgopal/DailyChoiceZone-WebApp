import type { Product } from "@/types";

/**
 * Photographs per colour.
 *
 * Mirrors `images_for` in `backend/app/models/catalogue.py`: a colour's own
 * images when it has any, otherwise the product's shared images, otherwise the
 * first colour that has images. Never empty while the product has a photo.
 */
export function imagesFor(product: Product, color?: string | null): string[] {
  if (color) {
    const own = product.colors.find((entry) => entry.name === color)?.images ?? [];
    if (own.length) return own;
  }
  if (product.images.length) return product.images;
  return product.colors.find((entry) => entry.images?.length)?.images ?? [];
}

/** The colours that have been photographed in their own right. */
export function photographedColours(product: Product): string[] {
  return product.colors.filter((entry) => entry.images?.length).map((entry) => entry.name);
}

/** The colour to show first: the requested one if the product has it. */
export function initialColour(product: Product, requested?: string | null): string | null {
  if (requested && product.colors.some((entry) => entry.name === requested)) return requested;
  return product.colors[0]?.name ?? null;
}

export interface ProductVariant {
  product: Product;
  /** The colour this card shows, or null for "the product in general". */
  color: string | null;
}

/**
 * One card per photographed colour.
 *
 * A product sold in Charcoal and White, each with its own photographs, is two
 * things a shopper browses for, so a listing shows both. Colours without their
 * own photographs would show the same picture twice, so a product with none
 * stays a single card.
 *
 * `colourFilter` is the listing's colour filter: when set, only the matching
 * colourways are shown — searching for "red" shows the red one.
 */
export function expandVariants(products: Product[], colourFilter: string[] = []): ProductVariant[] {
  const wanted = new Set(colourFilter.map((name) => name.toLowerCase()));

  return products.flatMap((product) => {
    const photographed = photographedColours(product);
    if (photographed.length < 2) {
      const match = wanted.size
        ? product.colors.find((entry) => wanted.has(entry.name.toLowerCase()))?.name ?? null
        : null;
      return [{ product, color: match ?? photographed[0] ?? null }];
    }

    const shown = wanted.size
      ? photographed.filter((name) => wanted.has(name.toLowerCase()))
      : photographed;
    return (shown.length ? shown : photographed.slice(0, 1)).map((color) => ({ product, color }));
  });
}

/** The product page for this product, opened in this colour. */
export function productHref(product: Product, color?: string | null): string {
  return color && product.colors.length > 1
    ? `/product/${product.id}?color=${encodeURIComponent(color)}`
    : `/product/${product.id}`;
}
