/**
 * A stand-in for `next/navigation`, wired up in `setup.ts`.
 *
 * Tests set where the page "is" with `setLocation`, and read what a component
 * asked the router to do from `router.push` / `router.replace`, which are spies.
 * Every test starts at "/" with no query string.
 */
import { vi } from "vitest";

interface NavigationState {
  pathname: string;
  search: URLSearchParams;
  params: Record<string, string | string[]>;
}

const state: NavigationState = { pathname: "/", search: new URLSearchParams(), params: {} };

/** Follows pushes and replaces, so a component that writes the URL then reads it sees its own change. */
function go(href: string) {
  const url = new URL(href, "http://localhost");
  state.pathname = url.pathname;
  state.search = new URLSearchParams(url.search);
}

export const router = {
  push: vi.fn((href: string) => go(href)),
  replace: vi.fn((href: string) => go(href)),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

/** Put the page at `href` (path and query), with optional route params. */
export function setLocation(href: string, params: Record<string, string | string[]> = {}) {
  go(href);
  state.params = params;
}

export function resetNavigation() {
  state.pathname = "/";
  state.search = new URLSearchParams();
  state.params = {};
  for (const fn of Object.values(router)) {
    fn.mockClear();
  }
}

export class RedirectError extends Error {
  constructor(readonly href: string) {
    super(`NEXT_REDIRECT:${href}`);
  }
}

export class NotFoundError extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

export const navigationMock = {
  useRouter: () => router,
  usePathname: () => state.pathname,
  // A fresh object each render, like Next's read-only params.
  useSearchParams: () => new URLSearchParams(state.search.toString()),
  useParams: () => state.params,
  useSelectedLayoutSegment: () => null,
  useSelectedLayoutSegments: () => [],
  redirect: (href: string) => {
    throw new RedirectError(href);
  },
  permanentRedirect: (href: string) => {
    throw new RedirectError(href);
  },
  notFound: () => {
    throw new NotFoundError();
  },
};
