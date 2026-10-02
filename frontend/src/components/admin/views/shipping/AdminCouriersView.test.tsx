import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { manualProvider, providerConfig } from "@/test/shipping-fixtures";
import { useToastStore } from "@/store/toastStore";

import { AdminCouriersView } from "./AdminCouriersView";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

async function open(providers = [providerConfig(), manualProvider()]) {
  api.get("/admin/shipping/providers", providers);
  const view = renderUI(<AdminCouriersView />);
  await screen.findByRole("region", { name: providers[0]!.name });
  return view;
}

const card = (name: string) => screen.getByRole("region", { name });
/** The badges in a card's header. */
const badges = (name: string) => within(card(name).querySelector("header")!);

describe("AdminCouriersView", () => {
  describe("loading, error, empty and access", () => {
    it("shows placeholders while loading", () => {
      api.get("/admin/shipping/providers", () => new Promise(() => undefined));
      renderUI(<AdminCouriersView />);
      expect(screen.getByLabelText("Loading couriers")).toBeInTheDocument();
    });

    it("shows the API's message and retries", async () => {
      api.get("/admin/shipping/providers", [providerConfig()]);
      api.once("GET", "/admin/shipping/providers", fail(500, "Settings are unavailable.", "INTERNAL"));
      const { user } = renderUI(<AdminCouriersView />);
      expect(await screen.findByText("Settings are unavailable.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("region", { name: "Shiprocket" })).toBeInTheDocument();
    });

    it("tells an administrator without shipping-config that only a super admin can change couriers", async () => {
      api.get("/admin/shipping/providers", fail(403, "Forbidden", "FORBIDDEN"));
      renderUI(<AdminCouriersView />);
      expect(await screen.findByText("Only a super admin can change couriers")).toBeInTheDocument();
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
    });

    it("says when no integrations exist", async () => {
      api.get("/admin/shipping/providers", []);
      renderUI(<AdminCouriersView />);
      expect(await screen.findByText("No courier integrations are available.")).toBeInTheDocument();
    });
  });

  describe("each provider", () => {
    it("shows its state and settings, and masks the stored credentials without filling them in", async () => {
      signIn("admin", "adm");
      await open();
      const shiprocket = card("Shiprocket");
      expect(within(shiprocket).getByText("Book couriers through Shiprocket.")).toBeInTheDocument();
      for (const badge of ["Active", "Default", "Configured"]) expect(badges("Shiprocket").getByText(badge)).toBeInTheDocument();

      expect(within(shiprocket).getByLabelText("Environment")).toBeDisabled();
      expect(within(shiprocket).getByText("Shiprocket offers production only.")).toBeInTheDocument();
      expect(within(shiprocket).getByLabelText("Pickup location")).toHaveValue("Primary");
      expect(within(shiprocket).getByLabelText("Default service")).toHaveValue("Surface");
      expect(within(shiprocket).getByRole("button", { name: "Remove Express" })).toBeInTheDocument();
      expect(within(shiprocket).getByLabelText("PIN code")).toHaveValue("560001");

      const password = within(shiprocket).getByLabelText("API user password");
      expect(password).toHaveAttribute("type", "password");
      expect(password).toHaveValue("");
      expect(password).toHaveAttribute("placeholder", "••••••••");
      expect(within(shiprocket).getByLabelText("Webhook token")).toHaveAttribute("placeholder", "••••abcd");

      expect(within(shiprocket).getByLabelText("Shiprocket webhook URL")).toHaveValue("https://api.example/api/shipping/webhooks/shiprocket");
      expect(within(shiprocket).getByText(/^Last tested .* — worked$/)).toBeInTheDocument();
      expect(api.last("GET", "/admin/shipping/providers")!.headers.authorization).toBe("Bearer adm");
    });

    it("leaves out credentials, webhook and pickup location for a manual courier", async () => {
      await open();
      const manual = card("Manual");
      expect(within(manual).queryByText("Credentials")).not.toBeInTheDocument();
      expect(within(manual).queryByLabelText(/webhook URL/)).not.toBeInTheDocument();
      expect(within(manual).queryByLabelText("Pickup location")).not.toBeInTheDocument();
      expect(within(manual).getByText("Not tested yet.")).toBeInTheDocument();
      expect(badges("Manual").queryByText("Default")).not.toBeInTheDocument();
    });

    it("shows a failed last test with its error, and an unavailable, unconfigured provider", async () => {
      await open([
        providerConfig({ available: false, configured: false, active: false, isDefault: false, lastTestOk: false, lastError: "Bad credentials" }),
      ]);
      const shiprocket = card("Shiprocket");
      for (const badge of ["Not available", "Inactive", "Not configured"]) expect(badges("Shiprocket").getByText(badge)).toBeInTheDocument();
      expect(within(shiprocket).getByText(/— failed: Bad credentials$/)).toBeInTheDocument();
    });
  });

  describe("saving", () => {
    it("checks the PIN code and phone before saving", async () => {
      const { user } = await open();
      const shiprocket = card("Shiprocket");
      await user.clear(within(shiprocket).getByLabelText("PIN code"));
      await user.type(within(shiprocket).getByLabelText("PIN code"), "012345");
      await user.clear(within(shiprocket).getByLabelText("Phone"));
      await user.type(within(shiprocket).getByLabelText("Phone"), "12345");
      await user.click(within(shiprocket).getByRole("button", { name: "Save Shiprocket" }));

      expect(within(shiprocket).getByText("A 6-digit PIN code.")).toBeInTheDocument();
      expect(within(shiprocket).getByText("A 10-digit phone number.")).toBeInTheDocument();
      expect(toasts()).toContain("error:Some fields need a look before saving.");
      expect(api.requests("PUT", /^\/admin\/shipping\/providers/)).toHaveLength(0);
    });

    it("checks a partly-filled default package", async () => {
      const { user } = await open();
      const shiprocket = card("Shiprocket");
      await user.type(within(shiprocket).getByLabelText(/^Length/), "30");
      await user.click(within(shiprocket).getByRole("button", { name: "Save Shiprocket" }));
      expect(within(shiprocket).getByText("Enter the weight in grams.")).toBeInTheDocument();
      expect(api.requests("PUT", /^\/admin\/shipping\/providers/)).toHaveLength(0);
    });

    it("saves the settings, never sending a blank credential, and re-reads the providers", async () => {
      const { user } = await open();
      api.put("/admin/shipping/providers/shiprocket", providerConfig());
      const shiprocket = card("Shiprocket");
      await user.clear(within(shiprocket).getByLabelText("Phone"));
      await user.type(within(shiprocket).getByLabelText("Phone"), "98765 43210");
      await user.click(within(shiprocket).getByRole("switch", { name: /Ask this courier at checkout/ }));
      await user.click(within(shiprocket).getByRole("button", { name: "Save Shiprocket" }));

      await waitFor(() => expect(toasts()).toContain("success:Shiprocket saved."));
      expect(api.last("PUT", "/admin/shipping/providers/shiprocket")!.body).toEqual({
        name: "Shiprocket",
        environment: "production",
        active: true,
        isDefault: true,
        settings: {
          defaultService: "Surface",
          services: ["Surface", "Express"],
          pickupLocation: "Primary",
          origin: { name: "DCZ Warehouse", phone: "9876543210", line1: "12 Mill Road", line2: "", city: "Bengaluru", state: "Karnataka", pincode: "560001" },
          checkoutServiceability: true,
          defaultPackage: null,
        },
      });
      await waitFor(() => expect(api.requests("GET", "/admin/shipping/providers")).toHaveLength(2));
    });

    it("sends only the credentials that were typed, then forgets them", async () => {
      const { user } = await open();
      api.put("/admin/shipping/providers/shiprocket", providerConfig());
      const shiprocket = card("Shiprocket");
      await user.type(within(shiprocket).getByLabelText("API user password"), "s3cret!");
      await user.type(within(shiprocket).getByLabelText("Webhook token"), "   ");
      await user.click(within(shiprocket).getByRole("button", { name: "Save Shiprocket" }));

      await waitFor(() => expect(api.requests("PUT", "/admin/shipping/providers/shiprocket")).toHaveLength(1));
      expect(api.last("PUT", "/admin/shipping/providers/shiprocket")!.body.credentials).toEqual({ password: "s3cret!" });
      await waitFor(() => expect(within(card("Shiprocket")).getByLabelText("API user password")).toHaveValue(""));
    });

    it("sends a complete default package as numbers", async () => {
      const { user } = await open();
      api.put("/admin/shipping/providers/manual", manualProvider());
      const manual = card("Manual");
      await user.type(within(manual).getByLabelText(/^Weight/), "500");
      await user.type(within(manual).getByLabelText(/^Package type/), "envelope");
      await user.click(within(manual).getByRole("button", { name: "Save Manual" }));
      await waitFor(() => expect(api.requests("PUT", "/admin/shipping/providers/manual")).toHaveLength(1));
      const body = api.last("PUT", "/admin/shipping/providers/manual")!.body;
      expect(body.settings.defaultPackage).toEqual({ weightGrams: 500, type: "envelope" });
      expect(body.settings).not.toHaveProperty("pickupLocation");
      expect(body).not.toHaveProperty("credentials");
    });

    it("clears the default service when its service is removed", async () => {
      const { user } = await open();
      const shiprocket = card("Shiprocket");
      await user.click(within(shiprocket).getByRole("button", { name: "Remove Surface" }));
      expect(within(shiprocket).getByLabelText("Default service")).toHaveValue("");
    });

    it("shows the API's message when saving fails", async () => {
      const { user } = await open();
      api.put("/admin/shipping/providers/shiprocket", fail(422, "Pickup location not found in Shiprocket.", "VALIDATION_ERROR"));
      await user.click(within(card("Shiprocket")).getByRole("button", { name: "Save Shiprocket" }));
      await waitFor(() => expect(toasts()).toContain("error:Pickup location not found in Shiprocket."));
    });

    it("switches to the super-admin message on a 403 while saving", async () => {
      const { user } = await open();
      api.put("/admin/shipping/providers/shiprocket", fail(403, "Forbidden", "FORBIDDEN"));
      await user.click(within(card("Shiprocket")).getByRole("button", { name: "Save Shiprocket" }));
      expect(await screen.findByText("Only a super admin can change couriers")).toBeInTheDocument();
    });
  });

  describe("testing the connection and the webhook", () => {
    it.each([
      [{ ok: true, message: "Authenticated." }, "Connection works. Authenticated."],
      [{ ok: false, message: "Wrong password." }, "Connection failed. Wrong password."],
    ])("reports the result %j", async (result, text) => {
      const { user } = await open();
      api.post("/admin/shipping/providers/shiprocket/test", result);
      await user.click(within(card("Shiprocket")).getByRole("button", { name: "Test connection" }));
      expect(await within(card("Shiprocket")).findByText(text)).toBeInTheDocument();
      await waitFor(() => expect(api.requests("GET", "/admin/shipping/providers")).toHaveLength(2));
    });

    it("reports a test that couldn't run as a failure", async () => {
      const { user } = await open();
      api.post("/admin/shipping/providers/shiprocket/test", fail(502, "Shiprocket didn't answer.", "COURIER_UNAVAILABLE"));
      await user.click(within(card("Shiprocket")).getByRole("button", { name: "Test connection" }));
      expect(await within(card("Shiprocket")).findByText("Connection failed. Shiprocket didn't answer.")).toBeInTheDocument();
    });

    it("copies the webhook URL", async () => {
      const { user } = await open();
      await user.click(within(card("Shiprocket")).getByRole("button", { name: "Copy webhook URL" }));
      await waitFor(() => expect(toasts()).toContain("success:Webhook URL copied."));
      expect(await navigator.clipboard.readText()).toBe("https://api.example/api/shipping/webhooks/shiprocket");
    });
  });
});
