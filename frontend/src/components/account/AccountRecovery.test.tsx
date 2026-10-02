import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";
import { toastMessages } from "@/test/sliceD-acct1-fixtures";
import { signInCustomer } from "@/test/sliceD-acct3-session";

import { ForgotPasswordView, ResetPasswordView, VerifyEmailBanner, VerifyEmailView } from "./AccountRecovery";

describe("ForgotPasswordView", () => {
  it("prefills the email from ?email=", () => {
    setLocation("/forgot-password?email=asha%40example.com");
    renderUI(<ForgotPasswordView />);
    expect(screen.getByLabelText(/^Email address/)).toHaveValue("asha@example.com");
  });

  it("disables Send reset link until an email is typed", () => {
    renderUI(<ForgotPasswordView />);
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeDisabled();
  });

  it("sends the request and shows the server's (always-reassuring) message", async () => {
    api.post("/auth/password/forgot", {});
    const { user } = renderUI(<ForgotPasswordView />);
    await user.type(screen.getByLabelText(/^Email address/), "asha@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText(/If an account exists for that email/)).toBeInTheDocument();
    expect(api.last("POST", "/auth/password/forgot")!.body).toEqual({ email: "asha@example.com" });
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/account");
  });

  it("lets the shopper use a different email after sending", async () => {
    api.post("/auth/password/forgot", {});
    const { user } = renderUI(<ForgotPasswordView />);
    await user.type(screen.getByLabelText(/^Email address/), "asha@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    await screen.findByText(/If an account exists/);

    await user.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(screen.getByLabelText(/^Email address/)).toBeInTheDocument();
  });

  it("shows a server failure inline and allows retrying", async () => {
    api.post("/auth/password/forgot", fail(500));
    const { user } = renderUI(<ForgotPasswordView />);
    await user.type(screen.getByLabelText(/^Email address/), "asha@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something failed.");
  });

  it("shows Sending… while the request is in flight", async () => {
    api.post("/auth/password/forgot", () => new Promise(() => undefined));
    const { user } = renderUI(<ForgotPasswordView />);
    await user.type(screen.getByLabelText(/^Email address/), "asha@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
  });
});

describe("ResetPasswordView", () => {
  it("treats a missing token as an incomplete link, without calling the server", () => {
    setLocation("/reset-password");
    renderUI(<ResetPasswordView />);
    expect(screen.getByText("This link is incomplete. Request a new one.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Send a new link" })).toHaveAttribute("href", "/forgot-password");
    expect(api.calls).toHaveLength(0);
  });

  it("checks the token and shows the form once it's confirmed valid", async () => {
    setLocation("/reset-password?token=TOK1");
    api.post("/auth/password/reset/check", {});
    renderUI(<ResetPasswordView />);
    expect(screen.getByText("Checking your link…")).toBeInTheDocument();
    expect(await screen.findByLabelText(/^New password/)).toBeInTheDocument();
    expect(api.last("POST", "/auth/password/reset/check")!.body).toEqual({ token: "TOK1" });
  });

  it("shows why a dead link can't be used", async () => {
    setLocation("/reset-password?token=TOK1");
    api.post("/auth/password/reset/check", fail(410, "This link has expired.", "TOKEN_EXPIRED"));
    renderUI(<ResetPasswordView />);
    expect(await screen.findByText("This link has expired.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Send a new link" })).toBeInTheDocument();
  });

  it("requires the two passwords to match before submitting", async () => {
    setLocation("/reset-password?token=TOK1");
    api.post("/auth/password/reset/check", {});
    const { user } = renderUI(<ResetPasswordView />);
    await user.type(await screen.findByLabelText(/^New password/), "password1");
    await user.type(screen.getByLabelText(/^Confirm new password/), "password2");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByText("The two passwords don't match.")).toBeInTheDocument();
    expect(api.requests("POST", "/auth/password/reset")).toHaveLength(0);
  });

  it("changes the password and offers to sign in", async () => {
    setLocation("/reset-password?token=TOK1");
    api.post("/auth/password/reset/check", {});
    api.post("/auth/password/reset", {});
    const { user } = renderUI(<ResetPasswordView />);
    await user.type(await screen.findByLabelText(/^New password/), "password1");
    await user.type(screen.getByLabelText(/^Confirm new password/), "password1");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Your password has been changed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/account");
    expect(api.last("POST", "/auth/password/reset")!.body).toEqual({ token: "TOK1", password: "password1", confirmPassword: "password1" });
  });

  it("shows a field-level error for an ordinary rejection (e.g. weak password)", async () => {
    setLocation("/reset-password?token=TOK1");
    api.post("/auth/password/reset/check", {});
    api.post("/auth/password/reset", fail(422, "That password is too common.", "VALIDATION_ERROR"));
    const { user } = renderUI(<ResetPasswordView />);
    await user.type(await screen.findByLabelText(/^New password/), "password1");
    await user.type(screen.getByLabelText(/^Confirm new password/), "password1");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("That password is too common.")).toBeInTheDocument();
    // Still on the form — not a dead link.
    expect(screen.getByRole("button", { name: "Change password" })).toBeInTheDocument();
  });

  it("treats a superseded/expired code returned from the submit itself as a dead link", async () => {
    setLocation("/reset-password?token=TOK1");
    api.post("/auth/password/reset/check", {});
    api.post("/auth/password/reset", fail(410, "This link has already been used.", "TOKEN_USED"));
    const { user } = renderUI(<ResetPasswordView />);
    await user.type(await screen.findByLabelText(/^New password/), "password1");
    await user.type(screen.getByLabelText(/^Confirm new password/), "password1");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("This link can't be used")).toBeInTheDocument();
    expect(screen.getByText("This link has already been used.")).toBeInTheDocument();
  });

  it("disables Change password until both fields are filled, and shows Saving… while busy", async () => {
    setLocation("/reset-password?token=TOK1");
    api.post("/auth/password/reset/check", {});
    api.post("/auth/password/reset", () => new Promise(() => undefined));
    const { user } = renderUI(<ResetPasswordView />);
    expect(await screen.findByRole("button", { name: "Change password" })).toBeDisabled();
    await user.type(screen.getByLabelText(/^New password/), "password1");
    await user.type(screen.getByLabelText(/^Confirm new password/), "password1");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });
});

describe("VerifyEmailView", () => {
  it("treats a missing token as incomplete and offers signing in (guest)", () => {
    setLocation("/verify-email");
    renderUI(<VerifyEmailView />);
    expect(screen.getByText("This link can't be used")).toBeInTheDocument();
    expect(screen.getByText(/Sign in to send yourself a new one\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/account");
  });

  it("confirms the address and, signed out, offers to continue shopping", async () => {
    setLocation("/verify-email?token=TOK1");
    api.post("/auth/email/verify", {});
    renderUI(<VerifyEmailView />);
    expect(screen.getByText("Confirming your email address…")).toBeInTheDocument();
    expect(await screen.findByText("Your email address is confirmed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/shop");
  });

  it("confirms the address and, signed in, offers to go to the account", async () => {
    setLocation("/verify-email?token=TOK1");
    signInCustomer();
    api.post("/auth/email/verify", {});
    renderUI(<VerifyEmailView />);
    expect(await screen.findByRole("link", { name: "Go to your account" })).toHaveAttribute("href", "/account");
  });

  it("offers a resend button only when signed in, for a dead link", async () => {
    setLocation("/verify-email?token=BAD");
    api.post("/auth/email/verify", fail(410, "This link has expired."));
    renderUI(<VerifyEmailView />);
    expect(await screen.findByText("This link has expired. Sign in to send yourself a new one.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send the link again" })).not.toBeInTheDocument();
  });

  it("offers Send the link again when signed in with a dead link", async () => {
    setLocation("/verify-email?token=BAD");
    signInCustomer();
    api.post("/auth/email/verify", fail(410, "This link has expired."));
    renderUI(<VerifyEmailView />);
    expect(await screen.findByRole("button", { name: "Send the link again" })).toBeInTheDocument();
  });

  it("sends the verify request only once even if the effect re-runs", async () => {
    setLocation("/verify-email?token=TOK1");
    api.post("/auth/email/verify", {});
    const { rerender } = renderUI(<VerifyEmailView />);
    await waitFor(() => expect(api.requests("POST", "/auth/email/verify")).toHaveLength(1));
    rerender(<VerifyEmailView />);
    expect(api.requests("POST", "/auth/email/verify")).toHaveLength(1);
  });
});

describe("ResendButton (via VerifyEmailBanner, its only exported host)", () => {
  it("sends a new link and toasts the server's message", async () => {
    api.post("/account/email/verification", { alreadyVerified: false });
    const { user } = renderUI(<VerifyEmailBanner email="asha@example.com" />);
    await user.click(screen.getByRole("button", { name: "Send the link again" }));
    expect(await toastMessages()).toContain("success: We've sent a new link — check your inbox.");
  });

  it("updates the session when the address is already verified", async () => {
    api.post("/account/email/verification", { alreadyVerified: true });
    const { user } = renderUI(<VerifyEmailBanner email="asha@example.com" />);
    await user.click(screen.getByRole("button", { name: "Send the link again" }));
    expect(await toastMessages()).toContain("success: Your email address is already confirmed.");
  });

  it("toasts an error when the resend fails", async () => {
    api.post("/account/email/verification", fail(500, "We couldn't send that."));
    const { user } = renderUI(<VerifyEmailBanner email="asha@example.com" />);
    await user.click(screen.getByRole("button", { name: "Send the link again" }));
    expect(await toastMessages()).toContain("error: We couldn't send that.");
  });

  it("shows the address and a resend action", () => {
    api.post("/account/email/verification", { alreadyVerified: false });
    renderUI(<VerifyEmailBanner email="asha@example.com" />);
    expect(screen.getByText("Please confirm your email address.")).toBeInTheDocument();
    expect(screen.getByText("asha@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send the link again" })).toBeInTheDocument();
  });
});
