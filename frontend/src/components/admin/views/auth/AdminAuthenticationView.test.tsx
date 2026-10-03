import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, signIn, waitFor } from "@/test/render";
import { useToastStore } from "@/store/toastStore";
import type { AuthMethodsView } from "@/services/admin/authMethodsAdminService";

import { AdminAuthenticationView } from "./AdminAuthenticationView";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

function view(patch: Partial<AuthMethodsView> = {}): AuthMethodsView {
  return {
    methods: [
      { key: "emailPassword", label: "Email and password", enabled: true, configured: true, reason: "", social: false },
      { key: "emailOtp", label: "Email me a code", enabled: true, configured: true, reason: "", social: false },
      { key: "mobileOtp", label: "Mobile number (one-time code)", enabled: true, configured: false,
        reason: "No SMS provider is set up.", social: false },
      { key: "google", label: "Google", enabled: true, configured: true, reason: "", social: true,
        redirectUri: "http://localhost:8000/api/auth/oauth/google/callback" },
      { key: "apple", label: "Apple", enabled: false, configured: false, reason: "APPLE_CLIENT_ID is not set.",
        social: true, redirectUri: "http://localhost:8000/api/auth/oauth/apple/callback" },
      { key: "microsoft", label: "Microsoft", enabled: true, configured: false, reason: "", social: true },
    ],
    signupVerification: "link",
    summary: { signInsToday: 12, signInsByMethod: { google: 4 }, otpSentToday: 9, otpVerifiedToday: 7,
      otpSendFailuresToday: 1, oauthFailuresToday: 0 },
    ...patch,
  };
}

describe("AdminAuthenticationView", () => {
  it("shows each method's state, why one isn't set up, and the redirect URI to register", async () => {
    signIn("admin", "adm");
    api.get("/admin/auth/methods", view());
    renderUI(<AdminAuthenticationView />);
    expect(await screen.findByText("No SMS provider is set up.")).toBeInTheDocument();
    expect(screen.getByText("APPLE_CLIENT_ID is not set.")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:8000/api/auth/oauth/google/callback")).toBeInTheDocument();
    expect(screen.getByText("4 sign-in(s) today")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(api.last("GET", "/admin/auth/methods")!.headers.authorization).toBe("Bearer adm");
    expect(screen.getByRole("button", { name: "Save sign-in methods" })).toBeDisabled();
  });

  it("saves the switches and the sign-up confirmation choice", async () => {
    api.get("/admin/auth/methods", view());
    api.put("/admin/auth/methods", { methods: view().methods, signupVerification: "code" });
    const { user } = renderUI(<AdminAuthenticationView />);
    await user.click(await screen.findByRole("switch", { name: /Email me a code/ }));
    await user.selectOptions(screen.getByLabelText(/confirm their email with/), "code");
    await user.click(screen.getByRole("button", { name: "Save sign-in methods" }));
    await waitFor(() => expect(api.last("PUT", "/admin/auth/methods")?.body).toEqual({
      emailPassword: true, emailOtp: false, mobileOtp: true, google: true, apple: false, microsoft: true,
      signupVerification: "code",
    }));
    await waitFor(() => expect(toasts()).toContain("success:Sign-in methods saved."));
  });

  it("shows the server's refusal when nobody could sign in", async () => {
    api.get("/admin/auth/methods", view());
    api.put("/admin/auth/methods", fail(422, "Keep at least one sign-in method on that works, or nobody can sign in.",
      "NO_SIGN_IN_METHOD"));
    const { user } = renderUI(<AdminAuthenticationView />);
    await user.click(await screen.findByRole("switch", { name: /Email and password/ }));
    await user.click(screen.getByRole("button", { name: "Save sign-in methods" }));
    await waitFor(() => expect(toasts()).toContain(
      "error:Keep at least one sign-in method on that works, or nobody can sign in."));
  });

  it("explains a missing permission", async () => {
    api.get("/admin/auth/methods", fail(403, "Forbidden", "FORBIDDEN"));
    renderUI(<AdminAuthenticationView />);
    expect(await screen.findByText("Your role doesn’t include sign-in settings")).toBeInTheDocument();
  });
});
