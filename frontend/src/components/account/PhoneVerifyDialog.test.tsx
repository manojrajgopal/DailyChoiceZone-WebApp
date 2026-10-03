import { afterEach, describe, expect, it, vi } from "vitest";

import { stopSessionRefresh } from "@/services/sessionRefresh";
import { useSessionStore } from "@/store/sessionStore";
import { api, fail } from "@/test/api";
import { renderUI, screen, signIn, waitFor } from "@/test/render";
import { session, siteContent } from "@/test/sliceD-acct1-fixtures";

import { PhoneVerifyDialog } from "./PhoneVerifyDialog";

const ISSUED = { challengeId: "ph1", channel: "sms", destination: "+91 ******3210", expiresIn: 300, resendIn: 0, length: 6 };
const SECURITY = { phone: "+919876543210", phoneVerified: true };

afterEach(() => stopSessionRefresh());

describe("PhoneVerifyDialog", () => {
  it("texts a code to the number and hands back what the server confirmed", async () => {
    signIn();
    api.post("/account/phone/otp", ISSUED);
    api.post("/account/phone/verify", SECURITY);
    const onVerified = vi.fn();
    const { user } = renderUI(<PhoneVerifyDialog open onOpenChange={vi.fn()} initialPhone="+919876543210" onVerified={onVerified} />);

    expect(screen.getByLabelText(/^Mobile number/)).toHaveValue("9876543210");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(api.last("POST", "/account/phone/otp")!.body).toEqual({ phone: "9876543210" });

    await user.type(await screen.findByLabelText(/^One-time code/), "123456");
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(SECURITY));
    expect(api.last("POST", "/account/phone/verify")!.body).toEqual({ challengeId: "ph1", code: "123456" });
  });

  it("checks the number before sending anything", async () => {
    const { user } = renderUI(<PhoneVerifyDialog open onOpenChange={vi.fn()} onVerified={vi.fn()} />);
    await user.type(screen.getByLabelText(/^Mobile number/), "12345");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a 10-digit mobile number.");
    expect(api.requests("POST", "/account/phone/otp")).toHaveLength(0);
  });

  it("says when the number belongs to another account, and does not confirm it", async () => {
    signIn();
    api.post("/account/phone/otp", ISSUED);
    api.post("/account/phone/verify", fail(409, "That mobile number is already used by another account.", "PHONE_IN_USE"));
    const onVerified = vi.fn();
    const { user } = renderUI(<PhoneVerifyDialog open onOpenChange={vi.fn()} initialPhone="9876543210" onVerified={onVerified} />);
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText(/^One-time code/), "123456");
    expect(await screen.findByRole("alert")).toHaveTextContent("That mobile number is already used by another account.");
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use a different number" })).toBeInTheDocument();
  });
});

describe("ProfileView phone", () => {
  async function renderProfile(user: Parameters<typeof session>[0]) {
    signIn();
    useSessionStore.setState({ session: session(user) });
    // Orders, addresses and the rest answer empty. First, because later registrations win.
    api.get(/.*/, []);
    api.get("/auth/me", { id: "C1", email: "asha@example.com", firstName: "Asha", lastName: "Rao", name: "Asha Rao", phone: user?.phone ?? "", status: "active", joinedAt: "2025-01-15", emailVerified: true, phoneVerified: user?.phoneVerified ?? false });
    api.get("/site/content", siteContent());
    const { ProfileView } = await import("./ProfileView");
    return renderUI(<ProfileView />);
  }

  it("shows a server-confirmed number as Verified, in ten digits", async () => {
    await renderProfile({ phone: "+919876543210", phoneVerified: true });
    expect(await screen.findByText("Verified")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Mobile number/)).toHaveValue("9876543210");
    expect(screen.getByRole("button", { name: "Change number" })).toBeInTheDocument();
  });

  it("stops calling a number Verified as soon as it is edited", async () => {
    const { user } = await renderProfile({ phone: "9876543210", phoneVerified: true });
    const box = await screen.findByLabelText(/^Mobile number/);
    await user.clear(box);
    await user.type(box, "9876500000");
    expect(screen.getByText("Not verified")).toBeInTheDocument();
  });

  it("verifies through the dialog and takes the server's word for it", async () => {
    api.post("/account/phone/otp", ISSUED);
    api.post("/account/phone/verify", SECURITY);
    const { user } = await renderProfile({ phone: "9876543210", phoneVerified: false });
    expect(await screen.findByText("Not verified")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verify phone" }));
    await user.click(await screen.findByRole("button", { name: "Send code" }));
    await user.type(await screen.findByLabelText(/^One-time code/), "123456");
    await waitFor(() => expect(useSessionStore.getState().session?.user.phoneVerified).toBe(true));
    expect(await screen.findByText("Verified")).toBeInTheDocument();
  });
});
