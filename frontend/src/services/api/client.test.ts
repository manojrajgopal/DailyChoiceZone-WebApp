import { afterEach, describe, expect, it, vi } from "vitest";

import { api, fail, file, hang, networkError, ok, raw } from "@/test/api";

import {
  ApiError,
  REQUEST_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  apiDelete,
  apiDownload,
  apiGet,
  apiGetOrNull,
  apiGetPage,
  apiImageSrc,
  apiPost,
  apiPut,
  apiUrl,
  getToken,
  query,
  setToken,
} from "./client";

describe("apiUrl", () => {
  it("joins the base URL and a path with or without its leading slash", () => {
    expect(apiUrl("/products")).toBe("http://localhost:8000/api/products");
    expect(apiUrl("products")).toBe("http://localhost:8000/api/products");
  });
});

describe("apiImageSrc", () => {
  it("is the plain URL when the API is not behind a tunnel", async () => {
    await expect(apiImageSrc("/media/a.png")).resolves.toBe("http://localhost:8000/api/media/a.png");
    expect(api.calls).toHaveLength(0);
  });
});

describe("tokens", () => {
  it("stores, reads and clears a token per audience", () => {
    expect(getToken()).toBeNull();
    setToken("customer-token");
    setToken("admin-token", "admin");
    expect(getToken()).toBe("customer-token");
    expect(getToken("admin")).toBe("admin-token");
    expect(localStorage.getItem("dcz:auth-token")).toBe("customer-token");
    expect(localStorage.getItem("dcz:admin-token")).toBe("admin-token");
    setToken(null);
    expect(getToken()).toBeNull();
    expect(getToken("admin")).toBe("admin-token");
  });

  it("treats storage that throws (private browsing) as no token, without crashing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getToken()).toBeNull();
    expect(() => setToken("x")).not.toThrow();
  });
});

describe("requests", () => {
  describe("success cases", () => {
    it("GETs a path and unwraps the envelope's data", async () => {
      api.get("/products", [{ id: "P1" }]);
      await expect(apiGet("/products")).resolves.toEqual([{ id: "P1" }]);
      const request = api.last("GET", "/products")!;
      expect(request.body).toBeUndefined();
      expect(request.headers["content-type"]).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
    });

    it("POSTs and PUTs JSON bodies, defaulting to an empty object", async () => {
      api.post("/cart/items", (req) => ({ echo: req.body }));
      api.put("/cart/items/1", (req) => ({ echo: req.body }));
      await expect(apiPost("/cart/items", { productId: "P1", quantity: 2 })).resolves.toEqual({ echo: { productId: "P1", quantity: 2 } });
      await expect(apiPut("/cart/items/1")).resolves.toEqual({ echo: {} });
      expect(api.last("POST")!.headers["content-type"]).toBe("application/json");
      expect(api.last("PUT")!.body).toEqual({});
    });

    it("DELETEs without a body", async () => {
      api.delete("/cart/items/1", { removed: true });
      await expect(apiDelete("/cart/items/1")).resolves.toEqual({ removed: true });
      expect(api.last("DELETE")!.body).toBeUndefined();
    });

    it("sends FormData as-is, without a JSON content type", async () => {
      api.post("/uploads", { ok: true });
      const form = new FormData();
      form.append("file", new Blob(["x"]), "x.txt");
      await apiPost("/uploads", form);
      const request = api.last("POST", "/uploads")!;
      expect(request.body).toBeInstanceOf(FormData);
      expect(request.headers["content-type"]).toBeUndefined();
    });

    it("attaches the token for the requested audience only", async () => {
      api.get("/account", {});
      setToken("cust");
      setToken("adm", "admin");
      await apiGet("/account", { auth: "customer" });
      expect(api.last()!.headers.authorization).toBe("Bearer cust");
      await apiGet("/account", { auth: "admin" });
      expect(api.last()!.headers.authorization).toBe("Bearer adm");
      await apiGet("/account");
      expect(api.last()!.headers.authorization).toBeUndefined();
    });

    it("sends no Authorization header when the audience has no token", async () => {
      api.get("/account", {});
      await apiGet("/account", { auth: "customer" });
      expect(api.last()!.headers.authorization).toBeUndefined();
    });

    it("passes extra headers through", async () => {
      api.get("/support/tickets/T1", {});
      await apiGet("/support/tickets/T1", { headers: { "X-Ticket-Key": "secret" } });
      expect(api.last()!.headers["x-ticket-key"]).toBe("secret");
    });

    it("defaults to no-store caching, honours an explicit cache, and uses revalidate when given", async () => {
      api.get("/x", {});
      const fetchSpy = vi.mocked(fetch);
      await apiGet("/x");
      expect(fetchSpy.mock.calls.at(-1)![1]).toMatchObject({ cache: "no-store" });
      await apiGet("/x", { cache: "force-cache" });
      expect(fetchSpy.mock.calls.at(-1)![1]).toMatchObject({ cache: "force-cache" });
      await apiGet("/x", { revalidate: 60 });
      const init = fetchSpy.mock.calls.at(-1)![1] as RequestInit & { next?: unknown };
      expect(init.next).toEqual({ revalidate: 60 });
      expect(init.cache).toBeUndefined();
    });

    it("returns undefined data when the envelope has none", async () => {
      api.get("/empty", raw(200, { success: true }));
      await expect(apiGet("/empty")).resolves.toBeUndefined();
    });
  });

  describe("error cases", () => {
    it.each([
      [400, "Bad input", "VALIDATION_ERROR"],
      [401, "Sign in again", "UNAUTHORIZED"],
      [403, "Not allowed", "FORBIDDEN"],
      [404, "Not found", "NOT_FOUND"],
      [409, "Already exists", "CONFLICT"],
      [422, "Invalid", "VALIDATION_ERROR"],
      [500, "Server error", "INTERNAL_ERROR"],
    ])("turns a %i envelope into an ApiError with its message and code", async (status, message, code) => {
      api.get("/x", fail(status, message, code, { field: "email" }));
      const error = await apiGet("/x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status, message, code, details: { field: "email" }, name: "ApiError" });
      expect((error as ApiError).isAuthError).toBe(status === 401);
    });

    it("treats a 200 with success: false as a failure", async () => {
      api.get("/x", raw(200, { success: false, message: "Nope" }));
      await expect(apiGet("/x")).rejects.toMatchObject({ status: 200, message: "Nope", code: "REQUEST_FAILED" });
    });

    it("falls back to a generic message when the error has none", async () => {
      api.get("/x", raw(500, {}));
      await expect(apiGet("/x")).rejects.toMatchObject({ message: "Something went wrong. Please try again.", code: "REQUEST_FAILED" });
    });

    it("reports a body that isn't JSON as a bad response", async () => {
      api.get("/x", raw(502, "<html>Bad gateway</html>"));
      await expect(apiGet("/x")).rejects.toMatchObject({ status: 502, code: "BAD_RESPONSE" });
    });

    it("reports an unreachable server as a network error", async () => {
      api.get("/x", networkError());
      await expect(apiGet("/x")).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
    });

    it("lets Next's own control-flow errors (with a digest) through untouched", async () => {
      const signal = Object.assign(new Error("DYNAMIC_SERVER_USAGE"), { digest: "DYNAMIC_SERVER_USAGE" });
      api.get("/x", networkError(signal));
      await expect(apiGet("/x")).rejects.toBe(signal);
    });

    it("gives up after the timeout with a TIMEOUT error", async () => {
      vi.useFakeTimers();
      api.get("/slow", hang());
      const pending = apiGet("/slow").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      await expect(pending).resolves.toMatchObject({ code: "TIMEOUT", status: 0 });
    });

    it("honours a per-request timeout", async () => {
      vi.useFakeTimers();
      api.get("/slow", hang());
      const pending = apiGet("/slow", { timeoutMs: 50 }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(51);
      await expect(pending).resolves.toMatchObject({ code: "TIMEOUT" });
    });

    it("rethrows the caller's own abort rather than calling it a network error", async () => {
      api.get("/slow", hang());
      const controller = new AbortController();
      const pending = apiGet("/slow", { signal: controller.signal }).catch((e: unknown) => e);
      controller.abort();
      const error = await pending;
      expect(error).not.toBeInstanceOf(ApiError);
      expect((error as Error).name).toBe("AbortError");
    });

    it("aborts straight away when the caller's signal is already aborted", async () => {
      api.get("/slow", hang());
      const controller = new AbortController();
      controller.abort();
      await expect(apiGet("/slow", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    });

    it("uploads get the longer timeout", () => {
      expect(UPLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
      expect(UPLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS);
    });
  });
});

describe("apiGetPage", () => {
  it("maps the API's snake_case pagination", async () => {
    api.get("/orders", ok([{ id: 1 }, { id: 2 }], { page: 2, page_size: 2, total: 9, total_pages: 5 }));
    await expect(apiGetPage("/orders")).resolves.toEqual({ items: [{ id: 1 }, { id: 2 }], page: 2, pageSize: 2, total: 9, totalPages: 5 });
  });

  it("falls back to the item count when there is no pagination", async () => {
    api.get("/orders", [{ id: 1 }, { id: 2 }, { id: 3 }]);
    await expect(apiGetPage("/orders")).resolves.toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], page: 1, pageSize: 3, total: 3, totalPages: 1 });
  });

  it("is an empty first page when there is no data at all", async () => {
    api.get("/orders", raw(200, { success: true }));
    await expect(apiGetPage("/orders")).resolves.toEqual({ items: [], page: 1, pageSize: 0, total: 0, totalPages: 1 });
  });
});

describe("apiGetOrNull", () => {
  it("returns the data when found", async () => {
    api.get("/products/a", { slug: "a" });
    await expect(apiGetOrNull("/products/a")).resolves.toEqual({ slug: "a" });
  });

  it("returns null on 404", async () => {
    api.get("/products/missing", fail(404, "Not found", "NOT_FOUND"));
    await expect(apiGetOrNull("/products/missing")).resolves.toBeNull();
  });

  it("still throws other failures", async () => {
    api.get("/products/a", fail(500));
    await expect(apiGetOrNull("/products/a")).rejects.toMatchObject({ status: 500 });
  });
});

describe("apiDownload", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("downloads with the token, named from Content-Disposition", async () => {
    vi.useFakeTimers();
    setToken("adm", "admin");
    api.get("/admin/orders/export", file("a,b\n1,2", { "content-disposition": 'attachment; filename="orders.csv"' }));
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:orders");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    let downloaded = "";
    click.mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });

    await apiDownload("/admin/orders/export", "admin", "fallback.csv");

    expect(api.last()!.headers.authorization).toBe("Bearer adm");
    expect(create).toHaveBeenCalled();
    expect(downloaded).toBe("orders.csv");
    expect(document.querySelector("a[download]")).toBeNull(); // the temporary link is removed
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith("blob:orders");
  });

  it("uses the fallback name without a Content-Disposition, and no header without a token", async () => {
    api.get("/admin/x", file("data"));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    let downloaded = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    await apiDownload("/admin/x", "admin", "fallback.csv");
    expect(downloaded).toBe("fallback.csv");
    expect(api.last()!.headers.authorization).toBeUndefined();
  });

  it("throws the server's message when the download fails", async () => {
    api.get("/admin/x", fail(403, "Not allowed"));
    await expect(apiDownload("/admin/x", "admin", "f.csv")).rejects.toMatchObject({ status: 403, message: "Not allowed", code: "DOWNLOAD_FAILED" });
  });

  it("throws a plain message when the failed download isn't JSON", async () => {
    api.get("/admin/x", raw(500, "oops"));
    await expect(apiDownload("/admin/x", "admin", "f.csv")).rejects.toMatchObject({ message: "The download didn't work. Please try again." });
  });
});

describe("query", () => {
  it("builds a query string and drops unset values", () => {
    expect(query({ q: "kurta", page: 2, empty: "", none: null, missing: undefined, zero: 0, no: false })).toBe("?q=kurta&page=2&zero=0&no=false");
  });

  it("joins arrays with commas and drops empty arrays", () => {
    expect(query({ sizes: ["S", "M"], colors: [] })).toBe("?sizes=S%2CM");
  });

  it("is an empty string when nothing is set", () => {
    expect(query({})).toBe("");
    expect(query({ a: undefined, b: "" })).toBe("");
  });

  it("encodes special characters", () => {
    expect(query({ q: "a&b c" })).toBe("?q=a%26b+c");
  });
});
