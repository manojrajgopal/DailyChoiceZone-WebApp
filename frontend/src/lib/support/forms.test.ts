import { afterEach, describe, expect, it } from "vitest";

import { FORMS, detectEnvironment, formFor } from "./forms";

describe("formFor", () => {
  it("returns the spec for a known category", () => {
    expect(formFor("bug")).toBe(FORMS.bug);
    expect(formFor("payment")).toBe(FORMS.payment);
  });

  it("falls back to general for undefined", () => {
    expect(formFor(undefined)).toBe(FORMS.general);
  });

  it("falls back to general for an unrecognised category name", () => {
    expect(formFor("not-a-real-category")).toBe(FORMS.general);
  });

  it("every form specifies a description label, placeholder and field list", () => {
    Object.values(FORMS).forEach((form) => {
      expect(typeof form.descriptionLabel).toBe("string");
      expect(typeof form.descriptionPlaceholder).toBe("string");
      expect(Array.isArray(form.fields)).toBe(true);
    });
  });

  it("every select field offers a non-empty list of options", () => {
    Object.values(FORMS).forEach((form) => {
      form.fields.filter((f) => f.type === "select").forEach((f) => {
        expect(f.options?.length).toBeGreaterThan(0);
      });
    });
  });
});

describe("detectEnvironment", () => {
  const originalUserAgent = navigator.userAgent;

  function setUserAgent(ua: string) {
    Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  }

  afterEach(() => {
    setUserAgent(originalUserAgent);
  });

  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36", "Chrome", "Windows", "Computer"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Firefox/120.0", "Firefox", "macOS", "Computer"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", "Safari", "iOS", "Phone"],
    ["Mozilla/5.0 (Linux; Android 13) Chrome/120.0 Mobi", "Chrome", "Android", "Phone"],
    ["Mozilla/5.0 (X11; Linux x86_64) Edg/120.0", "Edge", "Linux", "Computer"],
    ["Mozilla/5.0 Opera/9.80 OPR/60.0", "Opera", "", "Computer"],
  ])("parses %s", (ua, browser, os, device) => {
    setUserAgent(ua);
    const env = detectEnvironment();
    expect(env.browser).toBe(browser);
    expect(env.os).toBe(os);
    expect(env.device).toBe(device);
  });

  it("reports the screen size", () => {
    const env = detectEnvironment();
    expect(env.screen).toBe(`${window.screen.width}×${window.screen.height}`);
  });

  it("includes the referrer only when it is same-origin", () => {
    Object.defineProperty(document, "referrer", { value: `${window.location.origin}/help`, configurable: true });
    expect(detectEnvironment().pageUrl).toBe(`${window.location.origin}/help`);

    Object.defineProperty(document, "referrer", { value: "https://other-site.example/page", configurable: true });
    expect(detectEnvironment().pageUrl).toBe("");

    Object.defineProperty(document, "referrer", { value: "", configurable: true });
    expect(detectEnvironment().pageUrl).toBe("");
  });
});
