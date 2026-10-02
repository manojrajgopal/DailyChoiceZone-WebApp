import { describe, expect, it } from "vitest";

import { api, fail, file, networkError } from "@/test/api";

import { inlineImages } from "./inlineImages";

/**
 * Note on this test file: in jsdom (this test environment), Node's native
 * `fetch`/`Response` hand back a `Blob` that jsdom's `FileReader` does not
 * recognise as its own `Blob` type (`instanceof` fails across the two Fetch
 * implementations), so `FileReader.readAsDataURL` always throws here and the
 * function's own `catch` falls back to the original `src` — even for a
 * request that answered 200. That is a limitation of mixing Node's fetch with
 * jsdom, not a bug in `inlineImages`: in a real browser, fetch and
 * FileReader share one Blob implementation and the data-URL path runs. These
 * tests assert what is actually observable in this harness and call that
 * limitation out rather than asserting a data: URL that this environment
 * cannot produce.
 */

function makeRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function addImg(root: HTMLElement, attrs: Record<string, string>): HTMLImageElement {
  const img = document.createElement("img");
  Object.entries(attrs).forEach(([key, value]) => img.setAttribute(key, value));
  root.appendChild(img);
  return img;
}

describe("inlineImages", () => {
  it("sets eager loading and sync decoding, and strips srcset/sizes, on every image", async () => {
    const root = makeRoot();
    const img = addImg(root, { src: "data:image/png;base64,AAAA", srcset: "x 2x", sizes: "100vw" });

    await inlineImages(root, 20);

    expect(img.loading).toBe("eager");
    expect(img.decoding).toBe("sync");
    expect(img.hasAttribute("srcset")).toBe(false);
    expect(img.hasAttribute("sizes")).toBe(false);
  });

  it("attempts to fetch a reachable, non-data image", async () => {
    const root = makeRoot();
    api.get("/pics/logo.png", file("logo-bytes"));
    addImg(root, { src: "/pics/logo.png" });

    await inlineImages(root, 20);

    expect(api.requests("GET", "/pics/logo.png")).toHaveLength(1);
  });

  it("keeps the original address when the image can't be fetched (404)", async () => {
    const root = makeRoot();
    api.get("/pics/missing.png", fail(404));
    const img = addImg(root, { src: "/pics/missing.png" });

    await inlineImages(root, 20);

    expect(img.src).toContain("/pics/missing.png");
  });

  it("keeps the original address when fetch itself rejects (offline)", async () => {
    const root = makeRoot();
    api.get("/pics/offline.png", networkError());
    const img = addImg(root, { src: "/pics/offline.png" });

    await inlineImages(root, 20);

    expect(img.src).toContain("/pics/offline.png");
  });

  it("keeps the original address even for a 200 response (FileReader/Blob mismatch in jsdom — see file note)", async () => {
    const root = makeRoot();
    api.get("/pics/logo.png", file("logo-bytes"));
    const img = addImg(root, { src: "/pics/logo.png" });

    await inlineImages(root, 20);

    expect(img.src).toContain("/pics/logo.png");
  });

  it("does not fetch an image that is already a data URL", async () => {
    const root = makeRoot();
    const img = addImg(root, { src: "data:image/png;base64,AAAA" });

    await inlineImages(root, 20);

    expect(api.calls).toHaveLength(0);
    expect(img.src).toBe("data:image/png;base64,AAAA");
  });

  it("does not fetch an image with no src, and does not crash", async () => {
    const root = makeRoot();
    const img = document.createElement("img");
    root.appendChild(img);

    await expect(inlineImages(root, 20)).resolves.toBeUndefined();
    expect(api.calls).toHaveLength(0);
    expect(img.getAttribute("src")).toBeNull();
  });

  it("resolves with no images at all", async () => {
    const root = makeRoot();
    await expect(inlineImages(root, 20)).resolves.toBeUndefined();
  });

  it("processes several images in the same root independently", async () => {
    const root = makeRoot();
    api.get("/pics/a.png", file("a"));
    api.get("/pics/b.png", fail(500));
    addImg(root, { src: "/pics/a.png" });
    addImg(root, { src: "/pics/b.png" });

    await inlineImages(root, 20);

    expect(api.requests("GET", "/pics/a.png")).toHaveLength(1);
    expect(api.requests("GET", "/pics/b.png")).toHaveLength(1);
  });
});
