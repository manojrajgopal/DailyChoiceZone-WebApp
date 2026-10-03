import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccountSecurity, SignedInSession } from "@/types/identity";

import * as identityService from "@/services/identityService";
import { stopSessionRefresh } from "@/services/sessionRefresh";
import { useSessionStore } from "@/store/sessionStore";
import { api, fail } from "@/test/api";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { apiCustomer, session, toastMessages } from "@/test/sliceD-acct1-fixtures";

import { SecuritySettings } from "./SecuritySettings";

function security(overrides: Partial<AccountSecurity> = {}): AccountSecurity {
  return {
    email: "asha@example.com",
    emailVerified: true,
    phone: "",
    phoneVerified: false,
    contactPhone: "",
    hasPassword: true,
    identities: [],
    providers: [
      { code: "google", label: "Google", linked: false },
      { code: "microsoft", label: "Microsoft", linked: false },
    ],
    mobileOtp: true,
    waysIn: 1,
    ...overrides,
  };
}

const GOOGLE = { id: 7, provider: "google", label: "Google", email: "asha@gmail.com", linkedAt: "2026-01-02T00:00:00Z", lastUsedAt: null };

function device(overrides: Partial<SignedInSession> = {}): SignedInSession {
  return {
    id: "S1",
    current: true,
    method: "password",
    methodLabel: "Email and password",
    device: "Chrome on Windows",
    location: "103.21.x.x",
    createdAt: "2026-09-01T00:00:00Z",
    lastSeenAt: "2026-10-01T00:00:00Z",
    expiresAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

const ISSUED = { challengeId: "c1", channel: "email", destination: "a***@example.com", expiresIn: 300, resendIn: 0, length: 6 };

function setUp(sec: AccountSecurity = security(), sessions: SignedInSession[] = [device()]) {
  signIn();
  useSessionStore.setState({ session: session() });
  api.get("/account/security", sec);
  api.get("/account/sessions", sessions);
  return renderUI(<SecuritySettings />);
}

afterEach(() => stopSessionRefresh());

describe("SecuritySettings", () => {
  it("summarises the ways in and the email's state", async () => {
    setUp(security({ identities: [GOOGLE], waysIn: 2, providers: [{ code: "google", label: "Google", linked: true }] }));
    expect(await screen.findByText(/You can sign in 2 ways/)).toHaveTextContent("Email and password, Google.");
    expect(screen.getByText("asha@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("Verified").length).toBeGreaterThan(0);
  });

  it("offers retry when security can't be loaded", async () => {
    signIn();
    api.get("/account/security", fail(500));
    const { user } = renderUI(<SecuritySettings />);
    expect(await screen.findByText(/load your security settings just now/)).toBeInTheDocument();
    api.get("/account/security", security());
    api.get("/account/sessions", []);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Ways to sign in")).toBeInTheDocument();
  });

  describe("connected accounts", () => {
    it("connects by going straight to the URL the API returns", async () => {
      const assign = vi.spyOn(identityService.fullPage, "assign").mockImplementation(() => undefined);
      api.post("/account/identities/google/link", { url: "http://localhost:8000/api/auth/oauth/google/start?mode=link&ticket=t1" });
      const { user } = setUp();
      await user.click(await screen.findByRole("button", { name: "Connect Google" }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith("http://localhost:8000/api/auth/oauth/google/start?mode=link&ticket=t1"));
      expect(api.last("POST", "/account/identities/google/link")!.body).toEqual({ next: "/account/settings" });
    });

    it("says when a provider can't be connected", async () => {
      const assign = vi.spyOn(identityService.fullPage, "assign").mockImplementation(() => undefined);
      api.post("/account/identities/google/link", fail(422, "That sign-in provider isn't available.", "PROVIDER_UNAVAILABLE"));
      const { user } = setUp();
      await user.click(await screen.findByRole("button", { name: "Connect Google" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("That sign-in provider isn't available.");
      expect(assign).not.toHaveBeenCalled();
    });

    it("disconnects after confirming", async () => {
      api.delete("/account/identities/7", security({ identities: [], waysIn: 1 }));
      const { user } = setUp(security({ identities: [GOOGLE], waysIn: 2, providers: [{ code: "google", label: "Google", linked: true }] }));
      expect(await screen.findByText(/Connected as asha@gmail.com/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Disconnect Google" }));
      const dialog = await screen.findByRole("dialog");
      expect(api.requests("DELETE", "/account/identities/7")).toHaveLength(0);
      await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
      await waitFor(() => expect(api.requests("DELETE", "/account/identities/7")).toHaveLength(1));
      expect(await screen.findByRole("button", { name: "Connect Google" })).toBeInTheDocument();
      expect(await toastMessages()).toContain("success: Google is disconnected");
    });

    it("explains that the last way in can't be removed", async () => {
      api.delete(
        "/account/identities/7",
        fail(409, "This is your only way to sign in. Set a password or connect another account first.", "LAST_SIGN_IN_METHOD"),
      );
      const { user } = setUp(
        security({ hasPassword: false, identities: [GOOGLE], providers: [{ code: "google", label: "Google", linked: true }] }),
      );
      await user.click(await screen.findByRole("button", { name: "Disconnect Google" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This is your only way to sign in. Set a password or connect another account first.",
      );
      expect(screen.getByText(/Connected as asha@gmail.com/)).toBeInTheDocument();
    });
  });

  describe("email", () => {
    it("confirms an unverified email with a code", async () => {
      api.post("/account/email/code", { ...ISSUED, alreadyVerified: false });
      api.post("/account/email/verify-code", apiCustomer({ emailVerified: true }));
      useSessionStore.setState({ session: session({ emailVerified: false }) });
      const { user } = setUp(security({ emailVerified: false }));
      useSessionStore.setState({ session: session({ emailVerified: false }) });
      await user.click(await screen.findByRole("button", { name: "Verify with a code" }));
      await user.type(await screen.findByLabelText(/^One-time code/), "123456");
      await waitFor(() => expect(useSessionStore.getState().session?.user.emailVerified).toBe(true));
      expect(api.last("POST", "/account/email/verify-code")!.body).toEqual({ challengeId: "c1", code: "123456" });
      expect(screen.queryByRole("button", { name: "Verify with a code" })).not.toBeInTheDocument();
    });
  });

  describe("phone", () => {
    it("adds a number through the code dialog", async () => {
      api.post("/account/phone/otp", { ...ISSUED, channel: "sms", destination: "+91 ******3210" });
      api.post("/account/phone/verify", security({ phone: "+919876543210", phoneVerified: true, waysIn: 2 }));
      const { user } = setUp(security({ contactPhone: "9876543210" }));
      await user.click(await screen.findByRole("button", { name: "Add a mobile number" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByLabelText(/^Mobile number/)).toHaveValue("9876543210");
      await user.click(within(dialog).getByRole("button", { name: "Send code" }));
      await user.type(await within(dialog).findByLabelText(/^One-time code/), "123456");
      expect(await screen.findByText("98765 43210")).toBeInTheDocument();
      expect(useSessionStore.getState().session?.user.phoneVerified).toBe(true);
    });

    it("removes the number after confirming", async () => {
      api.delete("/account/phone", security({ phone: "", phoneVerified: false }));
      const { user } = setUp(security({ phone: "+919876543210", phoneVerified: true, waysIn: 2 }));
      await user.click(await screen.findByRole("button", { name: "Remove" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove number" }));
      expect(await screen.findByRole("button", { name: "Add a mobile number" })).toBeInTheDocument();
    });

    it("refuses to remove the last way in, saying why", async () => {
      api.delete("/account/phone", fail(409, "This is your only way to sign in.", "LAST_SIGN_IN_METHOD"));
      const { user } = setUp(security({ hasPassword: false, phone: "+919876543210", phoneVerified: true }));
      await user.click(await screen.findByRole("button", { name: "Remove" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove number" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This is your only way to sign in.");
    });
  });

  describe("password", () => {
    it("sets a first password with an emailed code and stores the new token", async () => {
      api.post("/account/password/otp", ISSUED);
      api.post("/account/password/set", { token: { accessToken: "after-password", tokenType: "bearer", expiresIn: 3600 } });
      const { user } = setUp(security({ hasPassword: false }));
      await user.click(await screen.findByRole("button", { name: "Set a password" }));
      await user.type(await screen.findByLabelText(/^One-time code/), "123456");
      // Not sent on the last digit: the password is still to come.
      expect(api.requests("POST", "/account/password/set")).toHaveLength(0);
      await user.type(screen.getByLabelText(/^New password/), "hunter22");
      api.get("/account/security", security({ hasPassword: true }));
      await user.click(screen.getByRole("button", { name: "Set password" }));
      await waitFor(() => expect(localStorage.getItem("dcz:auth-token")).toBe("after-password"));
      expect(api.last("POST", "/account/password/set")!.body).toEqual({ challengeId: "c1", code: "123456", newPassword: "hunter22" });
    });

    it("changes an existing password and stores the new token", async () => {
      api.put("/account/password", { token: { accessToken: "changed", tokenType: "bearer", expiresIn: 3600 } });
      const { user } = setUp();
      await user.click(await screen.findByRole("button", { name: "Change password" }));
      await user.type(screen.getByLabelText(/^Current password/), "oldpass1");
      await user.type(screen.getByLabelText(/^New password/), "newpass1");
      await user.click(screen.getAllByRole("button", { name: "Change password" }).at(-1)!);
      await waitFor(() => expect(localStorage.getItem("dcz:auth-token")).toBe("changed"));
    });
  });

  describe("signed-in devices", () => {
    const OTHER = device({ id: "S2", current: false, device: "Safari on iPhone", methodLabel: "Google" });

    it("marks this device and signs another out", async () => {
      api.delete("/account/sessions/S2", { signedOut: false });
      const { user } = setUp(security(), [device(), OTHER]);
      expect(await screen.findByText("This device")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Sign out Safari on iPhone" }));
      await waitFor(() => expect(screen.queryByText("Safari on iPhone")).not.toBeInTheDocument());
      expect(localStorage.getItem("dcz:auth-token")).toBe("test-token");
    });

    it("signs this device out locally when it is the one chosen", async () => {
      api.delete("/account/sessions/S1", { signedOut: true });
      const { user } = setUp(security(), [device()]);
      await user.click(await screen.findByRole("button", { name: "Sign out of this device" }));
      await waitFor(() => expect(useSessionStore.getState().session).toBeNull());
      expect(localStorage.getItem("dcz:auth-token")).toBeNull();
    });

    it("signs out every other device and keeps going with the new token", async () => {
      api.post("/account/sessions/revoke-others", { revoked: 1, token: { accessToken: "only-me", tokenType: "bearer", expiresIn: 3600 } });
      const { user } = setUp(security(), [device(), OTHER]);
      await user.click(await screen.findByRole("button", { name: "Sign out of all other devices" }));
      api.get("/account/sessions", [device()]);
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sign out others" }));
      await waitFor(() => expect(localStorage.getItem("dcz:auth-token")).toBe("only-me"));
      await waitFor(() => expect(screen.queryByText("Safari on iPhone")).not.toBeInTheDocument());
      expect(await toastMessages()).toContain("success: Signed out of 1 other device");
    });
  });
});
