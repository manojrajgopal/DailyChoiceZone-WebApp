import { afterEach, describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { signIn as storeToken } from "@/test/render";
import { authPayload } from "@/test/sliceD-acct1-fixtures";

import { getToken } from "./api/client";
import { changePassword, register, signIn } from "./authService";
import { stopSessionRefresh } from "./sessionRefresh";

const ISSUED = { challengeId: "ch1", channel: "email", destination: "a***@example.com", expiresIn: 300, resendIn: 45, length: 6 };

afterEach(() => stopSessionRefresh());

describe("authService and the new sign-in methods", () => {
  it("maps phoneVerified from the customer", async () => {
    api.post("/auth/login", { ...authPayload(), customer: { ...authPayload().customer, phoneVerified: true } });
    const result = await signIn({ email: "a@b.com", password: "x" });
    expect(result.ok && result.session.user.phoneVerified).toBe(true);
  });

  it("passes on the codes a registration sent, and the phone it was given", async () => {
    api.post("/auth/register", { ...authPayload(), verification: ISSUED, phoneVerification: null });
    const result = await register({ email: "a@b.com", password: "hunter22", firstName: "A", lastName: "", phone: "9876543210" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.verification).toEqual(ISSUED);
    expect(result.ok && result.phoneVerification).toBeNull();
    expect(api.last("POST", "/auth/register")!.body.phone).toBe("9876543210");
    expect(getToken()).toBe("new-token");
  });

  it("leaves verification out when the store confirms by link", async () => {
    api.post("/auth/register", authPayload());
    const result = await register({ email: "a@b.com", password: "hunter22", firstName: "A", lastName: "" });
    expect(result.ok && "verification" in result).toBe(false);
  });

  it("reports AUTH_METHOD_DISABLED with its code", async () => {
    api.post("/auth/login", fail(403, "Signing in with a password isn't available.", "AUTH_METHOD_DISABLED"));
    expect(await signIn({ email: "a@b.com", password: "x" })).toEqual({
      ok: false,
      reason: "Signing in with a password isn't available.",
      code: "AUTH_METHOD_DISABLED",
    });
  });

  it("stores the token a password change comes back with", async () => {
    storeToken("customer", "before");
    api.put("/account/password", { token: { accessToken: "after", tokenType: "bearer", expiresIn: 3600 } });
    expect(await changePassword("old-pass1", "new-pass1")).toEqual({ ok: true });
    expect(getToken()).toBe("after");
  });

  it("says PASSWORD_NOT_SET with its code", async () => {
    storeToken();
    api.put("/account/password", fail(409, "You don't have a password yet.", "PASSWORD_NOT_SET"));
    expect(await changePassword("x", "new-pass1")).toEqual({ ok: false, reason: "You don't have a password yet.", code: "PASSWORD_NOT_SET" });
  });
});
