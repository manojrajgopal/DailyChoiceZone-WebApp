import { afterEach, describe, expect, it, vi } from "vitest";

import { VISITOR_KEY, VISITOR_PATTERN, getVisitorId } from "./visitor";

describe("getVisitorId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the analytics visitor id already in this browser", () => {
    window.localStorage.setItem(VISITOR_KEY, "existing_visitor-1");
    expect(getVisitorId()).toBe("existing_visitor-1");
  });

  it("creates and stores one in the API's format when there is none (or it is junk)", () => {
    window.localStorage.setItem(VISITOR_KEY, "bad id!");
    const id = getVisitorId();
    expect(id).toMatch(VISITOR_PATTERN);
    expect(window.localStorage.getItem(VISITOR_KEY)).toBe(id);
    expect(getVisitorId()).toBe(id);
  });

  it("is undefined when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getVisitorId()).toBeUndefined();
  });
});
