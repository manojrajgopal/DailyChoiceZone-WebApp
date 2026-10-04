/**
 * Runs before every test file.
 *
 * - jest-dom matchers (`toBeInTheDocument`, `toBeDisabled`, …)
 * - the fake backend at `fetch` (see `api.ts`), fresh for each test
 * - `next/navigation`, `next/image` and `next/font` stand-ins
 * - browser APIs jsdom lacks (matchMedia, observers, scrollTo, object URLs)
 * - every Zustand store, local and session storage reset between tests
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, beforeEach, vi } from "vitest";

import { clearIdCache } from "@/services/lookupService";

import { installFakeApi } from "./api";
import { navigationMock, resetNavigation } from "./navigation";
import { resetStores } from "./stores";

vi.mock("next/navigation", () => navigationMock);

// A plain <img>: Next's optimiser props are dropped, a static import's { src } is unwrapped.
const NEXT_IMAGE_ONLY = ["fill", "priority", "placeholder", "blurDataURL", "quality", "sizes", "unoptimized", "loader", "overrideSrc"];
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (!NEXT_IMAGE_ONLY.includes(key)) attributes[key] = value;
    }
    const src = props.src as string | { src: string } | undefined;
    attributes.src = typeof src === "string" ? src : src?.src;
    return createElement("img", attributes as ImgHTMLAttributes<HTMLImageElement>);
  },
}));

vi.mock("next/font/google", () => {
  const font = () => ({ className: "font", variable: "--font", style: { fontFamily: "font" } });
  return new Proxy({}, { get: () => font });
});

function installBrowserApis() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  class Observer {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn(() => []);
    root = null;
    rootMargin = "";
    thresholds = [];
  }
  if (!("IntersectionObserver" in window)) vi.stubGlobal("IntersectionObserver", Observer);
  if (!("ResizeObserver" in window)) vi.stubGlobal("ResizeObserver", Observer);

  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => "blob:test");
  if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
}

installBrowserApis();

beforeEach(() => {
  installFakeApi();
  installBrowserApis();
});

afterEach(() => {
  cleanup();
  // Before the resets below, so a test's broken-storage spy doesn't break them.
  vi.restoreAllMocks();
  resetNavigation();
  resetStores();
  // ID previews are cached for a minute; one test's records must not answer the next's.
  clearIdCache();
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // a test may have replaced storage with one that throws
  }
  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
  vi.useRealTimers();
});
