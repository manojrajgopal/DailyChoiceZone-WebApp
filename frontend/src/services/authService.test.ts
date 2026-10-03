import { describe, expect, it } from "vitest";

import { api, fail, networkError, raw } from "@/test/api";
import { getToken, setToken } from "@/services/api/client";

import {
  changePassword,
  checkResetToken,
  getCurrentUser,
  register,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signIn,
  signOut,
  updateProfile,
  verifyEmail,
} from "./authService";

const CUSTOMER = {
  id: "C1",
  email: "asha@example.com",
  firstName: "Asha",
  lastName: "Rao",
  name: "Asha Rao",
  phone: "9876543210",
  status: "active",
  joinedAt: "2026-01-01T00:00:00Z",
  emailVerified: true,
};

describe("signIn", () => {
  it("POSTs credentials and stores the returned token", async () => {
    api.post("/auth/login", () => ({
      token: { accessToken: "tok-1", tokenType: "Bearer", expiresIn: 3600 },
      customer: CUSTOMER,
    }));
    const result = await signIn({ email: "asha@example.com", password: "secret" });
    expect(result).toEqual({
      ok: true,
      session: {
        user: {
          id: "C1",
          firstName: "Asha",
          lastName: "Rao",
          email: "asha@example.com",
          phone: "9876543210",
          memberSince: "2026-01-01T00:00:00Z",
          emailVerified: true,
          // Not in the API's answer: a phone is only verified when the server says so.
          phoneVerified: false,
        },
        token: "tok-1",
      },
    });
    expect(getToken()).toBe("tok-1");
    expect(api.last("POST", "/auth/login")!.body).toEqual({ email: "asha@example.com", password: "secret" });
  });

  it("defaults emailVerified to false when the API omits it", async () => {
    api.post("/auth/login", { token: { accessToken: "t", tokenType: "Bearer", expiresIn: 1 }, customer: { ...CUSTOMER, emailVerified: undefined } });
    const result = await signIn({ email: "a@b.com", password: "x" });
    expect(result.ok && result.session.user.emailVerified).toBe(false);
  });

  it("returns the server's message on failure, not a token", async () => {
    api.post("/auth/login", fail(401, "That email and password do not match"));
    const result = await signIn({ email: "a@b.com", password: "wrong" });
    expect(result).toEqual({ ok: false, reason: "That email and password do not match" });
    expect(getToken()).toBeNull();
  });

  it("falls back to a generic message for a non-API error (network failure)", async () => {
    api.post("/auth/login", networkError());
    const result = await signIn({ email: "a@b.com", password: "x" });
    expect(result.ok).toBe(false);
  });
});

describe("register", () => {
  it("POSTs to /auth/register and stores the token on success", async () => {
    api.post("/auth/register", { token: { accessToken: "new-tok", tokenType: "Bearer", expiresIn: 1 }, customer: CUSTOMER });
    const result = await register({ email: "asha@example.com", password: "secret", firstName: "Asha", lastName: "Rao" });
    expect(result.ok).toBe(true);
    expect(getToken()).toBe("new-tok");
  });

  it("surfaces a validation failure", async () => {
    api.post("/auth/register", fail(422, "Email already registered"));
    const result = await register({ email: "x", password: "y", firstName: "A", lastName: "B" });
    expect(result).toEqual({ ok: false, reason: "Email already registered" });
  });
});

describe("signOut", () => {
  it("POSTs to /auth/logout with the customer token, then clears it", async () => {
    api.post("/auth/logout", {});
    setToken("cust", "customer");
    await signOut();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
    expect(getToken()).toBeNull();
  });

  it("still clears the token even when the logout call fails", async () => {
    api.post("/auth/logout", fail(500));
    setToken("cust", "customer");
    await expect(signOut()).resolves.toBeUndefined();
    expect(getToken()).toBeNull();
  });
});

describe("getCurrentUser", () => {
  it("GETs /auth/me with the customer token and maps the user", async () => {
    api.get("/auth/me", CUSTOMER);
    const user = await getCurrentUser();
    expect(user).toMatchObject({ id: "C1", email: "asha@example.com" });
  });

  it("is null, and clears the token, on a 401", async () => {
    setToken("expired", "customer");
    api.get("/auth/me", fail(401));
    const user = await getCurrentUser();
    expect(user).toBeNull();
    expect(getToken()).toBeNull();
  });

  it("is null, and clears the token, on a 403", async () => {
    setToken("expired", "customer");
    api.get("/auth/me", fail(403));
    expect(await getCurrentUser()).toBeNull();
    expect(getToken()).toBeNull();
  });

  it("is null without clearing the token for an unrelated failure", async () => {
    setToken("still-valid", "customer");
    api.get("/auth/me", fail(500));
    expect(await getCurrentUser()).toBeNull();
    expect(getToken()).toBe("still-valid");
  });
});

describe("updateProfile", () => {
  it("PUTs only firstName/lastName/phone and maps the response", async () => {
    api.put("/account/profile", (req) => ({ ...CUSTOMER, ...(req.body as object) }));
    const user = await updateProfile({ firstName: "New", lastName: "Name", phone: "111" });
    expect(user?.firstName).toBe("New");
    expect(api.last("PUT")!.body).toEqual({ firstName: "New", lastName: "Name", phone: "111" });
  });

  it("is null when the update fails", async () => {
    api.put("/account/profile", fail(400));
    expect(await updateProfile({ firstName: "x" })).toBeNull();
  });
});

describe("changePassword", () => {
  it("succeeds with the two passwords sent", async () => {
    api.put("/account/password", {});
    const result = await changePassword("old", "new");
    expect(result).toEqual({ ok: true });
    expect(api.last()!.body).toEqual({ currentPassword: "old", newPassword: "new" });
  });

  it("surfaces the server's reason on failure", async () => {
    api.put("/account/password", fail(400, "Current password is wrong"));
    expect(await changePassword("wrong", "new")).toEqual({ ok: false, reason: "Current password is wrong" });
  });

  it("falls back to a generic reason for a non-API error", async () => {
    api.put("/account/password", networkError());
    const result = await changePassword("a", "b");
    expect(result.ok).toBe(false);
  });
});

describe("account recovery", () => {
  it("requestPasswordReset always reports the same generic success message", async () => {
    api.post("/auth/password/forgot", {});
    const result = await requestPasswordReset("a@b.com");
    expect(result).toEqual({ ok: true, message: expect.stringContaining("If an account exists") });
    expect(api.last()!.body).toEqual({ email: "a@b.com" });
  });

  it("requestPasswordReset surfaces a network failure as an ApiError (connectivity message, NETWORK_ERROR code)", async () => {
    api.post("/auth/password/forgot", networkError());
    expect(await requestPasswordReset("a@b.com")).toEqual({
      ok: false,
      reason: "We couldn't connect just now. Please check your internet connection and try again.",
      code: "NETWORK_ERROR",
    });
  });

  it("checkResetToken falls back to the given fallback for a non-API error (Next's own control-flow signal)", async () => {
    const signal = Object.assign(new Error("DYNAMIC_SERVER_USAGE"), { digest: "DYNAMIC_SERVER_USAGE" });
    api.post("/auth/password/reset/check", networkError(signal));
    expect(await checkResetToken("tok")).toEqual({ ok: false, reason: "We couldn't check this link." });
  });

  it("checkResetToken succeeds silently", async () => {
    api.post("/auth/password/reset/check", {});
    expect(await checkResetToken("tok")).toEqual({ ok: true, message: "" });
  });

  it("checkResetToken surfaces an expired/invalid token with its code", async () => {
    api.post("/auth/password/reset/check", fail(400, "This link has expired", "TOKEN_EXPIRED"));
    expect(await checkResetToken("tok")).toEqual({ ok: false, reason: "This link has expired", code: "TOKEN_EXPIRED" });
  });

  it("resetPassword sends the token and both passwords", async () => {
    api.post("/auth/password/reset", {});
    const result = await resetPassword("tok", "new", "new");
    expect(result.ok).toBe(true);
    expect(api.last()!.body).toEqual({ token: "tok", password: "new", confirmPassword: "new" });
  });

  it("verifyEmail succeeds with the confirmation message", async () => {
    api.post("/auth/email/verify", {});
    expect(await verifyEmail("tok")).toEqual({ ok: true, message: "Your email address is confirmed." });
  });

  it("verifyEmail surfaces a failure reason", async () => {
    api.post("/auth/email/verify", fail(400, "Invalid or expired token"));
    expect(await verifyEmail("tok")).toEqual({ ok: false, reason: "Invalid or expired token", code: "REQUEST_FAILED" });
  });
});

describe("resendVerification", () => {
  it("reports a fresh link when not already verified", async () => {
    api.post("/account/email/verification", { alreadyVerified: false });
    const result = await resendVerification();
    expect(result).toMatchObject({ ok: true, alreadyVerified: false, message: expect.stringContaining("check your inbox") });
  });

  it("reports already-verified distinctly", async () => {
    api.post("/account/email/verification", { alreadyVerified: true });
    const result = await resendVerification();
    expect(result).toMatchObject({ ok: true, alreadyVerified: true, message: "Your email address is already confirmed." });
  });

  it("surfaces a failure", async () => {
    api.post("/account/email/verification", fail(429, "Please wait before trying again", "RATE_LIMITED"));
    expect(await resendVerification()).toEqual({ ok: false, reason: "Please wait before trying again", code: "RATE_LIMITED" });
  });

  it("falls back to a generic reason for malformed responses", async () => {
    api.post("/account/email/verification", raw(500, "<html>"));
    const result = await resendVerification();
    expect(result.ok).toBe(false);
  });

  it("falls back to the generic reason for a non-API error (Next's own control-flow signal)", async () => {
    const signal = Object.assign(new Error("DYNAMIC_SERVER_USAGE"), { digest: "DYNAMIC_SERVER_USAGE" });
    api.post("/account/email/verification", networkError(signal));
    expect(await resendVerification()).toEqual({ ok: false, reason: "We couldn't send the link just now." });
  });
});
