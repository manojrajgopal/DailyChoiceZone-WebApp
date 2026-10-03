import { afterEach, describe, expect, it, vi } from "vitest";

import { api, fail } from "@/test/api";
import { signIn } from "@/test/render";
import { apiCustomer, authPayload } from "@/test/sliceD-acct1-fixtures";

import { getToken, onCustomerSessionEnded } from "./api/client";
import {
  completeOAuth,
  getSignInMethods,
  oauthStartUrl,
  requestEmailCode,
  requestSignInCode,
  revokeOtherSessions,
  revokeSession,
  setPasswordWithCode,
  signUpWithCode,
  startLinking,
  unlinkIdentity,
  verifyEmailCode,
  verifySignInCode,
} from "./identityService";
import { stopSessionRefresh } from "./sessionRefresh";

const ISSUED = { challengeId: "ch1", channel: "sms", destination: "+91 ******3210", expiresIn: 300, resendIn: 45, length: 6 };
const TOKEN = { accessToken: "fresh-token", tokenType: "bearer", expiresIn: 3600 };

afterEach(() => stopSessionRefresh());

describe("getSignInMethods", () => {
  it("returns what the API offers", async () => {
    api.get("/auth/methods", {
      emailPassword: false,
      emailOtp: true,
      mobileOtp: true,
      providers: [{ code: "google", label: "Google" }],
      signupVerification: "code",
    });
    expect(await getSignInMethods()).toEqual({
      emailPassword: false,
      emailOtp: true,
      mobileOtp: true,
      providers: [{ code: "google", label: "Google" }],
      signupVerification: "code",
    });
  });

  it("falls back to the password form alone when the API can't be asked", async () => {
    api.get("/auth/methods", fail(500));
    expect(await getSignInMethods()).toEqual({
      emailPassword: true,
      emailOtp: false,
      mobileOtp: false,
      providers: [],
      signupVerification: "link",
    });
  });
});

describe("oauthStartUrl", () => {
  it("points at the API's start endpoint with next and mode", () => {
    expect(oauthStartUrl("google", "/checkout/payment")).toBe(
      "http://localhost:8000/api/auth/oauth/google/start?next=%2Fcheckout%2Fpayment&mode=login",
    );
  });
});

describe("code sign-in", () => {
  it("requests a code with channel, destination and purpose", async () => {
    api.post("/auth/otp/request", ISSUED);
    expect(await requestSignInCode("sms", "9876543210", "signup")).toEqual(ISSUED);
    expect(api.last("POST", "/auth/otp/request")!.body).toEqual({ channel: "sms", destination: "9876543210", purpose: "signup" });
  });

  it("signs in and stores the token when the code belongs to an account", async () => {
    api.post("/auth/otp/verify", { status: "signed-in", ...authPayload({ firstName: "Asha" }, "otp-token") });
    const result = await verifySignInCode("ch1", "123456");
    expect(result.status).toBe("signed-in");
    expect(result.status === "signed-in" && result.session.user.firstName).toBe("Asha");
    expect(getToken()).toBe("otp-token");
    expect(api.last("POST", "/auth/otp/verify")!.body).toEqual({ challengeId: "ch1", code: "123456" });
  });

  it("hands back a sign-up token, storing nothing, when there is no account yet", async () => {
    api.post("/auth/otp/verify", { status: "signup-required", signupToken: "su-token-123", channel: "sms", destination: "+91 ******3210" });
    expect(await verifySignInCode("ch1", "123456")).toEqual({
      status: "signup-required",
      signupToken: "su-token-123",
      channel: "sms",
      destination: "+91 ******3210",
    });
    expect(getToken()).toBeNull();
  });

  it("creates the account with the sign-up token and stores the token", async () => {
    api.post("/auth/otp/signup", authPayload({ firstName: "Ravi" }, "signup-token"));
    const session = await signUpWithCode({ signupToken: "su", firstName: "Ravi", email: "ravi@example.com" });
    expect(session.user.firstName).toBe("Ravi");
    expect(getToken()).toBe("signup-token");
  });
});

describe("completeOAuth", () => {
  it("exchanges the code, stores the token and says whether the account is new", async () => {
    api.post("/auth/oauth/complete", { ...authPayload({}, "oauth-token"), created: true });
    const result = await completeOAuth("handoff");
    expect(result.created).toBe(true);
    expect(getToken()).toBe("oauth-token");
    expect(api.last("POST", "/auth/oauth/complete")!.body).toEqual({ code: "handoff" });
  });
});

describe("signed-in endpoints", () => {
  it("starts linking with the customer's token and returns the URL", async () => {
    signIn();
    api.post("/account/identities/google/link", { url: "http://api/start?ticket=t" });
    expect(await startLinking("google")).toBe("http://api/start?ticket=t");
    const request = api.last("POST", "/account/identities/google/link")!;
    expect(request.headers.authorization).toBe("Bearer test-token");
    expect(request.body).toEqual({ next: "/account/settings" });
  });

  it("unlinks by id", async () => {
    signIn();
    api.delete("/account/identities/7", { waysIn: 1 });
    expect(await unlinkIdentity(7)).toEqual({ waysIn: 1 });
  });

  it("reads an already-confirmed email from the code request", async () => {
    signIn();
    api.post("/account/email/code", { alreadyVerified: true });
    expect(await requestEmailCode()).toEqual({ alreadyVerified: true });
  });

  it("maps the customer the email code check returns", async () => {
    signIn();
    api.post("/account/email/verify-code", apiCustomer({ emailVerified: true }));
    expect((await verifyEmailCode("ch1", "123456")).emailVerified).toBe(true);
  });

  it("stores the token a first password comes back with", async () => {
    signIn();
    api.post("/account/password/set", { token: TOKEN });
    await setPasswordWithCode("ch1", "123456", "hunter22");
    expect(getToken()).toBe("fresh-token");
    expect(api.last("POST", "/account/password/set")!.body).toEqual({ challengeId: "ch1", code: "123456", newPassword: "hunter22" });
  });

  it("stores the token after signing out every other device", async () => {
    signIn();
    api.post("/account/sessions/revoke-others", { revoked: 3, token: TOKEN });
    expect(await revokeOtherSessions()).toBe(3);
    expect(getToken()).toBe("fresh-token");
  });

  it("keeps the token when another device is signed out", async () => {
    signIn();
    api.delete("/account/sessions/S2", { signedOut: false });
    expect(await revokeSession("S2")).toEqual({ signedOut: false });
    expect(getToken()).toBe("test-token");
  });

  it("forgets the token and announces it when this device is signed out", async () => {
    signIn();
    const ended = vi.fn();
    const unsubscribe = onCustomerSessionEnded(ended);
    api.delete("/account/sessions/S1", { signedOut: true });
    expect(await revokeSession("S1")).toEqual({ signedOut: true });
    expect(getToken()).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
