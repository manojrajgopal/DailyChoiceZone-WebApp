/**
 * Validates `src/data` and fails with a non-zero exit code on any problem.
 *
 * Worth running after hand-editing the JSON — which is the intended way to add
 * a real product. It catches the mistakes that are easy to make and annoying to
 * debug through the UI: a duplicate slug, a discount badge that does not match
 * the prices, a collection pointing at a product that no longer exists, or a
 * navigation link to a category that was renamed.
 *
 *   npm run data:check
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
const read = (name) => JSON.parse(readFileSync(join(DATA, name), "utf8"));

const products = read("products.json");
const categories = read("categories.json");
const collections = read("collections.json");
const reviews = read("reviews.json");
const coupons = read("coupons.json");
const navigation = read("navigation.json");
const homepage = read("homepage.json");
// The promo strip is driven by the banners the portal manages.
const banners = read("admin/banners.json");
const siteConfig = read("site-config.json");

const problems = [];
const fail = (message) => problems.push(message);

/* ------------------------------------------------------------- uniqueness */

const duplicates = (values) => {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
};

for (const [label, values] of [
  ["product id", products.map((p) => p.id)],
  ["product slug", products.map((p) => p.slug)],
  ["category slug", categories.map((c) => c.slug)],
  ["collection slug", collections.map((c) => c.slug)],
  ["review id", reviews.map((r) => r.id)],
  ["coupon code", coupons.map((c) => c.code)],
]) {
  const dupes = duplicates(values);
  if (dupes.length) fail(`Duplicate ${label}: ${dupes.join(", ")}`);
}

/* ---------------------------------------------------------------- products */

const categorySlugs = new Set(categories.map((c) => c.slug));
const subcategoriesByCategory = new Map(
  categories.map((c) => [c.slug, new Set(c.groups.flatMap((g) => g.items.map((i) => i.slug)))]),
);

const REQUIRED = [
  "id", "slug", "name", "brand", "category", "subcategory", "price",
  "originalPrice", "discount", "currency", "rating", "reviewCount", "images",
  "colors", "sizes", "description", "material", "tags", "stock", "sku",
];

for (const product of products) {
  const where = product.slug ?? product.id ?? "(unknown)";

  for (const field of REQUIRED) {
    if (product[field] === undefined) fail(`${where}: missing "${field}"`);
  }

  if (!categorySlugs.has(product.category)) {
    fail(`${where}: category "${product.category}" is not in categories.json`);
  } else if (!subcategoriesByCategory.get(product.category)?.has(product.subcategory)) {
    fail(
      `${where}: subcategory "${product.subcategory}" is not listed under category "${product.category}"`,
    );
  }

  if (!(product.price > 0)) fail(`${where}: price must be greater than zero`);
  if (product.originalPrice < product.price) {
    fail(`${where}: originalPrice (${product.originalPrice}) is below price (${product.price})`);
  }

  // The badge on the card must match the arithmetic, or it is misleading.
  const expected =
    product.originalPrice > product.price
      ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)
      : 0;
  if (product.discount !== expected) {
    fail(`${where}: discount is ${product.discount}% but the prices work out to ${expected}%`);
  }

  if (product.rating < 0 || product.rating > 5) fail(`${where}: rating must be between 0 and 5`);
  if (product.stock < 0) fail(`${where}: stock cannot be negative`);
  if (!Array.isArray(product.images) || product.images.length === 0) {
    fail(`${where}: needs at least one image`);
  }
  if (product.currency !== "INR") fail(`${where}: currency must be "INR"`);
}

/* ----------------------------------------------------------- relationships */

const productIds = new Set(products.map((p) => p.id));

for (const collection of collections) {
  const dangling = collection.productIds.filter((id) => !productIds.has(id));
  if (dangling.length) {
    fail(`Collection "${collection.slug}" references unknown products: ${dangling.join(", ")}`);
  }
  if (collection.productIds.length === 0) {
    fail(`Collection "${collection.slug}" is empty`);
  }
}

const orphanReviews = reviews.filter((r) => !productIds.has(r.productId));
if (orphanReviews.length) {
  fail(`${orphanReviews.length} review(s) reference products that no longer exist`);
}

/* -------------------------------------------------------- internal links */

/** Collect every internal href referenced from the config files. */
const hrefs = [
  ...navigation.flatMap((item) => [
    item.href,
    ...(item.columns ?? []).flatMap((col) => col.links.map((l) => l.href)),
    ...(item.promo ? [item.promo.href] : []),
  ]),
  ...siteConfig.footer.flatMap((col) => col.links.map((l) => l.href)),
  ...banners.map((b) => b.buttonLink).filter(Boolean),
  ...homepage.sections.flatMap((s) => [s.viewAllHref, s.ctaHref].filter(Boolean)),
];

const collectionSlugs = new Set(collections.map((c) => c.slug));

for (const href of hrefs) {
  const [path, query = ""] = href.split("?");

  const categoryMatch = path.match(/^\/category\/([^/]+)$/);
  if (categoryMatch && !categorySlugs.has(categoryMatch[1])) {
    fail(`Link "${href}" points at an unknown category`);
  }

  const collectionMatch = path.match(/^\/collection\/([^/]+)$/);
  if (collectionMatch && !collectionSlugs.has(collectionMatch[1])) {
    fail(`Link "${href}" points at an unknown collection`);
  }

  // A ?subcategory= filter that matches nothing would render an empty grid.
  const sub = new URLSearchParams(query).get("subcategory");
  if (sub && categoryMatch) {
    const known = subcategoriesByCategory.get(categoryMatch[1]);
    if (known && !known.has(sub)) {
      fail(`Link "${href}" filters by a subcategory that is not in that category`);
    }
  }
  if (sub && !categoryMatch) {
    const anywhere = [...subcategoriesByCategory.values()].some((set) => set.has(sub));
    if (!anywhere) fail(`Link "${href}" filters by an unknown subcategory`);
  }
}

/* ------------------------------------------------------------- homepage */

const RAIL_SOURCES = new Set([
  "new", "trending", "bestsellers", "featured", "recommended", "deals",
]);

for (const section of homepage.sections) {
  if (section.type === "product-rail") {
    if (!RAIL_SOURCES.has(section.source)) {
      fail(`Homepage section "${section.id}" has unknown source "${section.source}"`);
    }
    if (!(section.limit > 0)) fail(`Homepage section "${section.id}" needs a positive limit`);
  }
}

// Every rail needs enough products to fill it.
const flagCounts = {
  new: products.filter((p) => p.isNew).length,
  trending: products.filter((p) => p.isTrending).length,
  bestsellers: products.filter((p) => p.isBestSeller).length,
  featured: products.filter((p) => p.isFeatured).length,
  deals: products.filter((p) => p.discount >= 20 && p.stock > 0).length,
};

for (const section of homepage.sections) {
  if (section.type !== "product-rail" || section.source === "recommended") continue;
  const available = flagCounts[section.source] ?? 0;
  if (available < section.limit) {
    fail(
      `Homepage rail "${section.title}" wants ${section.limit} products but only ${available} are flagged "${section.source}"`,
    );
  }
}

/* ----------------------------------------------------------------- report */

console.log(
  `Checked ${products.length} products, ${categories.length} categories, ` +
    `${collections.length} collections, ${reviews.length} reviews, ${hrefs.length} internal links.`,
);

if (problems.length === 0) {
  console.log("No problems found.");
} else {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
