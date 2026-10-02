# Frontend tests

Vitest + jsdom + React Testing Library + user-event + jest-dom.

```bash
npm test                 # everything, once
npm run test:watch       # re-run on change
npm run test:coverage    # with coverage → coverage/index.html
npx vitest run src/components/cart   # one folder
```

(If the `npm` shim is broken on this machine: `node node_modules/vitest/vitest.mjs run …`.)

## Where tests live

Next to the file they test: `CartView.tsx` → `CartView.test.tsx`,
`format.ts` → `format.test.ts`. Pages under `src/app` get `page.test.tsx` beside
`page.tsx` (not a route — Next only routes `page`, `layout`, … files).

## What every test gets (from `setup.ts`)

| Thing | How |
|---|---|
| The backend | `fetch` is the fake API in `api.ts`, fresh per test. Nothing reaches a real server. |
| Router | `next/navigation` is `navigation.ts`: `setLocation("/shop?page=2", { slug: "x" })`, then assert `router.push` / `router.replace`. `redirect()` throws `RedirectError`, `notFound()` throws `NotFoundError`. |
| Images / fonts | `next/image` renders a plain `<img>`; `next/font/google` returns a stub. `next/link` is real. |
| Browser APIs | `matchMedia` (matches: false), `IntersectionObserver`, `ResizeObserver`, `scrollTo`, `scrollIntoView`, object URLs. |
| Clean state | Every Zustand store reset to its initial state; local/session storage and cookies cleared; mocks restored; real timers. |

## The fake API

```ts
import { api, ok, fail, raw, networkError, hang, file } from "@/test/api";

api.get("/products", [product]);                        // 200 { success: true, data }
api.get("/orders", ok([order], { total: 40, total_pages: 2 }));   // with pagination
api.post("/cart/items", (req) => ({ id: req.body.productId }));   // computed from the request
api.get("/orders/X", fail(404, "Not found", "NOT_FOUND"));        // error envelope
api.get("/x", raw(502, "<html>"));                      // malformed body
api.get("/x", networkError());                          // fetch rejects (offline)
api.get("/x", hang());                                  // never answers (fake timers → TIMEOUT)
api.once("GET", "/x", fail(500));                       // only the next call fails (retry tests)

api.last("POST", "/cart/items")?.body                   // what was sent
api.last()?.headers.authorization                       // "Bearer …"
api.last()?.query.get("page")                           // query string
api.requests("GET", /^\/orders/)                        // every matching call
api.unhandled                                           // requests nothing answered (404'd)
```

Paths are after `http://localhost:8000/api` and without the query string.
Later registrations win, so override a default inside a test.

## Signing in

```ts
import { renderUI, signIn, screen } from "@/test/render";
signIn();          // customer token "test-token" in local storage
signIn("admin");   // admin token
```

Some screens also read the session from a Zustand store (`useSessionStore`,
`useAdminAuthStore`) — set it with `useXStore.setState({...})`.

## Rules

- Test what the user sees and does: roles, labels, text. `data-testid` only when nothing else works.
- Mock at the network (`api`), not the module, unless a dependency is genuinely external
  (payment SDK script, `html-to-image`, `jspdf`, `exceljs`, canvas) — then `vi.mock` it.
- Never change application code to make a test pass. A test that reveals a bug is reported, not hidden.
- Tests must type-check (`tsc --noEmit` runs over them, and `next build` type-checks the project) and lint clean.
- Deterministic: fake timers for time, fixed dates (`vi.setSystemTime`), no real network.
