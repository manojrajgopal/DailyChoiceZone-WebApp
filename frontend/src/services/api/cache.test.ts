import { describe, expect, it, vi } from "vitest";

import { pageCache } from "./cache";

/**
 * This suite runs in jsdom, so `typeof window !== "undefined"` is always
 * true for ordinary tests — the browser branch is what gets exercised by
 * default. The "server" tests below delete `globalThis.window` for the
 * duration of one call to reach the other branch.
 *
 * Note: React's `cache()` only memoizes a call within an active render pass.
 * Called outside of React render (as in a plain unit test), it does not
 * dedupe — so the "server" tests below confirm that branch delegates to the
 * fetcher and returns its value, not that it dedupes per request; that
 * dedupe can only be observed inside a real Server Component render.
 */

describe("pageCache (browser)", () => {
  it("calls the fetcher once and reuses the result for later reads", async () => {
    const fetcher = vi.fn(async () => ({ value: 1 }));
    const cache = pageCache(fetcher);

    const first = await cache.read();
    const second = await cache.read();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(first).toBe(second);
  });

  it("shares one in-flight promise between concurrent reads", async () => {
    let resolveFetch: (value: string) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<string>((resolve) => { resolveFetch = resolve; }));
    const cache = pageCache(fetcher);

    const a = cache.read();
    const b = cache.read();
    resolveFetch("done");

    expect(await a).toBe("done");
    expect(await b).toBe("done");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not cache a rejected fetch, so the next read retries", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce("recovered");
    const cache = pageCache(fetcher);

    await expect(cache.read()).rejects.toThrow("network down");
    await expect(cache.read()).resolves.toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidate drops the cached promise so the next read calls the fetcher again", async () => {
    const fetcher = vi.fn(async () => "value");
    const cache = pageCache(fetcher);

    await cache.read();
    cache.invalidate();
    await cache.read();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidate before any read is a no-op", async () => {
    const fetcher = vi.fn(async () => "value");
    const cache = pageCache(fetcher);
    expect(() => cache.invalidate()).not.toThrow();
    await expect(cache.read()).resolves.toBe("value");
  });
});

describe("pageCache (server: no window)", () => {
  async function withoutWindow<T>(fn: () => Promise<T>): Promise<T> {
    const original = globalThis.window;
    // @ts-expect-error -- simulating a server render, where `window` is undefined
    delete globalThis.window;
    try {
      return await fn();
    } finally {
      globalThis.window = original;
    }
  }

  it("delegates to the fetcher and returns its value", async () => {
    const fetcher = vi.fn(async () => "server-value");
    const cache = pageCache(fetcher);
    await withoutWindow(async () => {
      await expect(cache.read()).resolves.toBe("server-value");
    });
    expect(fetcher).toHaveBeenCalled();
  });

  it("propagates a fetcher's rejection", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("boom");
    });
    const cache = pageCache(fetcher);
    await withoutWindow(async () => {
      await expect(cache.read()).rejects.toThrow("boom");
    });
  });
});
