"use client";

import { createContext, useCallback, useContext, useState } from "react";

import type { Product } from "@/types";

import { imagesFor, initialColour } from "@/lib/products/colourImages";

import { ProductGallery } from "./ProductGallery";

/**
 * The chosen colour, shared by the gallery and the buy box.
 *
 * They are siblings on the product page, so the choice lives here rather than
 * inside the buy box, where the gallery could not see it. Choosing a colour
 * swaps the photographs to that colour's and writes `?color=` into the
 * address, so a copied link opens on the colour the shopper was looking at.
 */
interface ColourState {
  color: string | null;
  setColor: (color: string | null) => void;
  images: string[];
}

const ColourContext = createContext<ColourState | null>(null);

export function ProductColourScope({
  product,
  requestedColor,
  children,
}: {
  product: Product;
  /** `?color=` from the address, if any. Ignored unless the product has it. */
  requestedColor?: string | null;
  children: React.ReactNode;
}) {
  const [color, setColorState] = useState<string | null>(() =>
    initialColour(product, requestedColor),
  );

  const setColor = useCallback(
    (next: string | null) => {
      setColorState(next);
      if (typeof window === "undefined" || product.colors.length < 2) return;
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("color", next);
      else url.searchParams.delete("color");
      // Replace, not push: flicking through colours is not navigation, and
      // Back should leave the product rather than step through swatches.
      window.history.replaceState(window.history.state, "", url);
    },
    [product.colors.length],
  );

  return (
    <ColourContext.Provider value={{ color, setColor, images: imagesFor(product, color) }}>
      {children}
    </ColourContext.Provider>
  );
}

/** The shared colour, or null outside a `ProductColourScope`. */
export function useProductColour(): ColourState | null {
  return useContext(ColourContext);
}

/**
 * The gallery for the chosen colour. Keyed by colour, so a change starts the
 * new set at its first photograph instead of keeping an index into the old.
 */
export function ProductColourGallery({ product }: { product: Product }) {
  const scope = useProductColour();
  const images = scope?.images ?? product.images;
  const label = scope?.color ? `${product.name} in ${scope.color}` : product.name;
  return <ProductGallery key={scope?.color ?? "all"} images={images} name={label} />;
}
