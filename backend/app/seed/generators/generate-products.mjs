/**
 * Generates `app/seed/data/products.json` and `app/seed/data/reviews.json`.
 *
 * Why a generator rather than hand-written JSON: it guarantees unique ids and
 * slugs, keeps derived fields (discount, sku) internally consistent, and lets
 * the catalogue grow without hand-maintaining a thousand lines of literals.
 *
 * The output is committed and is the app's source of truth — nothing reads
 * this script at runtime. Re-run it with `npm run data:generate` only when you
 * want to regenerate the dummy catalogue. Every value is derived from a hash of
 * the product slug, so output is stable across runs: no diff churn, and server
 * and client always agree.
 *
 * To add a single real product, edit products.json directly. To reshape the
 * whole dummy catalogue, edit the specs below.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

/* ---------------------------------------------------------------- utilities */

/** Deterministic 32-bit hash, so a slug always yields the same numbers. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, seedable PRNG. */
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (arr, r) => arr[Math.floor(r() * arr.length) % arr.length];

function pickMany(arr, count, r) {
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  }
  return out;
}

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

/** Round to a price that looks retail-real: ends in 9, 49 or 99. */
function retailPrice(value) {
  if (value < 1000) return Math.round(value / 10) * 10 - 1;
  return Math.round(value / 50) * 50 - 1;
}

const img = (id, w = 900) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;

/* ------------------------------------------------------------- image pools */
/* Only IDs verified as reachable are listed here. */

const IMAGES = {
  women: [
    "photo-1521572163474-6864f9cf17ab", "photo-1523381210434-271e8be1f52b",
    "photo-1434389677669-e08b4cac3105", "photo-1487222477894-8943e31ef7b2",
    "photo-1490481651871-ab68de25d43d", "photo-1503342217505-b0a15ec3261c",
    "photo-1496747611176-843222e1e57c", "photo-1479064555552-3ef4979f8908",
    "photo-1485462537746-965f33f7f6a7", "photo-1495121605193-b116b5b9c5fe",
    "photo-1594633312681-425c7b97ccd1", "photo-1554568218-0f1715e72254",
  ],
  men: [
    "photo-1516257984-b1b4d707412e", "photo-1507003211169-0a1dd7228f2d",
    "photo-1602810318383-e386cc2a3ccf", "photo-1617137968427-85924c800a22",
    "photo-1473966968600-fa801b869a1a", "photo-1622519407650-3df9883f76a5",
  ],
  footwear: [
    "photo-1542291026-7eec264c27ff", "photo-1460353581641-37baddab0fa2",
    "photo-1549298916-b41d501d3772", "photo-1595950653106-6c9ebd614d3a",
    "photo-1600185365926-3a2ce3cdb9eb",
  ],
  bags: [
    "photo-1553062407-98eeb64c6a62", "photo-1548036328-c9fa89d128fa",
    "photo-1594223274512-ad4803739b7c", "photo-1591561954557-26941169b49e",
  ],
  jewellery: [
    "photo-1515562141207-7a88fb7ce338", "photo-1599643478518-a784e5dc4c8f",
    "photo-1611591437281-460bfbe1220a", "photo-1584917865442-de89df76afd3",
    "photo-1523275335684-37898b6baf30",
  ],
  beauty: [
    "photo-1522335789203-aabd1fc54bc9", "photo-1596462502278-27bfdc403348",
    "photo-1571781926291-c477ebfd024b", "photo-1586495777744-4413f21062fa",
    "photo-1512496015851-a90fb38ba796", "photo-1620916566398-39f1143ab7be",
  ],
  home: [
    "photo-1567538096630-e0c55bd6374c", "photo-1586023492125-27b2c045efd7",
    "photo-1522708323590-d24dbb6b0267", "photo-1616486338812-3dadae4b4ace",
    "photo-1513694203232-719a280e022f",
  ],
  electronics: [
    "photo-1505740420928-5e560c06d30e", "photo-1546435770-a3e426bf472b",
    "photo-1511707171634-5f897ff02aa9", "photo-1572569511254-d8f925fe2cbb",
    "photo-1585790050230-5dd28404ccb9",
  ],
  accessories: [
    "photo-1572635196237-14b3f281503f", "photo-1511499767150-a48a237f0083",
    "photo-1588850561407-ed78c282e89b", "photo-1521369909029-2afed882baee",
  ],
  kids: [
    "photo-1519238263530-99bdd11df2ea", "photo-1622290291468-a28f7a7dc6a8",
    "photo-1518831959646-742c3a14ebf7", "photo-1607453998774-d533f65dac99",
  ],
  lifestyle: [
    "photo-1553456558-aff63285bdd1", "photo-1544716278-ca5e3f4abd8c",
    "photo-1542435503-956c469947f6",
  ],
};

/* ------------------------------------------------------------------ palettes */

const COLORS = {
  neutrals: [
    { name: "Ecru", hex: "#efe6d9" },
    { name: "Off White", hex: "#f7f4ee" },
    { name: "Sand", hex: "#ded0bc" },
    { name: "Charcoal", hex: "#38353a" },
    { name: "Black", hex: "#1c1b1a" },
  ],
  warm: [
    { name: "Terracotta", hex: "#a0522d" },
    { name: "Copper", hex: "#b5734f" },
    { name: "Rust", hex: "#8c4a2f" },
    { name: "Clay Pink", hex: "#d9a396" },
    { name: "Camel", hex: "#c19a6b" },
  ],
  cool: [
    { name: "Sage", hex: "#8ba888" },
    { name: "Forest", hex: "#3f6b45" },
    { name: "Indigo", hex: "#33415c" },
    { name: "Slate Blue", hex: "#6a7b95" },
    { name: "Powder Blue", hex: "#b9cad6" },
  ],
  bright: [
    { name: "Mustard", hex: "#d1a12a" },
    { name: "Cherry", hex: "#9b2e35" },
    { name: "Olive", hex: "#6b6b3a" },
    { name: "Plum", hex: "#5e3a52" },
  ],
  metal: [
    { name: "Gold", hex: "#c9a227" },
    { name: "Rose Gold", hex: "#c98f7a" },
    { name: "Silver", hex: "#c5c6c7" },
  ],
  tech: [
    { name: "Graphite", hex: "#3a3a3c" },
    { name: "Midnight", hex: "#23252b" },
    { name: "Pearl White", hex: "#f2f1ee" },
  ],
};

const SIZES = {
  apparel: ["XS", "S", "M", "L", "XL", "XXL"],
  bottoms: ["28", "30", "32", "34", "36", "38"],
  shoesWomen: ["UK 3", "UK 4", "UK 5", "UK 6", "UK 7", "UK 8"],
  shoesMen: ["UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "UK 11"],
  kids: ["2-3Y", "4-5Y", "6-7Y", "8-9Y", "10-11Y"],
  bedding: ["Single", "Double", "Queen", "King"],
  free: ["Free Size"],
  none: [],
};

/* --------------------------------------------------------------------- specs */
/*
 * One entry per subcategory. `names` drives how many products are produced.
 * `desc` is the honest, specific copy shared by that subcategory; the generator
 * appends the material sentence. No lorem ipsum anywhere.
 */

const SPECS = [
  /* ------------------------------- WOMEN ------------------------------- */
  {
    category: "women", subcategory: "dresses", brands: ["Daily Choice Studio", "Nyra", "Atelier Nine"],
    price: [1499, 3899], sizes: "apparel", colors: ["neutrals", "warm", "cool"], images: "women",
    materials: ["Viscose Crepe", "Cotton Poplin", "Linen Blend", "Georgette"],
    tags: ["dress", "women", "occasion", "everyday"],
    desc: "Cut for easy movement with a defined waist and a hem that falls just below the knee. Fully lined, with a concealed back zip and set-in pockets.",
    names: ["Tiered Midi Dress", "Belted Shirt Dress", "Puff Sleeve Wrap Dress", "Sleeveless Column Dress"],
  },
  {
    category: "women", subcategory: "tops", brands: ["Daily Choice", "Zone Essentials", "Nyra"],
    price: [699, 1899], sizes: "apparel", colors: ["neutrals", "warm", "bright"], images: "women",
    materials: ["Combed Cotton", "Modal Jersey", "Cotton Voile"],
    tags: ["top", "women", "everyday", "layering"],
    desc: "A relaxed fit through the body with a slightly dropped shoulder. Soft enough to wear straight from the wash and shaped to sit well untucked.",
    names: ["Relaxed Crew Top", "Square Neck Blouse", "Ribbed Knit Tee", "Gathered Sleeve Top"],
  },
  {
    category: "women", subcategory: "shirts", brands: ["Daily Choice Studio", "Loom & Co."],
    price: [999, 2499], sizes: "apparel", colors: ["neutrals", "cool"], images: "women",
    materials: ["Cotton Poplin", "Linen", "Tencel Twill"],
    tags: ["shirt", "women", "workwear", "everyday"],
    desc: "An oversized cut with a camp collar and a single patch pocket. Breathable enough for long days and structured enough to wear open over a tee.",
    names: ["Oversized Cotton Shirt", "Striped Linen Shirt", "Utility Overshirt"],
  },
  {
    category: "women", subcategory: "jeans", brands: ["Daily Choice", "Loom & Co."],
    price: [1499, 2999], sizes: "bottoms", colors: ["cool", "neutrals"], images: "women",
    materials: ["Stretch Denim", "Rigid Cotton Denim"],
    tags: ["jeans", "denim", "women", "everyday"],
    desc: "A high rise that stays put, with a straight leg that skims rather than clings. Five pockets, branded shank button and a clean topstitch.",
    names: ["High Rise Straight Jeans", "Wide Leg Denim", "Cropped Tapered Jeans"],
  },
  {
    category: "women", subcategory: "trousers", brands: ["Daily Choice Studio", "Atelier Nine"],
    price: [1299, 2799], sizes: "apparel", colors: ["neutrals", "warm"], images: "women",
    materials: ["Linen Blend", "Twill", "Ponte Knit"],
    tags: ["trousers", "women", "workwear"],
    desc: "Pleated at the waist and pressed to a soft crease, falling straight to the ankle. Side pockets sit flat and the waistband is part-elasticated at the back.",
    names: ["Pleated Wide Trousers", "Tapered Linen Pants", "Straight Leg Chinos"],
  },
  {
    category: "women", subcategory: "jackets", brands: ["Daily Choice Studio", "Loom & Co."],
    price: [2299, 5499], sizes: "apparel", colors: ["neutrals", "warm"], images: "women",
    materials: ["Cotton Twill", "Wool Blend", "Quilted Cotton"],
    tags: ["jacket", "outerwear", "women"],
    desc: "A boxy, mid-weight layer that sits over knitwear without bulk. Fully lined body, two welt pockets and horn-look buttons.",
    names: ["Cropped Denim Jacket", "Quilted Liner Jacket", "Wool Blend Overcoat"],
  },
  {
    category: "women", subcategory: "knitwear", brands: ["Nyra", "Zone Essentials"],
    price: [1399, 3299], sizes: "apparel", colors: ["neutrals", "warm", "cool"], images: "women",
    materials: ["Merino Wool Blend", "Cotton Knit", "Recycled Acrylic"],
    tags: ["sweater", "knit", "women", "winter"],
    desc: "Knitted to a medium gauge that holds its shape, with ribbed cuffs and a soft rolled neckline. Warm without feeling heavy indoors.",
    names: ["Crew Neck Wool Sweater", "Oversized Cable Knit", "Fine Knit Cardigan"],
  },

  /* --------------------------------- MEN -------------------------------- */
  {
    category: "men", subcategory: "shirts", brands: ["Daily Choice", "Meridian", "Loom & Co."],
    price: [999, 2699], sizes: "apparel", colors: ["cool", "neutrals"], images: "men",
    materials: ["Oxford Cotton", "Linen", "Cotton Poplin"],
    tags: ["shirt", "men", "workwear", "everyday"],
    desc: "A regular fit with a soft-roll collar and a chest pocket. Cut long enough to stay tucked and finished with a clean single-needle seam.",
    names: ["Oxford Button Down Shirt", "Half Sleeve Linen Shirt", "Printed Resort Shirt", "Flannel Check Shirt"],
  },
  {
    category: "men", subcategory: "tshirts", brands: ["Daily Choice", "Zone Essentials"],
    price: [499, 1399], sizes: "apparel", colors: ["neutrals", "cool", "bright"], images: "men",
    materials: ["Combed Cotton", "Pima Cotton", "Cotton Jersey"],
    tags: ["tshirt", "men", "everyday", "basics"],
    desc: "A mid-weight jersey that keeps its shape through repeated washing, with a ribbed collar that will not stretch out. Straight body, set-in sleeves.",
    names: ["Heavyweight Crew Tee", "Pocket Tee", "Henley Neck Tee", "Long Sleeve Cotton Tee"],
  },
  {
    category: "men", subcategory: "jeans", brands: ["Daily Choice", "Loom & Co."],
    price: [1599, 3299], sizes: "bottoms", colors: ["cool", "neutrals"], images: "men",
    materials: ["Stretch Denim", "Selvedge Cotton Denim"],
    tags: ["jeans", "denim", "men"],
    desc: "A mid rise with a slim-straight leg and enough give to sit comfortably all day. Hardware is antique-finished and the pocket bags are cotton.",
    names: ["Slim Fit Stretch Jeans", "Straight Leg Denim", "Relaxed Tapered Jeans"],
  },
  {
    category: "men", subcategory: "trousers", brands: ["Meridian", "Daily Choice Studio"],
    price: [1299, 2899], sizes: "bottoms", colors: ["neutrals", "warm"], images: "men",
    materials: ["Cotton Twill", "Linen Blend", "Performance Stretch"],
    tags: ["trousers", "chinos", "men", "workwear"],
    desc: "A flat-fronted chino with a clean line from hip to hem and a touch of stretch in the weave. Slanted side pockets, jetted back pockets.",
    names: ["Slim Fit Chinos", "Pleated Linen Trousers", "Cargo Utility Pants"],
  },
  {
    category: "men", subcategory: "jackets", brands: ["Meridian", "Loom & Co."],
    price: [2499, 6499], sizes: "apparel", colors: ["neutrals", "cool"], images: "men",
    materials: ["Cotton Canvas", "Wool Blend", "Recycled Nylon"],
    tags: ["jacket", "outerwear", "men"],
    desc: "Built as a real outer layer: wind-resistant face fabric, taped shoulder seams and a hem that sits below the hip. Zip closure with a storm flap.",
    names: ["Cotton Bomber Jacket", "Hooded Puffer Jacket", "Field Jacket"],
  },
  {
    category: "men", subcategory: "knitwear", brands: ["Meridian", "Zone Essentials"],
    price: [1499, 3499], sizes: "apparel", colors: ["neutrals", "cool"], images: "men",
    materials: ["Merino Wool", "Lambswool Blend", "Cotton Knit"],
    tags: ["sweater", "knit", "men", "winter"],
    desc: "A fine-gauge knit that layers under a jacket without bunching, with ribbed trims that hold their shape. Fully fashioned shoulders.",
    names: ["Merino Crew Sweater", "Half Zip Knit", "Quarter Button Polo Knit"],
  },

  /* -------------------------------- KIDS -------------------------------- */
  {
    category: "kids", subcategory: "girls", brands: ["Daily Choice", "Zone Essentials"],
    price: [499, 1699], sizes: "kids", colors: ["warm", "bright", "neutrals"], images: "kids",
    materials: ["Soft Cotton Jersey", "Cotton Poplin", "Brushed Fleece"],
    tags: ["kids", "girls", "everyday", "playwear"],
    desc: "Made for running about: soft brushed cotton, flat seams where they would otherwise rub, and an easy pull-on shape with no fiddly fastenings.",
    names: ["Printed Cotton Frock", "Ruffle Sleeve Top", "Jersey Leggings Set", "Denim Pinafore"],
  },
  {
    category: "kids", subcategory: "boys", brands: ["Daily Choice", "Zone Essentials"],
    price: [499, 1699], sizes: "kids", colors: ["cool", "bright", "neutrals"], images: "kids",
    materials: ["Soft Cotton Jersey", "Cotton Twill", "Brushed Fleece"],
    tags: ["kids", "boys", "everyday", "playwear"],
    desc: "Reinforced at the knees and elbows where the wear actually happens, with an elasticated waist that survives the school run.",
    names: ["Graphic Cotton Tee", "Pull On Jogger", "Checked Cotton Shirt", "Hooded Sweatshirt"],
  },
  {
    category: "kids", subcategory: "infants", brands: ["Zone Essentials"],
    price: [399, 1299], sizes: "kids", colors: ["neutrals", "warm"], images: "kids",
    materials: ["Organic Cotton", "Bamboo Cotton Blend"],
    tags: ["kids", "infant", "newborn", "gift"],
    desc: "Cut from undyed organic cotton with envelope shoulders and press studs along the inseam, so changes take seconds. Tagless neck print.",
    names: ["Organic Cotton Bodysuit", "Sleepsuit Two Pack", "Muslin Swaddle Set"],
  },

  /* -------------------------------- HOME -------------------------------- */
  {
    category: "home", subcategory: "bedding", brands: ["Terra Living", "Daily Choice"],
    price: [1499, 4999], sizes: "bedding", colors: ["neutrals", "cool"], images: "home",
    materials: ["200 TC Cotton", "Cotton Percale", "Washed Linen"],
    tags: ["home", "bedding", "bedroom", "cotton"],
    desc: "Woven from long-staple cotton that softens with every wash rather than pilling. Includes a fitted sheet with deep corners and two pillow covers.",
    names: ["Washed Cotton Bedsheet Set", "Percale Duvet Cover", "Linen Blend Quilt"],
  },
  {
    category: "home", subcategory: "decor", brands: ["Terra Living", "Atelier Nine"],
    price: [599, 3499], sizes: "none", colors: ["warm", "neutrals", "metal"], images: "home",
    materials: ["Stoneware", "Mango Wood", "Hand-blown Glass", "Brass"],
    tags: ["home", "decor", "living room", "gift"],
    desc: "Finished by hand, so the glaze and grain vary a little piece to piece. Felt pads on the base protect the surface underneath.",
    names: ["Stoneware Vase", "Carved Wood Bowl", "Brass Candle Holder", "Textured Ceramic Planter"],
  },
  {
    category: "home", subcategory: "kitchen", brands: ["Terra Living", "Daily Choice"],
    price: [499, 2999], sizes: "none", colors: ["neutrals", "warm"], images: "home",
    materials: ["Stoneware", "Borosilicate Glass", "Stainless Steel", "Acacia Wood"],
    tags: ["home", "kitchen", "dining", "tableware"],
    desc: "Dishwasher and microwave safe, with a rim thick enough to survive daily use. Stacks neatly in a standard cabinet.",
    names: ["Speckled Dinner Plate Set", "Double Wall Glass Mugs", "Acacia Serving Board"],
  },
  {
    category: "home", subcategory: "furnishing", brands: ["Terra Living"],
    price: [899, 4499], sizes: "none", colors: ["warm", "neutrals", "cool"], images: "home",
    materials: ["Cotton Canvas", "Chenille Weave", "Jute"],
    tags: ["home", "furnishing", "living room", "textile"],
    desc: "A tight weave that resists flattening underfoot or under cushions, with bound edges that will not fray. Spot clean or gentle machine wash.",
    names: ["Handwoven Jute Rug", "Textured Cushion Cover Set", "Cotton Throw Blanket"],
  },

  /* ------------------------------- BEAUTY ------------------------------- */
  {
    category: "beauty", subcategory: "skincare", brands: ["Kaya Beauty", "Daily Choice"],
    price: [449, 2499], sizes: "none", colors: ["none"], images: "beauty",
    materials: ["Niacinamide 5%", "Hyaluronic Acid", "Vitamin C 10%", "Ceramide Complex"],
    tags: ["beauty", "skincare", "face", "daily"],
    desc: "A lightweight formula that absorbs without leaving a film, so it layers cleanly under sunscreen or makeup. Fragrance-free and non-comedogenic.",
    names: ["Hydrating Face Serum", "Gentle Foaming Cleanser", "Daily Moisturiser SPF 30", "Overnight Repair Cream"],
  },
  {
    category: "beauty", subcategory: "makeup", brands: ["Kaya Beauty"],
    price: [399, 1899], sizes: "none", colors: ["warm", "bright"], images: "beauty",
    materials: ["Buildable Cream Formula", "Matte Powder Formula", "Satin Finish Formula"],
    tags: ["beauty", "makeup", "face", "colour"],
    desc: "Blends out with a fingertip and builds from a wash of colour to full coverage without going patchy. Wears for a working day.",
    names: ["Satin Finish Lipstick", "Cream Blush Stick", "Brow Defining Pencil", "Lengthening Mascara"],
  },
  {
    category: "beauty", subcategory: "haircare", brands: ["Kaya Beauty", "Zone Essentials"],
    price: [399, 1699], sizes: "none", colors: ["none"], images: "beauty",
    materials: ["Argan Oil Blend", "Keratin Complex", "Sulphate-free Base"],
    tags: ["beauty", "haircare", "hair", "daily"],
    desc: "A sulphate-free wash that lathers enough to feel clean without stripping colour, followed by a conditioner that rinses out completely.",
    names: ["Repair Shampoo", "Deep Conditioning Mask", "Lightweight Hair Oil"],
  },
  {
    category: "beauty", subcategory: "fragrance", brands: ["Atelier Nine", "Kaya Beauty"],
    price: [1299, 4999], sizes: "none", colors: ["none"], images: "beauty",
    materials: ["Eau de Parfum 50ml", "Eau de Toilette 100ml"],
    tags: ["beauty", "fragrance", "perfume", "gift"],
    desc: "Opens bright and settles into a warm, woody base over the first hour. Six to eight hours of wear on skin, longer on fabric.",
    names: ["Amber Woods Eau de Parfum", "Citrus Neroli Eau de Toilette", "Cedar and Vetiver Parfum"],
  },

  /* ----------------------------- FOOTWEAR ------------------------------ */
  {
    category: "footwear", subcategory: "sneakers", brands: ["Stride", "Daily Choice"],
    price: [1499, 4499], sizes: "shoesMen", colors: ["neutrals", "cool"], images: "footwear",
    materials: ["Canvas Upper", "Leather Upper", "Recycled Knit Upper"],
    tags: ["footwear", "sneakers", "shoes", "everyday", "unisex"],
    desc: "A cushioned EVA midsole with a vulcanised rubber outsole that grips on wet pavement. Padded collar and a removable moulded insole.",
    names: ["Court Canvas Sneakers", "Retro Runner Sneakers", "Leather Low Top Sneakers", "Knit Slip On Sneakers"],
  },
  {
    category: "footwear", subcategory: "heels", brands: ["Atelier Nine", "Nyra"],
    price: [1799, 4999], sizes: "shoesWomen", colors: ["neutrals", "warm"], images: "footwear",
    materials: ["Suede Finish", "Patent Finish", "Leather Upper"],
    tags: ["footwear", "heels", "shoes", "occasion", "women"],
    desc: "A 75mm block heel that carries weight better than a stiletto, with a lightly padded footbed and a leather-lined interior.",
    names: ["Block Heel Sandals", "Pointed Court Heels", "Slingback Kitten Heels"],
  },
  {
    category: "footwear", subcategory: "sandals", brands: ["Stride", "Daily Choice"],
    price: [699, 2499], sizes: "shoesWomen", colors: ["warm", "neutrals"], images: "footwear",
    materials: ["Leather Upper", "Cork Footbed", "EVA Moulded"],
    tags: ["footwear", "sandals", "shoes", "summer"],
    desc: "A contoured footbed that supports the arch and adjustable buckles at the instep. The outsole is siped for grip on smooth floors.",
    names: ["Double Strap Sandals", "Cork Footbed Slides", "Woven Flat Sandals"],
  },
  {
    category: "footwear", subcategory: "formal", brands: ["Meridian", "Stride"],
    price: [2299, 5999], sizes: "shoesMen", colors: ["neutrals"], images: "footwear",
    materials: ["Full Grain Leather", "Burnished Leather"],
    tags: ["footwear", "formal", "shoes", "men", "workwear"],
    desc: "Cemented construction on a leather-look sole with a stacked heel. Breaks in over a week or two and takes polish well.",
    names: ["Leather Derby Shoes", "Penny Loafers", "Brogue Oxford Shoes"],
  },

  /* -------------------------------- BAGS -------------------------------- */
  {
    category: "bags", subcategory: "handbags", brands: ["Atelier Nine", "Nyra"],
    price: [1499, 5999], sizes: "none", colors: ["neutrals", "warm"], images: "bags",
    materials: ["Vegan Leather", "Full Grain Leather", "Canvas and Leather"],
    tags: ["bags", "handbag", "women", "everyday"],
    desc: "Structured enough to stand on its own when set down. Lined interior with a zip pocket and two slip pockets; detachable crossbody strap.",
    names: ["Structured Top Handle Bag", "Soft Hobo Shoulder Bag", "Quilted Crossbody Bag"],
  },
  {
    category: "bags", subcategory: "backpacks", brands: ["Meridian", "Daily Choice"],
    price: [1299, 4499], sizes: "none", colors: ["cool", "neutrals"], images: "bags",
    materials: ["Recycled Polyester", "Cotton Canvas", "Coated Nylon"],
    tags: ["bags", "backpack", "travel", "work", "unisex"],
    desc: "A padded 15-inch laptop sleeve, an organiser panel and a water-resistant base. Shoulder straps are foam-padded with a sternum clip.",
    names: ["Everyday Laptop Backpack", "Canvas Roll Top Backpack", "Commuter Backpack"],
  },
  {
    category: "bags", subcategory: "totes", brands: ["Loom & Co.", "Terra Living"],
    price: [699, 2999], sizes: "none", colors: ["neutrals", "warm"], images: "bags",
    materials: ["Heavy Cotton Canvas", "Jute Blend", "Vegan Leather"],
    tags: ["bags", "tote", "everyday", "unisex"],
    desc: "Wide enough for a laptop and a water bottle, with reinforced strap joins that take the weight. Folds flat when it is not in use.",
    names: ["Heavy Canvas Tote", "Woven Market Tote", "Leather Trim Work Tote"],
  },

  /* ----------------------------- JEWELLERY ----------------------------- */
  {
    category: "jewellery", subcategory: "earrings", brands: ["Nyra", "Atelier Nine"],
    price: [499, 3499], sizes: "none", colors: ["metal"], images: "jewellery",
    materials: ["18K Gold Plated Brass", "Sterling Silver", "Stainless Steel"],
    tags: ["jewellery", "earrings", "women", "gift"],
    desc: "Light enough to forget you are wearing them, with hypoallergenic posts and secure butterfly backs. Plating is sealed against tarnish.",
    names: ["Gold Plated Hoop Earrings", "Pearl Drop Earrings", "Textured Stud Earrings"],
  },
  {
    category: "jewellery", subcategory: "necklaces", brands: ["Nyra", "Atelier Nine"],
    price: [699, 4499], sizes: "none", colors: ["metal"], images: "jewellery",
    materials: ["18K Gold Plated Brass", "Sterling Silver"],
    tags: ["jewellery", "necklace", "women", "gift"],
    desc: "A fine chain with a lobster clasp and a 5cm extender, so it sits where you want it. Layers cleanly with other lengths.",
    names: ["Layered Chain Necklace", "Pendant Drop Necklace", "Beaded Charm Necklace"],
  },
  {
    category: "jewellery", subcategory: "watches", brands: ["Meridian", "Atelier Nine"],
    price: [2499, 9999], sizes: "none", colors: ["metal", "neutrals"], images: "jewellery",
    materials: ["Stainless Steel Case", "Leather Strap", "Mesh Bracelet"],
    tags: ["jewellery", "watch", "accessories", "gift", "unisex"],
    desc: "A 38mm case with a mineral crystal face and quartz movement, water resistant to 3 ATM. Strap is interchangeable with any 20mm band.",
    names: ["Minimal Dial Watch", "Mesh Strap Watch", "Leather Strap Chronograph"],
  },

  /* ---------------------------- ACCESSORIES ---------------------------- */
  {
    category: "accessories", subcategory: "eyewear", brands: ["Atelier Nine", "Meridian"],
    price: [899, 3999], sizes: "none", colors: ["neutrals", "warm"], images: "accessories",
    materials: ["Acetate Frame", "Metal Frame", "Polarised Lens"],
    tags: ["accessories", "sunglasses", "eyewear", "summer", "unisex"],
    desc: "Polarised lenses with full UV400 protection and spring hinges that take being pushed on and off a head all day. Comes with a hard case.",
    names: ["Polarised Square Sunglasses", "Round Metal Sunglasses", "Oversized Acetate Sunglasses"],
  },
  {
    category: "accessories", subcategory: "belts-wallets", brands: ["Meridian", "Loom & Co."],
    price: [599, 2799], sizes: "free", colors: ["neutrals", "warm"], images: "accessories",
    materials: ["Full Grain Leather", "Vegan Leather", "Woven Webbing"],
    tags: ["accessories", "belt", "wallet", "everyday", "unisex"],
    desc: "Cut from a single piece of hide rather than bonded layers, so it creases rather than cracks. Brushed metal hardware.",
    names: ["Leather Reversible Belt", "Bifold Card Wallet", "Woven Webbing Belt"],
  },
  {
    category: "accessories", subcategory: "scarves-hats", brands: ["Loom & Co.", "Zone Essentials"],
    price: [499, 2499], sizes: "free", colors: ["warm", "neutrals", "cool"], images: "accessories",
    materials: ["Merino Wool", "Modal Blend", "Cotton Knit"],
    tags: ["accessories", "scarf", "hat", "winter", "unisex"],
    desc: "Soft against the neck with no scratch, and wide enough to double over. Holds its shape after a gentle hand wash.",
    names: ["Woven Wool Scarf", "Ribbed Knit Beanie", "Lightweight Modal Stole"],
  },

  /* ---------------------------- ELECTRONICS ---------------------------- */
  {
    category: "electronics", subcategory: "audio", brands: ["Meridian Tech", "Daily Choice"],
    price: [999, 8999], sizes: "none", colors: ["tech"], images: "electronics",
    materials: ["Bluetooth 5.3", "Active Noise Cancelling", "40mm Drivers"],
    tags: ["electronics", "audio", "headphones", "tech"],
    desc: "Up to 40 hours of playback with a 10-minute quick charge giving four more. Multipoint pairing holds two devices at once.",
    names: ["Over Ear Wireless Headphones", "True Wireless Earbuds", "Compact Bluetooth Speaker"],
  },
  {
    category: "electronics", subcategory: "wearables", brands: ["Meridian Tech"],
    price: [1999, 12999], sizes: "none", colors: ["tech", "neutrals"], images: "electronics",
    materials: ["AMOLED Display", "Silicone Strap", "IP68 Rated"],
    tags: ["electronics", "wearable", "smartwatch", "fitness", "tech"],
    desc: "A bright AMOLED face that stays readable outdoors, seven-day battery in normal use, and continuous heart rate and SpO2 tracking.",
    names: ["Fitness Smartwatch", "Slim Activity Band", "Sport GPS Watch"],
  },
  {
    category: "electronics", subcategory: "tech-accessories", brands: ["Meridian Tech", "Zone Essentials"],
    price: [499, 3999], sizes: "none", colors: ["tech"], images: "electronics",
    materials: ["Braided Nylon", "Aluminium Housing", "GaN Charger"],
    tags: ["electronics", "accessories", "charger", "tech"],
    desc: "Fast charging with foldable pins and built-in over-current protection. The braided cable is rated for 20,000 bend cycles.",
    names: ["65W GaN Fast Charger", "Braided USB-C Cable", "10000mAh Slim Power Bank"],
  },

  /* ----------------------------- LIFESTYLE ----------------------------- */
  {
    category: "lifestyle", subcategory: "travel", brands: ["Meridian", "Daily Choice"],
    price: [899, 6999], sizes: "none", colors: ["neutrals", "cool"], images: "lifestyle",
    materials: ["Polycarbonate Shell", "Recycled Polyester", "Aluminium Frame"],
    tags: ["lifestyle", "travel", "luggage", "gift"],
    desc: "Four spinner wheels that roll quietly, a TSA-approved combination lock and a shell that flexes rather than cracks under a baggage handler.",
    names: ["Cabin Hardshell Trolley", "Weekender Duffle Bag", "Packing Cube Set"],
  },
  {
    category: "lifestyle", subcategory: "wellness", brands: ["Zone Essentials", "Terra Living"],
    price: [599, 3499], sizes: "none", colors: ["warm", "cool"], images: "lifestyle",
    materials: ["Natural Rubber", "Stainless Steel", "Soy Wax"],
    tags: ["lifestyle", "wellness", "fitness", "self-care", "gift"],
    desc: "Grippy even when damp, and it rolls up without curling at the edges. Wipe clean with a damp cloth after use.",
    names: ["Natural Rubber Yoga Mat", "Insulated Steel Bottle", "Soy Wax Candle Trio"],
  },
  {
    category: "lifestyle", subcategory: "stationery", brands: ["Atelier Nine", "Loom & Co."],
    price: [299, 1999], sizes: "none", colors: ["neutrals", "warm"], images: "lifestyle",
    materials: ["100 GSM Paper", "Recycled Board", "Linen Cover"],
    tags: ["lifestyle", "stationery", "desk", "gift"],
    desc: "Lays flat when open thanks to a sewn binding, on paper heavy enough that fountain ink does not bleed through.",
    names: ["Linen Bound Notebook", "Undated Weekly Planner", "Desk Organiser Tray"],
  },
];

/* ----------------------------------------------------------------- generation */

const REVIEW_AUTHORS = [
  "Ananya R.", "Rohit M.", "Priya S.", "Karthik V.", "Neha G.", "Aditya P.",
  "Sneha K.", "Vikram T.", "Meera J.", "Arjun D.", "Ishita B.", "Rahul N.",
  "Divya L.", "Siddharth C.", "Kavya H.", "Nikhil A.", "Tanvi S.", "Manish R.",
];

const REVIEW_TEMPLATES = {
  5: [
    { title: "Exactly as described", body: "Arrived well packed and the quality is better than I expected at this price. Have used it almost daily since and it still looks new." },
    { title: "Worth every rupee", body: "Fit and finish are genuinely good. I ordered a second one in another colour the same week." },
    { title: "Very happy with this", body: "Delivery was quick and the product matches the photos closely. No complaints at all." },
    { title: "Repeat customer now", body: "This is my third order from Daily Choice Zone and the standard has held up every time. Packaging was plastic-free too." },
    { title: "Better in person", body: "The photos undersell it slightly. Feels considered rather than mass produced, and it has washed well so far." },
    { title: "Gifted it twice", body: "Bought one for myself and then two more as gifts. Both recipients asked where it was from, which tells you enough." },
  ],
  4: [
    { title: "Good, with one small niggle", body: "Quality is solid and I would buy again. Only note is that it runs very slightly large, so consider sizing down." },
    { title: "Does the job well", body: "Happy with the purchase overall. The colour is a touch deeper in person than on screen, but I actually prefer it." },
    { title: "Solid buy", body: "Comfortable and well made. Took a couple of uses to settle in but it has been good since." },
    { title: "Almost perfect", body: "No real complaints about the product itself. Delivery ran a day past the estimate, which is the only reason this is not five stars." },
    { title: "Would recommend", body: "Does what it promises without any fuss. I would have liked one more colour option, but that is hardly a fault." },
  ],
  3: [
    { title: "Decent for the price", body: "It is fine for occasional use. The finish is not quite as premium as the listing suggests, but nothing is wrong with it." },
    { title: "Mixed feelings", body: "Looks good and arrived on time, though I expected slightly heavier material. Acceptable at this price point." },
    { title: "Fine, not remarkable", body: "Perfectly serviceable and I am keeping it, but it has not replaced the one it was meant to replace." },
  ],
  2: [
    { title: "Not quite for me", body: "The sizing was off for my frame and the fabric felt thinner than I hoped. Return process was straightforward, to be fair." },
    { title: "Sent it back", body: "The colour was noticeably different from the listing photos. Refund came through without argument, so no complaints there." },
  ],
};

const products = [];
const reviews = [];
const seenSlugs = new Set();
const seenIds = new Set();

let counter = 0;

for (const spec of SPECS) {
  for (const name of spec.names) {
    counter += 1;

    const slugBase = slugify(name);
    // Collisions are possible across categories (e.g. two "Straight Leg Denim").
    let slug = slugBase;
    if (seenSlugs.has(slug)) slug = `${slugBase}-${spec.category}`;
    let dedupe = 2;
    while (seenSlugs.has(slug)) {
      slug = `${slugBase}-${spec.category}-${dedupe}`;
      dedupe += 1;
    }
    seenSlugs.add(slug);

    const id = `prod_${String(counter).padStart(3, "0")}`;
    if (seenIds.has(id)) throw new Error(`Duplicate id ${id}`);
    seenIds.add(id);

    const r = rng(hash(slug));

    // --- pricing -------------------------------------------------------
    const [lo, hi] = spec.price;
    const price = retailPrice(lo + r() * (hi - lo));
    // Roughly three in five items carry a discount. The pool is weighted
    // toward modest reductions — a premium catalogue is not a permanent
    // clearance rack, so deep cuts stay rare enough to mean something.
    const discounted = r() < 0.62;
    const discountPool = [10, 10, 15, 15, 15, 20, 20, 20, 25, 25, 30, 30, 35, 40, 50];
    const discountPct = discounted
      ? discountPool[Math.floor(r() * discountPool.length)]
      : 0;
    const originalPrice = discounted
      ? retailPrice(price / (1 - discountPct / 100))
      : price;
    // Recompute from the rounded figures so the badge never lies.
    const discount = originalPrice > price
      ? Math.round(((originalPrice - price) / originalPrice) * 100)
      : 0;

    // --- variants ------------------------------------------------------
    const colorPool = spec.colors
      .filter((key) => key !== "none")
      .flatMap((key) => COLORS[key] ?? []);
    const colors = colorPool.length
      ? pickMany(colorPool, 2 + Math.floor(r() * 3), r)
      : [];

    const sizes = SIZES[spec.sizes] ?? [];
    // Stock a contiguous run of sizes rather than a random scatter.
    const sizeList = sizes.length > 2
      ? sizes.slice(0, sizes.length - Math.floor(r() * 2))
      : sizes;

    const imagePool = IMAGES[spec.images] ?? [];
    const imageIds = pickMany(imagePool, Math.min(4, imagePool.length), r);
    const images = imageIds.map((imageId) => img(imageId));

    const material = pick(spec.materials, r);

    // --- signals -------------------------------------------------------
    const rating = Math.round((3.6 + r() * 1.4) * 10) / 10;
    const reviewCount = 8 + Math.floor(r() * 460);
    // A small slice is deliberately out of stock so empty/disabled states
    // are reachable without editing data by hand.
    const stock = r() < 0.07 ? 0 : 3 + Math.floor(r() * 80);

    const isNew = r() < 0.26;
    const isTrending = r() < 0.3;
    const isBestSeller = rating >= 4.3 && reviewCount > 150;
    const isFeatured = r() < 0.2;

    products.push({
      id,
      slug,
      name,
      brand: pick(spec.brands, r),
      category: spec.category,
      subcategory: spec.subcategory,
      price,
      originalPrice,
      discount,
      currency: "INR",
      rating,
      reviewCount,
      images,
      colors,
      sizes: sizeList,
      description: `${spec.desc} Made from ${material.toLowerCase()}.`,
      material,
      tags: [...new Set([...spec.tags, slugify(spec.brands[0]), spec.subcategory])],
      isNew,
      isTrending,
      isBestSeller,
      isFeatured,
      stock,
      sku: `DCZ-${spec.category.slice(0, 2).toUpperCase()}${String(counter).padStart(4, "0")}`,
      care: pick([
        "Machine wash cold with like colours. Do not bleach. Warm iron if needed.",
        "Gentle cycle at 30°C. Dry flat away from direct sunlight.",
        "Wipe clean with a soft damp cloth. Do not immerse in water.",
        "Dry clean only to preserve the finish and shape.",
        "Hand wash in cool water. Reshape while damp and dry flat.",
      ], r),
      specifications: [
        { label: "Material", value: material },
        { label: "SKU", value: `DCZ-${spec.category.slice(0, 2).toUpperCase()}${String(counter).padStart(4, "0")}` },
        { label: "Country of origin", value: "India" },
        { label: "Sold by", value: "Daily Choice Zone Retail Pvt. Ltd." },
      ],
    });

    // --- reviews -------------------------------------------------------
    const reviewsToWrite = 2 + Math.floor(r() * 3);
    // Two customers never leave word-for-word identical reviews, so a title
    // is used at most once per product.
    const usedTitles = new Set();

    for (let i = 0; i < reviewsToWrite; i += 1) {
      // Skew review ratings toward the product's own rating.
      const stars = rating >= 4.4
        ? (r() < 0.75 ? 5 : 4)
        : rating >= 4.0
          ? (r() < 0.5 ? 5 : 4)
          : (r() < 0.45 ? 4 : r() < 0.85 ? 3 : 2);

      const pool = (REVIEW_TEMPLATES[stars] ?? REVIEW_TEMPLATES[4]).filter(
        (candidate) => !usedTitles.has(candidate.title),
      );
      if (pool.length === 0) continue;

      const template = pick(pool, r);
      usedTitles.add(template.title);
      const daysAgo = 3 + Math.floor(r() * 300);
      const date = new Date(Date.UTC(2026, 8, 21) - daysAgo * 86400000);
      reviews.push({
        id: `rev_${id.slice(5)}_${i + 1}`,
        productId: id,
        author: pick(REVIEW_AUTHORS, r),
        rating: stars,
        title: template.title,
        body: template.body,
        date: date.toISOString().slice(0, 10),
        verified: r() < 0.82,
      });
    }
  }
}

/* --------------------------------------------------------------- collections */
/*
 * Collections are curated membership lists. They are generated here only so
 * every id is guaranteed to resolve — once you are curating for real, edit
 * collections.json by hand and drop the rules below.
 */

const COLLECTION_RULES = [
  {
    id: "col_summer",
    slug: "summer-essentials",
    name: "Summer Essentials",
    description: "Linen that breathes, sandals that grip and shades that stay put. Built for long, bright days.",
    image: "https://images.unsplash.com/photo-1495121605193-b116b5b9c5fe?auto=format&fit=crop&w=1400&q=80",
    featured: true,
    match: (p) =>
      p.tags.includes("summer") ||
      ["sandals", "eyewear", "dresses"].includes(p.subcategory) ||
      p.material.toLowerCase().includes("linen"),
  },
  {
    id: "col_basics",
    slug: "everyday-basics",
    name: "Everyday Basics",
    description: "The quiet workhorses of a wardrobe — tees, shirts and denim you reach for without thinking.",
    image: "https://images.unsplash.com/photo-1485462537746-965f33f7f6a7?auto=format&fit=crop&w=1400&q=80",
    featured: true,
    match: (p) =>
      p.tags.includes("basics") ||
      (p.tags.includes("everyday") && ["women", "men"].includes(p.category)),
  },
  {
    id: "col_weekend",
    slug: "weekend-picks",
    name: "Weekend Picks",
    description: "Softer, looser, easier. Sneakers, sweatshirts and totes for two days off.",
    image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1400&q=80",
    featured: true,
    match: (p) => ["tshirts", "sneakers", "totes", "knitwear"].includes(p.subcategory),
  },
  {
    id: "col_office",
    slug: "office-edit",
    name: "Office Edit",
    description: "Quiet tailoring, sharp shirting and shoes that survive a commute. Dress code, handled.",
    image: "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=1400&q=80",
    featured: true,
    match: (p) => p.tags.includes("workwear") || ["formal", "watches"].includes(p.subcategory),
  },
  {
    id: "col_travel",
    slug: "travel-essentials",
    name: "Travel Essentials",
    description: "Cabin-sized, wipe-clean and organised. Everything that makes a 5am airport run survivable.",
    image: "https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=1400&q=80",
    featured: true,
    match: (p) => p.tags.includes("travel") || ["backpacks", "tech-accessories"].includes(p.subcategory),
  },
  {
    id: "col_home",
    slug: "home-refresh",
    name: "Home Refresh",
    description: "New bedding, a better mug, one good vase. Small changes that reset a whole room.",
    image: "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1400&q=80",
    featured: true,
    match: (p) => p.category === "home",
  },
  {
    id: "col_trending",
    slug: "trending-now",
    name: "Trending Now",
    description: "What is moving fastest across the store this week.",
    image: "https://images.unsplash.com/photo-1523381210434-271e8be1f52b?auto=format&fit=crop&w=1400&q=80",
    featured: false,
    match: (p) => p.isTrending,
  },
];

const collections = COLLECTION_RULES.map(({ match, ...rest }) => ({
  ...rest,
  productIds: products.filter(match).slice(0, 24).map((p) => p.id),
}));

const thin = collections.filter((c) => c.productIds.length < 4);
if (thin.length) {
  throw new Error(
    `Collections with too few products: ${thin.map((c) => `${c.slug} (${c.productIds.length})`).join(", ")}`,
  );
}

writeFileSync(join(OUT_DIR, "products.json"), `${JSON.stringify(products, null, 2)}\n`);
writeFileSync(join(OUT_DIR, "reviews.json"), `${JSON.stringify(reviews, null, 2)}\n`);
writeFileSync(join(OUT_DIR, "collections.json"), `${JSON.stringify(collections, null, 2)}\n`);

const byCategory = products.reduce((acc, p) => {
  acc[p.category] = (acc[p.category] ?? 0) + 1;
  return acc;
}, {});

console.log(`products.json  ${products.length} products`);
console.log(`reviews.json   ${reviews.length} reviews`);
console.log("per category:", byCategory);
console.log("out of stock:", products.filter((p) => p.stock === 0).length);
console.log("discounted:", products.filter((p) => p.discount > 0).length);
console.log("unique slugs:", new Set(products.map((p) => p.slug)).size);
console.log("unique ids:", new Set(products.map((p) => p.id)).size);
