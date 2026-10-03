/** Facets, as `GET /api/products/facets` sends them, for the search & filters tests. */
import type { ProductFacets } from "@/types";

export function makeFacets(overrides: Partial<ProductFacets> = {}): ProductFacets {
  return {
    categories: [
      { value: "kitchen", label: "Kitchen", count: 41 },
      { value: "home", label: "Home", count: 0 },
    ],
    subcategories: [
      { value: "bottles", label: "bottles", count: 12, parent: "kitchen" },
      { value: "lunch-boxes", label: "lunch-boxes", count: 3, parent: "kitchen" },
    ],
    brands: [
      { value: "Anvi", label: "Anvi", count: 9 },
      { value: "Meridian", label: "Meridian", count: 4 },
    ],
    sizes: [
      { value: "M", label: "M", count: 4 },
      { value: "L", label: "L", count: 0 },
    ],
    colors: [{ value: "Red", label: "Red", count: 3, hex: "#cc0000" }],
    priceRange: { min: 99, max: 4999 },
    priceBuckets: [
      { min: 0, max: 500, label: "Under ₹500", count: 10 },
      { min: 500, max: 1000, label: "₹500 – ₹1,000", count: 7 },
      { min: 5000, max: null, label: "Over ₹5,000", count: 0 },
    ],
    ratings: [
      { value: "4", label: "4★ & above", count: 20 },
      { value: "3", label: "3★ & above", count: 0 },
    ],
    discounts: [
      { value: "10", label: "10% or more", count: 15 },
      { value: "50", label: "50% or more", count: 0 },
    ],
    availability: { inStock: 35, outOfStock: 6 },
    attributes: [
      {
        code: "material",
        label: "Material",
        type: "multi",
        unit: "",
        options: [
          { value: "steel", label: "Steel", count: 8 },
          { value: "glass", label: "Glass", count: 0 },
        ],
        range: null,
      },
      { code: "capacity", label: "Capacity", type: "number", unit: "ml", options: [], range: { min: 250, max: 1500 } },
      {
        code: "dishwasher_safe",
        label: "Dishwasher safe",
        type: "boolean",
        unit: "",
        options: [
          { value: "true", label: "Yes", count: 6 },
          { value: "false", label: "No", count: 2 },
        ],
        range: null,
      },
    ],
    ...overrides,
  };
}
