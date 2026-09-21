/**
 * Reconciles Next's prefetch payload filenames with the paths it requests.
 *
 * Next 16's App Router prefetches each route segment as a `.txt` payload and
 * asks for it with the segments joined by dots:
 *
 *   GET /shop/__next.shop.__PAGE__.txt
 *
 * But `output: "export"` writes those payloads as nested directories:
 *
 *   out/shop/__next.shop/__PAGE__.txt
 *
 * On a Node server the router maps between the two. A static host serves paths
 * literally, so every prefetch 404s — harmless, because the client falls back
 * to the full payload, but it fills the console with errors on every hover and
 * means prefetching never actually warms anything.
 *
 * This renames each nested payload to the dot-joined name that is requested.
 * Nothing ever asks for the nested form, so the directories are removed rather
 * than duplicated, which also keeps the deploy smaller.
 *
 * Runs automatically after `npm run build` via the `postbuild` script. If a
 * future Next release fixes the mismatch, this becomes a no-op and can go.
 */

import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");

let renamed = 0;

/** Every file beneath `dir`, as paths relative to it. */
function filesUnder(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...filesUnder(join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found;
}

/**
 * Walk the export looking for `__next.*` payload directories.
 *
 * Each sits directly inside the route folder it belongs to, so the flat name
 * is the directory name plus the file's path within it, dots for slashes.
 */
function flatten(routeDir) {
  for (const entry of readdirSync(routeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const path = join(routeDir, entry.name);

    if (entry.name.startsWith("__next.")) {
      for (const rel of filesUnder(path)) {
        const flat = `${entry.name}.${rel.split("/").join(".")}`;
        renameSync(join(path, rel), join(routeDir, flat));
        renamed += 1;
      }
      rmSync(path, { recursive: true, force: true });
      continue;
    }

    flatten(path);
  }
}

if (!statSync(OUT, { throwIfNoEntry: false })) {
  console.error("No out/ directory — run `next build` first.");
  process.exit(1);
}

flatten(OUT);
console.log(`flatten-prefetch: renamed ${renamed} prefetch payload(s) to their requested paths`);
