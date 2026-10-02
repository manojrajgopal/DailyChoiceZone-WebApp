/**
 * A fake backend at `fetch`.
 *
 * Every request the app makes goes through `services/api/client.ts`, which
 * calls `fetch`. Tests register what each endpoint answers and then read back
 * exactly what was sent:
 *
 *   api.get("/products", [product])                       // 200 with { success, data }
 *   api.post("/cart/items", (req) => ({ id: req.body.productId }))
 *   api.get("/orders", ok([order], { total: 40 }))        // with pagination
 *   api.get("/orders/X", fail(404, "Not found"))          // an error envelope
 *   api.get("/slow", networkError())                      // fetch rejects
 *
 *   expect(api.last("POST", "/cart/items")?.body).toEqual({ productId: "P1" })
 *
 * Paths are matched without the base URL and without the query string; a
 * request nobody registered answers 404 and is recorded in `api.unhandled`,
 * so a test never reaches a real server.
 */
import { vi } from "vitest";

export const API_BASE = "http://localhost:8000/api";

export interface RecordedRequest {
  method: string;
  /** Path after the base URL, without the query string, e.g. "/products". */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, the FormData itself, or undefined. Loosely typed so tests can read any field. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, string>;
  url: string;
}

interface Reply {
  status: number;
  body?: unknown;
  /** Raw text instead of JSON (for malformed responses). */
  text?: string;
  headers?: Record<string, string>;
  /** Reject the fetch itself, as a network failure would. */
  reject?: unknown;
  /** Never settle until the request is aborted. */
  hang?: boolean;
  /** Answer with a Blob body (downloads). */
  blob?: Blob;
}

const REPLY = Symbol("reply");
type Marked = Reply & { [REPLY]: true };

/** A successful envelope, optionally with pagination (snake_case, as the API sends it). */
export function ok(data: unknown, pagination?: Partial<{ page: number; page_size: number; total: number; total_pages: number }>): Marked {
  return {
    [REPLY]: true,
    status: 200,
    body: pagination
      ? { success: true, data, pagination: { page: 1, page_size: 20, total: Array.isArray(data) ? data.length : 0, total_pages: 1, ...pagination } }
      : { success: true, data },
  };
}

/** An error envelope with this status, message and error code. */
export function fail(status: number, message = "Something failed.", code = "REQUEST_FAILED", details?: unknown): Marked {
  return { [REPLY]: true, status, body: { success: false, message, error_code: code, details } };
}

/** Any status with any raw body (for malformed or unusual responses). */
export function raw(status: number, body: unknown, headers?: Record<string, string>): Marked {
  return typeof body === "string"
    ? { [REPLY]: true, status, text: body, headers }
    : { [REPLY]: true, status, body, headers };
}

/** `fetch` rejects, as when offline. */
export function networkError(error: unknown = new TypeError("Failed to fetch")): Marked {
  return { [REPLY]: true, status: 0, reject: error };
}

/** Never answers; resolves only by abort (use with fake timers to test timeouts). */
export function hang(): Marked {
  return { [REPLY]: true, status: 0, hang: true };
}

/** A file download response. */
export function file(content: string, headers: Record<string, string> = {}, status = 200): Marked {
  return { [REPLY]: true, status, blob: new Blob([content]), headers };
}

/** Data (sent as a 200 envelope), a reply helper's result, or a function of the request returning either. */
type Handler = ((request: RecordedRequest) => unknown) | object | string | number | boolean | null;

interface Route {
  method: string;
  path: string | RegExp;
  handler: Handler;
  once: boolean;
}

function isMarked(value: unknown): value is Marked {
  return typeof value === "object" && value !== null && REPLY in value;
}

function toResponse(reply: Reply): Response {
  const headers = new Headers(reply.headers);
  if (reply.blob) return new Response(reply.blob, { status: reply.status, headers });
  if (reply.text !== undefined) return new Response(reply.text, { status: reply.status, headers });
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers });
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}

class FakeApi {
  routes: Route[] = [];
  calls: RecordedRequest[] = [];
  unhandled: RecordedRequest[] = [];

  /** Answer `method path` with `handler` (data → 200 envelope, a reply helper, or a function of the request). */
  on(method: string, path: string | RegExp, handler: Handler, { once = false } = {}) {
    // Later registrations win, so a test can override a default.
    this.routes.unshift({ method: method.toUpperCase(), path, handler, once });
    return this;
  }

  get(path: string | RegExp, handler: Handler = null) {
    return this.on("GET", path, handler);
  }

  post(path: string | RegExp, handler: Handler = null) {
    return this.on("POST", path, handler);
  }

  put(path: string | RegExp, handler: Handler = null) {
    return this.on("PUT", path, handler);
  }

  patch(path: string | RegExp, handler: Handler = null) {
    return this.on("PATCH", path, handler);
  }

  delete(path: string | RegExp, handler: Handler = null) {
    return this.on("DELETE", path, handler);
  }

  /** Answer only the next matching request this way. */
  once(method: string, path: string | RegExp, handler: Handler) {
    return this.on(method, path, handler, { once: true });
  }

  /** Every recorded request to `method path` (path without query). */
  requests(method?: string, path?: string | RegExp): RecordedRequest[] {
    return this.calls.filter((call) =>
      (!method || call.method === method.toUpperCase()) &&
      (!path || (typeof path === "string" ? call.path === path : path.test(call.path))),
    );
  }

  last(method?: string, path?: string | RegExp): RecordedRequest | undefined {
    return this.requests(method, path).at(-1);
  }

  reset() {
    this.routes = [];
    this.calls = [];
    this.unhandled = [];
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const base = new URL(API_BASE);
    const path = url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) || "/" : url.pathname;
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      path,
      query: url.searchParams,
      body: parseBody(init?.body),
      headers: headersOf(init),
      url: url.href,
    };
    this.calls.push(request);

    const index = this.routes.findIndex((route) =>
      route.method === request.method &&
      (typeof route.path === "string" ? route.path === path : route.path.test(path)),
    );
    if (index === -1) {
      this.unhandled.push(request);
      return toResponse(fail(404, `No test handler for ${request.method} ${path}`, "NOT_FOUND"));
    }
    const route = this.routes[index]!;
    if (route.once) this.routes.splice(index, 1);

    const result = typeof route.handler === "function" ? await (route.handler as (r: RecordedRequest) => unknown)(request) : route.handler;
    const reply: Reply = isMarked(result) ? result : ok(result);

    if (reply.reject !== undefined) throw reply.reject;
    if (reply.hang) {
      return new Promise<Response>((_, rejectFetch) => {
        const signal = init?.signal;
        const abort = () => rejectFetch(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return toResponse(reply);
  };
}

export const api = new FakeApi();

/** Installed for every test by `setup.ts`. */
export function installFakeApi() {
  api.reset();
  vi.stubGlobal("fetch", vi.fn(api.fetch));
}
