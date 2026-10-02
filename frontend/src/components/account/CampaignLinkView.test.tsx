import { afterEach, describe, expect, it, vi } from "vitest";

import { api, fail } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";

import { CampaignLinkView } from "./CampaignLinkView";

/**
 * jsdom's `window.location.replace` cannot be spied on directly (it isn't a
 * configurable own property), so the whole `location` object is swapped out
 * for the duration of each test and restored afterwards.
 */
const originalLocation = window.location;
function stubLocationReplace() {
  const replace = vi.fn();
  Object.defineProperty(window, "location", { value: { ...originalLocation, replace }, configurable: true, writable: true });
  return replace;
}

describe("CampaignLinkView", () => {
  afterEach(() => {
    Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true });
  });

  it("records the click and follows the signed destination", async () => {
    setLocation("/c/TOK1?to=%2Fshop%2Fsale&s=SIG1");
    api.post("/campaigns/click", { url: "https://dcz.example/shop/sale" });
    const replace = stubLocationReplace();

    renderUI(<CampaignLinkView token="TOK1" />);
    expect(screen.getByText("Taking you there…")).toBeInTheDocument();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("https://dcz.example/shop/sale"));
    expect(api.last("POST", "/campaigns/click")!.body).toEqual({ token: "TOK1", to: "/shop/sale", s: "SIG1" });
  });

  it("sends empty strings for missing to/s query params", async () => {
    setLocation("/c/TOK1");
    api.post("/campaigns/click", { url: "/" });
    stubLocationReplace();
    renderUI(<CampaignLinkView token="TOK1" />);
    await waitFor(() => expect(api.last("POST", "/campaigns/click")!.body).toEqual({ token: "TOK1", to: "", s: "" }));
  });

  it("offers a way back to the shop when the link is invalid", async () => {
    setLocation("/c/TOK1?to=%2Fshop&s=bad");
    api.post("/campaigns/click", fail(404, "Invalid link"));
    renderUI(<CampaignLinkView token="TOK1" />);
    expect(await screen.findByText(/This link isn.t valid\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the shop" })).toHaveAttribute("href", "/");
  });

  it("follows the link only once even if the component re-renders", async () => {
    setLocation("/c/TOK1?to=%2Fshop&s=SIG1");
    api.post("/campaigns/click", { url: "/shop" });
    stubLocationReplace();
    const { rerender } = renderUI(<CampaignLinkView token="TOK1" />);
    await waitFor(() => expect(api.requests("POST", "/campaigns/click")).toHaveLength(1));
    rerender(<CampaignLinkView token="TOK1" />);
    expect(api.requests("POST", "/campaigns/click")).toHaveLength(1);
  });
});
