import { describe, expect, it } from "vitest";

import { makeProduct } from "@/test/sliceA-fixtures";

import { expandVariants, imagesFor, initialColour, photographedColours, productHref } from "./colourImages";

describe("imagesFor", () => {
  const product = makeProduct({
    images: ["/shared.jpg"],
    colors: [
      { name: "Red", hex: "#f00", images: ["/red1.jpg", "/red2.jpg"] },
      { name: "Blue", hex: "#00f" },
    ],
  });

  it("uses the colour's own images when present", () => {
    expect(imagesFor(product, "Red")).toEqual(["/red1.jpg", "/red2.jpg"]);
  });

  it("falls back to the product's shared images when the colour has none", () => {
    expect(imagesFor(product, "Blue")).toEqual(["/shared.jpg"]);
  });

  it("falls back to shared images when no colour is requested", () => {
    expect(imagesFor(product)).toEqual(["/shared.jpg"]);
  });

  it("falls back to any photographed colour when the product itself has no shared images", () => {
    const noShared = makeProduct({ images: [], colors: [{ name: "Red", hex: "#f00", images: ["/red.jpg"] }] });
    expect(imagesFor(noShared)).toEqual(["/red.jpg"]);
  });

  it("is empty when nothing has images", () => {
    const bare = makeProduct({ images: [], colors: [{ name: "Red", hex: "#f00" }] });
    expect(imagesFor(bare)).toEqual([]);
  });

  it("ignores a requested colour that does not exist on the product", () => {
    expect(imagesFor(product, "Green")).toEqual(["/shared.jpg"]);
  });

  it("ignores a null or empty requested colour", () => {
    expect(imagesFor(product, null)).toEqual(["/shared.jpg"]);
    expect(imagesFor(product, "")).toEqual(["/shared.jpg"]);
  });
});

describe("photographedColours", () => {
  it("lists only colours with their own images", () => {
    const product = makeProduct({
      colors: [
        { name: "Red", hex: "#f00", images: ["/r.jpg"] },
        { name: "Blue", hex: "#00f" },
        { name: "Green", hex: "#0f0", images: [] },
      ],
    });
    expect(photographedColours(product)).toEqual(["Red"]);
  });

  it("is empty when no colour has images", () => {
    const product = makeProduct({ colors: [{ name: "Blue", hex: "#00f" }] });
    expect(photographedColours(product)).toEqual([]);
  });
});

describe("initialColour", () => {
  const product = makeProduct({ colors: [{ name: "Red", hex: "#f00" }, { name: "Blue", hex: "#00f" }] });

  it("uses the requested colour when the product has it", () => {
    expect(initialColour(product, "Blue")).toBe("Blue");
  });

  it("falls back to the first colour when the request doesn't match", () => {
    expect(initialColour(product, "Green")).toBe("Red");
  });

  it("falls back to the first colour when nothing is requested", () => {
    expect(initialColour(product)).toBe("Red");
    expect(initialColour(product, null)).toBe("Red");
  });

  it("is null for a product with no colours", () => {
    expect(initialColour(makeProduct({ colors: [] }))).toBeNull();
  });
});

describe("expandVariants", () => {
  it("is one card for a product with fewer than two photographed colours", () => {
    const product = makeProduct({ id: "P1", colors: [{ name: "Red", hex: "#f00", images: ["/r.jpg"] }, { name: "Blue", hex: "#00f" }] });
    const variants = expandVariants([product]);
    expect(variants).toEqual([{ product, color: "Red" }]);
  });

  it("is one card per photographed colour for a product with two or more", () => {
    const product = makeProduct({
      id: "P1",
      colors: [
        { name: "Red", hex: "#f00", images: ["/r.jpg"] },
        { name: "Blue", hex: "#00f", images: ["/b.jpg"] },
      ],
    });
    const variants = expandVariants([product]);
    expect(variants).toEqual([
      { product, color: "Red" },
      { product, color: "Blue" },
    ]);
  });

  it("filters to the requested colourway when a colour filter is given", () => {
    const product = makeProduct({
      id: "P1",
      colors: [
        { name: "Red", hex: "#f00", images: ["/r.jpg"] },
        { name: "Blue", hex: "#00f", images: ["/b.jpg"] },
      ],
    });
    const variants = expandVariants([product], ["blue"]);
    expect(variants).toEqual([{ product, color: "Blue" }]);
  });

  it("falls back to just the first photographed colour when the filter matches none", () => {
    const product = makeProduct({
      id: "P1",
      colors: [
        { name: "Red", hex: "#f00", images: ["/r.jpg"] },
        { name: "Blue", hex: "#00f", images: ["/b.jpg"] },
      ],
    });
    const variants = expandVariants([product], ["green"]);
    expect(variants.map((v) => v.color)).toEqual(["Red"]);
  });

  it("picks the matching colour for a single-card product when a filter is given", () => {
    const product = makeProduct({ id: "P1", colors: [{ name: "Red", hex: "#f00" }, { name: "Blue", hex: "#00f" }] });
    const variants = expandVariants([product], ["blue"]);
    expect(variants).toEqual([{ product, color: "Blue" }]);
  });

  it("is empty for an empty product list", () => {
    expect(expandVariants([])).toEqual([]);
  });
});

describe("productHref", () => {
  it("includes the colour when the product has more than one", () => {
    const product = makeProduct({ id: "P1", colors: [{ name: "Red", hex: "#f00" }, { name: "Blue", hex: "#00f" }] });
    expect(productHref(product, "Red")).toBe("/product/P1?color=Red");
  });

  it("omits the colour for a single-colour product", () => {
    const product = makeProduct({ id: "P1", colors: [{ name: "Red", hex: "#f00" }] });
    expect(productHref(product, "Red")).toBe("/product/P1");
  });

  it("omits the colour when none is given", () => {
    const product = makeProduct({ id: "P1", colors: [{ name: "Red", hex: "#f00" }, { name: "Blue", hex: "#00f" }] });
    expect(productHref(product)).toBe("/product/P1");
  });

  it("URL-encodes a colour name with special characters", () => {
    const product = makeProduct({ id: "P1", colors: [{ name: "Red & Gold", hex: "#f00" }, { name: "Blue", hex: "#00f" }] });
    expect(productHref(product, "Red & Gold")).toBe("/product/P1?color=Red%20%26%20Gold");
  });
});
