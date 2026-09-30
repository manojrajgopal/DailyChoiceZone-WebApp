/**
 * The one HTTP client.
 *
 * Every call to the backend goes through here: one place that knows the base
 * URL, one place that attaches the token, one place that unwraps the response
 * envelope, and one place that turns a failure into something a component can
 * render. `fetch` scattered through the app would be all four of those in
 * every file that called it.
 *
 * It runs on the server and in the browser. The difference is the token: a
 * server render has no local storage and no session, so it fetches only what
 * is public — which is every catalogue read. Anything that needs an account
 * happens in a client component, where the token exists.
 */

const BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api").replace(/\/$/, "");

/**
 * An API path as a URL a browser can load directly.
 *
 * For the handful of things that are not `fetch` calls — an `<img src>`, a
 * download link — which cannot go through this module's request helpers and
 * still need to point at the API rather than at the site.
 */
export function apiUrl(path: string): string {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Headers an ngrok tunnel needs, when the API is behind one.
 *
 * ngrok's free tunnels answer a *browser* request with their own HTML warning
 * page instead of forwarding it (`ERR_NGROK_6024`). That page has no CORS
 * headers, so every such call surfaces as a CORS error — while the API behind
 * the tunnel is fine. This header tells ngrok to forward the request.
 *
 * Sent only to ngrok hosts: any custom header makes every request need a
 * preflight, a round trip a real deployment should not pay for.
 */
const TUNNEL_HEADERS: Record<string, string> = ((): Record<string, string> => {
  try {
    const host = new URL(BASE_URL).hostname;
    return /\.ngrok(-free)?\.(app|dev|io)$/.test(host)
      ? { "ngrok-skip-browser-warning": "true" }
      : {};
  } catch {
    return {};
  }
})();

/**
 * An API image as something an `<img src>` can show.
 *
 * Normally just its URL. Behind an ngrok tunnel an `<img>` cannot send the
 * header above and would receive the warning page instead of the picture, so
 * the image is fetched with the header and handed over as an object URL.
 */
export async function apiImageSrc(path: string): Promise<string> {
  const url = apiUrl(path);
  if (!Object.keys(TUNNEL_HEADERS).length) return url;

  try {
    const response = await fetch(url, {
      headers: TUNNEL_HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return url;
    return URL.createObjectURL(await response.blob());
  } catch {
    return url;
  }
}

/** Where the token lives. Not business data — see `docs` in the README. */
const TOKEN_KEYS = {
  customer: "dcz:auth-token",
  admin: "dcz:admin-token",
} as const;

export type Audience = keyof typeof TOKEN_KEYS;

/** The envelope every endpoint returns. */
interface Envelope<T> {
  success: boolean;
  data?: T;
  message?: string;
  error_code?: string;
  details?: unknown;
  pagination?: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}

export class ApiError extends Error {
  readonly status: number;
  /** A stable code to branch on. Matching on `message` is a contract nobody agreed to. */
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when signing in again would fix it. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/* ------------------------------------------------------------------ tokens */

export function getToken(audience: Audience = "customer"): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEYS[audience]);
  } catch {
    // Local storage throws in private browsing and when site data is blocked.
    // No token is a valid state; a crash here is not.
    return null;
  }
}

export function setToken(token: string | null, audience: Audience = "customer"): void {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEYS[audience], token);
    else window.localStorage.removeItem(TOKEN_KEYS[audience]);
  } catch {
    /* see above */
  }
}

/* ------------------------------------------------------------------ paging */

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/* ----------------------------------------------------------------- requests */

export interface RequestOptions {
  /** Attach the token for this audience. Omit for public endpoints. */
  auth?: Audience;
  /** Next.js caching. `no-store` for anything that changes. */
  cache?: RequestCache;
  revalidate?: number;
  signal?: AbortSignal;
  /** How long to wait before giving up, in ms. Defaults to `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Extra headers — e.g. the key a guest opens their support ticket with,
   * which belongs in a header rather than a URL a server log would keep.
   */
  headers?: Record<string, string>;
}

/**
 * How long any request may take before it is abandoned.
 *
 * Without a limit, a server that accepts the connection and never answers
 * leaves a spinner turning forever. 20 seconds by default — far beyond a
 * healthy response — and `NEXT_PUBLIC_API_TIMEOUT_MS` to change it. File
 * uploads get longer, since the time is spent sending the file.
 */
export const REQUEST_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS) || 20_000;
export const UPLOAD_TIMEOUT_MS = Math.max(REQUEST_TIMEOUT_MS, 60_000);

const TIMEOUT_MESSAGE =
  "This is taking longer than expected. Please check your connection and try again.";
const OFFLINE_MESSAGE =
  "We couldn't connect just now. Please check your internet connection and try again.";

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<Envelope<T>> {
  const headers: Record<string, string> = { ...TUNNEL_HEADERS, ...options.headers };

  // A file upload is sent as the browser encodes it: no JSON, and no
  // Content-Type of our own, so the multipart boundary is set correctly.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";

  if (options.auth) {
    const token = getToken(options.auth);
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  // One controller for both reasons a request can stop: the caller's own
  // signal (a component unmounting) and the clock running out.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    options.timeoutMs ?? (isForm ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
  );
  const onCallerAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const finish = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  };

  const init: RequestInit & { next?: { revalidate: number } } = {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    signal: controller.signal,
  };

  /**
   * Default to `no-store`.
   *
   * The whole point of this backend is that an administrator's change shows up
   * on the next request. A cached fetch would reintroduce exactly the
   * staleness the static build had, and it would do it invisibly.
   */
  if (options.revalidate !== undefined) init.next = { revalidate: options.revalidate };
  else init.cache = options.cache ?? "no-store";

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, init);
  } catch (error) {
    finish();
    /**
     * Let Next's own signals through.
     *
     * A server render that reaches an uncached fetch throws to say "this route
     * is dynamic" — control flow, not a failure. Catching it here and
     * reporting a network error made every page that fetches fail the build
     * with a message about the API being down while the API was running.
     * Anything carrying a `digest` is Next's, and is rethrown untouched.
     */
    if (typeof (error as { digest?: unknown })?.digest === "string") throw error;

    if (timedOut) throw new ApiError(TIMEOUT_MESSAGE, 0, "TIMEOUT", error);
    // Stopped by the caller, not by us: pass it on untouched.
    if (options.signal?.aborted) throw error;

    // No answer at all — offline, or the service is unreachable.
    throw new ApiError(OFFLINE_MESSAGE, 0, "NETWORK_ERROR", error);
  }

  // The clock keeps running while the body arrives: a response that starts
  // and then stalls is as stuck as one that never starts.
  let payload: Envelope<T>;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch (error) {
    if (timedOut) throw new ApiError(TIMEOUT_MESSAGE, 0, "TIMEOUT", error);
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      "Something went wrong on our side. Please try again in a moment.",
      response.status,
      "BAD_RESPONSE",
    );
  } finally {
    finish();
  }

  if (!response.ok || payload.success === false) {
    throw new ApiError(
      payload.message ?? "Something went wrong. Please try again.",
      response.status,
      payload.error_code ?? "REQUEST_FAILED",
      payload.details,
    );
  }

  return payload;
}

/* -------------------------------------------------------------------- verbs */

export async function apiGet<T>(path: string, options?: RequestOptions): Promise<T> {
  const payload = await request<T>("GET", path, undefined, options);
  return payload.data as T;
}

export async function apiGetPage<T>(path: string, options?: RequestOptions): Promise<Page<T>> {
  const payload = await request<T[]>("GET", path, undefined, options);
  const pagination = payload.pagination;

  return {
    items: (payload.data ?? []) as T[],
    page: pagination?.page ?? 1,
    pageSize: pagination?.page_size ?? (payload.data?.length ?? 0),
    total: pagination?.total ?? (payload.data?.length ?? 0),
    totalPages: pagination?.total_pages ?? 1,
  };
}

export async function apiPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const payload = await request<T>("POST", path, body ?? {}, options);
  return payload.data as T;
}

export async function apiPut<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const payload = await request<T>("PUT", path, body ?? {}, options);
  return payload.data as T;
}

export async function apiDelete<T>(path: string, options?: RequestOptions): Promise<T> {
  const payload = await request<T>("DELETE", path, undefined, options);
  return payload.data as T;
}

/**
 * A GET that returns null on 404 instead of throwing.
 *
 * "This product does not exist" is an answer, not a failure — every caller
 * that looks something up by slug wants to render a not-found page rather than
 * an error boundary.
 */
export async function apiGetOrNull<T>(path: string, options?: RequestOptions): Promise<T | null> {
  try {
    return await apiGet<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Build a query string, dropping anything unset. */
export function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(","));
      continue;
    }
    search.set(key, String(value));
  }

  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}
