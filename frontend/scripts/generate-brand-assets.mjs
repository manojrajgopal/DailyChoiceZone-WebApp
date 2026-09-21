/**
 * Derives the served logo assets from the original artwork.
 *
 * The supplied logo is 1254x1254 and 1.3MB. That is right for a master file
 * and wrong for a web page: the header renders the mark at 44px and the footer
 * at 64px. With `output: "export"` there is no image optimizer to resize it on
 * the way out, so shipping the master would mean every visitor downloading
 * 1.3MB to display a thumbnail.
 *
 * This writes resized copies at the sizes actually used. The master stays at
 * `assets/logo-original.png` — outside `public/`, so it is never deployed —
 * and the artwork itself is not altered, only its resolution.
 *
 *   npm run brand:assets
 */

import { copyFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGINAL = join(ROOT, "assets", "logo-original.png");
const SERVED = join(ROOT, "public", "brand", "logo.png");

// On the first run the current logo.png *is* the original; keep it aside.
if (!existsSync(ORIGINAL)) {
  copyFileSync(SERVED, ORIGINAL);
  console.log("archived the master artwork to assets/logo-original.png");
}

const kb = (path) => `${(statSync(path).size / 1024).toFixed(0)} KB`;
console.log(`source: ${kb(ORIGINAL)}`);

/**
 * 256px covers the largest on-page use (112px) at 2x device pixel ratio.
 * The favicon and Apple touch icon keep their conventional sizes.
 */
const outputs = [
  { path: SERVED, size: 256, label: "public/brand/logo.png  (header & footer mark)" },
  { path: join(ROOT, "src", "app", "icon.png"), size: 256, label: "src/app/icon.png       (favicon)" },
  { path: join(ROOT, "src", "app", "apple-icon.png"), size: 180, label: "src/app/apple-icon.png (Apple touch icon)" },
];

for (const { path, size, label } of outputs) {
  await sharp(ORIGINAL)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, palette: true })
    .toFile(path);
  console.log(`${label} -> ${size}px, ${kb(path)}`);
}
