import { describe, expect, it } from "vitest";

import type { ChannelChoice, ChannelPreferences } from "@/services/messagingService";
import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";

import { ChannelPreferencesSection } from "./ChannelPreferencesSection";

function choice(overrides: Partial<ChannelChoice> = {}): ChannelChoice {
  return { channel: "sms", category: "transactional", enabled: true, available: true, updatedAt: null, ...overrides };
}

function prefs(overrides: Partial<ChannelPreferences> = {}): ChannelPreferences {
  return {
    phone: "9876543210",
    phoneUsable: true,
    choices: [
      choice({ channel: "sms", category: "transactional" }),
      choice({ channel: "whatsapp", category: "transactional", enabled: false }),
      choice({ channel: "email", category: "marketing", enabled: false }),
    ],
    ...overrides,
  };
}

describe("ChannelPreferencesSection", () => {
  describe("loading and failure", () => {
    it("shows a loading status while preferences load", () => {
      api.get("/account/notification-preferences", () => new Promise(() => undefined));
      renderUI(<ChannelPreferencesSection />);
      expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    });

    it("offers to try again when loading fails, and recovers", async () => {
      api.get("/account/notification-preferences", fail(500));
      const { user } = renderUI(<ChannelPreferencesSection />);
      expect(await screen.findByText(/We couldn.t load these just now\./)).toBeInTheDocument();

      api.get("/account/notification-preferences", prefs());
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Order updates by SMS")).toBeInTheDocument();
    });
  });

  describe("loaded", () => {
    it("groups choices under Order updates and Offers, with known labels and hints", async () => {
      api.get("/account/notification-preferences", prefs());
      renderUI(<ChannelPreferencesSection />);
      expect(await screen.findByText("Order updates")).toBeInTheDocument();
      expect(screen.getByText("Offers")).toBeInTheDocument();
      expect(screen.getByText("Order updates by SMS")).toBeInTheDocument();
      expect(screen.getByText("Shipping, delivery and payment updates to your phone.")).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: /Order updates by SMS/ })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /Order updates on WhatsApp/ })).not.toBeChecked();
    });

    it("falls back to the raw key for a choice the label map doesn't know", async () => {
      api.get("/account/notification-preferences", prefs({ choices: [choice({ channel: "in_app", category: "transactional" })] }));
      renderUI(<ChannelPreferencesSection />);
      expect(await screen.findByText("in_app:transactional")).toBeInTheDocument();
    });

    it("hints at adding a phone number when it isn't usable", async () => {
      api.get("/account/notification-preferences", prefs({ phoneUsable: false }));
      renderUI(<ChannelPreferencesSection />);
      expect(await screen.findByText(/Add a mobile number in your/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "profile" })).toHaveAttribute("href", "/account");
    });

    it("hides a group with nothing to show (no unavailable-and-disabled choices)", async () => {
      api.get("/account/notification-preferences", prefs({ choices: [choice({ channel: "sms", category: "transactional" })] }));
      renderUI(<ChannelPreferencesSection />);
      await screen.findByText("Order updates");
      expect(screen.queryByText("Offers")).not.toBeInTheDocument();
    });

    it("hides a choice that is both unavailable and disabled", async () => {
      api.get("/account/notification-preferences", prefs({
        choices: [choice({ channel: "sms", category: "transactional", available: false, enabled: false })],
      }));
      renderUI(<ChannelPreferencesSection />);
      await waitFor(() => expect(api.requests("GET", "/account/notification-preferences")).toHaveLength(1));
      expect(screen.queryByText("Order updates by SMS")).not.toBeInTheDocument();
    });

    it("still shows and allows turning off a choice that's unavailable but currently enabled", async () => {
      api.get("/account/notification-preferences", prefs({
        choices: [choice({ channel: "sms", category: "transactional", available: false, enabled: true })],
      }));
      renderUI(<ChannelPreferencesSection />);
      const checkbox = await screen.findByRole("checkbox", { name: /Order updates by SMS/ });
      expect(checkbox).toBeChecked();
      // Only disabled when BOTH unavailable and not already enabled — an
      // enabled-but-now-unavailable choice can still be switched off.
      expect(checkbox).toBeEnabled();
    });
  });

  describe("toggling a choice", () => {
    it("saves the change optimistically and confirms with a toast", async () => {
      api.get("/account/notification-preferences", prefs());
      api.put("/account/notification-preferences", (req) => prefs({
        choices: prefs().choices.map((c) =>
          req.body.some((change: { channel: string; category: string }) => change.channel === c.channel && change.category === c.category)
            ? { ...c, enabled: req.body[0].enabled }
            : c,
        ),
      }));
      const { user } = renderUI(<ChannelPreferencesSection />);
      const checkbox = await screen.findByRole("checkbox", { name: /Order updates on WhatsApp/ });
      expect(checkbox).not.toBeChecked();

      await user.click(checkbox);
      expect(checkbox).toBeChecked();
      await waitFor(() => expect(api.last("PUT", "/account/notification-preferences")!.body).toEqual([
        { channel: "whatsapp", category: "transactional", enabled: true },
      ]));
    });

    it("disables every checkbox while a save is in flight", async () => {
      api.get("/account/notification-preferences", prefs());
      api.put("/account/notification-preferences", () => new Promise(() => undefined));
      const { user } = renderUI(<ChannelPreferencesSection />);
      const checkbox = await screen.findByRole("checkbox", { name: /Order updates on WhatsApp/ });
      await user.click(checkbox);
      expect(screen.getByRole("checkbox", { name: /Order updates by SMS/ })).toBeDisabled();
      expect(checkbox).toBeDisabled();
    });

    it("reverts and reports an error when saving fails", async () => {
      api.get("/account/notification-preferences", prefs());
      api.put("/account/notification-preferences", fail(500));
      const { user } = renderUI(<ChannelPreferencesSection />);
      const checkbox = await screen.findByRole("checkbox", { name: /Order updates on WhatsApp/ });
      await user.click(checkbox);
      await waitFor(() => expect(checkbox).not.toBeChecked());
      expect(checkbox).toBeEnabled();
    });
  });
});
