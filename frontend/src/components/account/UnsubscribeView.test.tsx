import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";

import { UnsubscribeView } from "./UnsubscribeView";

describe("UnsubscribeView", () => {
  it("shows a working state, then confirms the channel once unsubscribed", async () => {
    setLocation("/unsubscribe?token=TOK1");
    api.post("/notifications/unsubscribe", { channel: "sms", unsubscribed: true });
    renderUI(<UnsubscribeView />);
    expect(screen.getByRole("heading", { name: "Unsubscribing…" })).toBeInTheDocument();
    expect(screen.getByText("Just a moment.")).toBeInTheDocument();

    expect(await screen.findByRole("heading", { name: "You're unsubscribed" })).toBeInTheDocument();
    expect(screen.getByText(/You won't get marketing text messages from us any more\./)).toBeInTheDocument();
    expect(api.last("POST", "/notifications/unsubscribe")!.body).toEqual({ token: "TOK1" });
  });

  it.each([
    ["email", "emails"],
    ["whatsapp", "WhatsApp messages"],
    ["in_app", "notifications"],
  ])("names the %s channel as %s", async (channel, phrase) => {
    setLocation("/unsubscribe?token=TOK1");
    api.post("/notifications/unsubscribe", { channel, unsubscribed: true });
    renderUI(<UnsubscribeView />);
    expect(await screen.findByText(new RegExp(`You won't get marketing ${phrase} from us any more\\.`))).toBeInTheDocument();
  });

  it("falls back to 'messages' for an unrecognised channel", async () => {
    setLocation("/unsubscribe?token=TOK1");
    api.post("/notifications/unsubscribe", { channel: "fax", unsubscribed: true });
    renderUI(<UnsubscribeView />);
    expect(await screen.findByText(/You won't get marketing messages from us any more\./)).toBeInTheDocument();
  });

  it("explains an incomplete link without calling the server", async () => {
    setLocation("/unsubscribe");
    renderUI(<UnsubscribeView />);
    expect(await screen.findByRole("heading", { name: "We couldn't unsubscribe you" })).toBeInTheDocument();
    expect(screen.getByText("This unsubscribe link is incomplete.")).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it("shows the server's own message when it refuses the token", async () => {
    setLocation("/unsubscribe?token=BAD");
    api.post("/notifications/unsubscribe", fail(404, "This link has expired."));
    renderUI(<UnsubscribeView />);
    expect(await screen.findByText("This link has expired.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "We couldn't unsubscribe you" })).toBeInTheDocument();
  });

  it("links to preferences and to the shop", async () => {
    setLocation("/unsubscribe?token=TOK1");
    api.post("/notifications/unsubscribe", { channel: "email", unsubscribed: true });
    renderUI(<UnsubscribeView />);
    expect(screen.getByRole("link", { name: "Manage all your preferences" })).toHaveAttribute("href", "/account/settings");
    expect(screen.getByRole("link", { name: "Back to the shop" })).toHaveAttribute("href", "/");
  });

  it("sends the request only once even if the component re-renders", async () => {
    setLocation("/unsubscribe?token=TOK1");
    api.post("/notifications/unsubscribe", { channel: "email", unsubscribed: true });
    const { rerender } = renderUI(<UnsubscribeView />);
    await waitFor(() => expect(api.requests("POST", "/notifications/unsubscribe")).toHaveLength(1));
    rerender(<UnsubscribeView />);
    expect(api.requests("POST", "/notifications/unsubscribe")).toHaveLength(1);
  });
});
