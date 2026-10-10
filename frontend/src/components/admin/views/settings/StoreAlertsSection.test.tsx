import { describe, expect, it, vi } from "vitest";

import { api } from "@/test/api";
import { renderUI, screen, signIn, waitFor } from "@/test/render";
import { DEFAULT_NOTIFICATIONS, withNotificationDefaults } from "@/services/admin/settingsAdminService";
import { useToastStore } from "@/store/toastStore";

import { StoreAlertsSection } from "./StoreAlertsSection";

const CHANNELS = {
  inApp: { enabled: true, configured: true, reason: "" },
  email: { enabled: true, configured: true, reason: "" },
  sms: { enabled: false, configured: false, reason: "No SMS provider is configured." },
  whatsapp: { enabled: false, configured: false, reason: "No WhatsApp provider is configured." },
};

describe("StoreAlertsSection", () => {
  it("shows which channels are ready, and why the others aren't", async () => {
    signIn("admin");
    api.get("/admin/alert-channels", CHANNELS);
    renderUI(<StoreAlertsSection value={DEFAULT_NOTIFICATIONS} onChange={() => {}} />);

    expect(await screen.findByText("No SMS provider is configured.")).toBeInTheDocument();
    expect(screen.getAllByText("Ready")).toHaveLength(2);
    expect(screen.getAllByText("Not set up")).toHaveLength(2);
  });

  it("adds a recipient email", async () => {
    signIn("admin");
    api.get("/admin/alert-channels", CHANNELS);
    const onChange = vi.fn();
    const { user } = renderUI(<StoreAlertsSection value={DEFAULT_NOTIFICATIONS} onChange={onChange} />);

    await user.type(screen.getByLabelText("Emails"), "owner@gmail.com{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({ alertRecipients: { emails: ["owner@gmail.com"], phones: [] } });
  });

  it("switches an alert group off", async () => {
    signIn("admin");
    api.get("/admin/alert-channels", CHANNELS);
    const onChange = vi.fn();
    const { user } = renderUI(<StoreAlertsSection value={DEFAULT_NOTIFICATIONS} onChange={onChange} />);

    await user.click(screen.getByRole("switch", { name: /New customers/ }));
    expect(onChange).toHaveBeenLastCalledWith({ customerAlerts: false });
  });

  it("sends a test alert", async () => {
    signIn("admin");
    api.get("/admin/alert-channels", CHANNELS);
    api.post("/admin/alert-channels/test", { channels: CHANNELS, sent: { email: ["admin@example.com"] } });
    const { user } = renderUI(<StoreAlertsSection value={DEFAULT_NOTIFICATIONS} onChange={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Send test alert/ }));
    await waitFor(() => expect(api.requests("POST", "/admin/alert-channels/test")).toHaveLength(1));
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.message))
      .toContain("Test alert sent. Check the bell, your inbox and your phone."));
  });
});

describe("withNotificationDefaults", () => {
  it("fills in what settings saved before these fields existed lack", () => {
    const filled = withNotificationDefaults({ orderConfirmation: false, lowStockAlerts: false } as never);
    expect(filled.orderConfirmation).toBe(false);
    expect(filled.lowStockAlerts).toBe(false);
    expect(filled.orderAlerts).toBe(true);
    expect(filled.alertRecipients).toEqual({ emails: [], phones: [] });
    expect(filled.alertChannels).toEqual({ email: true, sms: false, whatsapp: false, inApp: true });
  });
});
