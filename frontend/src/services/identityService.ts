import type { AuthSession, User } from "@/types";
import type {
  AccountSecurity,
  ApiToken,
  IssuedOtp,
  OtpChannel,
  SignedInSession,
  SignInMethods,
} from "@/types/identity";

import { acceptAuthPayload, toUser, type ApiAuthPayload, type ApiCustomer } from "@/services/authService";
import { ApiError, apiDelete, apiGet, apiPost, apiUrl, endCustomerSession, query } from "@/services/api/client";
import { storeCustomerToken } from "@/services/sessionRefresh";

/**
 * Signing in without a password, and the account's Security settings.
 *
 * Thin on purpose: every call is the endpoint as the API describes it, and
 * every failure is the `ApiError` it sent — the components branch on its
 * `code` (OTP_INCORRECT, LAST_SIGN_IN_METHOD, …). The only thing done here
 * beyond the request is storing a token the API hands back, through the one
 * token store.
 *
 * A code the shopper types is sent once and kept nowhere.
 */

const AUTH = { auth: "customer" as const };

/** What the sign-in page offers when the API can't be asked: the password form only. */
export const FALLBACK_METHODS: SignInMethods = {
  emailPassword: true,
  emailOtp: false,
  mobileOtp: false,
  providers: [],
  signupVerification: "link",
};

/* ------------------------------------------------------------- public */

export async function getSignInMethods(): Promise<SignInMethods> {
  try {
    const methods = await apiGet<Partial<SignInMethods> | null>("/auth/methods");
    if (!methods) return FALLBACK_METHODS;
    return {
      emailPassword: methods.emailPassword ?? true,
      emailOtp: methods.emailOtp ?? false,
      mobileOtp: methods.mobileOtp ?? false,
      providers: Array.isArray(methods.providers) ? methods.providers : [],
      signupVerification: methods.signupVerification ?? "link",
    };
  } catch {
    return FALLBACK_METHODS;
  }
}

/**
 * Where a "Continue with Google" button sends the browser.
 *
 * A full-page trip to the API (which redirects to the provider), not a fetch:
 * the provider's page has to be the top-level page.
 */
export function oauthStartUrl(provider: string, next: string, mode: "login" | "link" = "login"): string {
  return apiUrl(`/auth/oauth/${encodeURIComponent(provider)}/start${query({ next, mode })}`);
}

/** Exchange the one-time code the provider round trip ended with. Stores the token. */
export async function completeOAuth(code: string): Promise<{ session: AuthSession; created: boolean }> {
  const data = await apiPost<ApiAuthPayload & { created?: boolean }>("/auth/oauth/complete", { code });
  return { session: acceptAuthPayload(data), created: Boolean(data.created) };
}

export function requestSignInCode(
  channel: OtpChannel,
  destination: string,
  purpose: "login" | "signup" = "login",
): Promise<IssuedOtp> {
  return apiPost<IssuedOtp>("/auth/otp/request", { channel, destination, purpose });
}

export type CodeSignIn =
  | { status: "signed-in"; session: AuthSession }
  | { status: "signup-required"; signupToken: string; channel: OtpChannel; destination: string };

/** Sign in with a code. A code for an address with no account says so, with a token to finish signing up. */
export async function verifySignInCode(challengeId: string, code: string): Promise<CodeSignIn> {
  const data = await apiPost<
    | ({ status: "signed-in" } & ApiAuthPayload)
    | { status: "signup-required"; signupToken: string; channel: OtpChannel; destination: string }
  >("/auth/otp/verify", { challengeId, code });
  if (data.status === "signed-in") return { status: "signed-in", session: acceptAuthPayload(data) };
  return { status: "signup-required", signupToken: data.signupToken, channel: data.channel, destination: data.destination };
}

export interface CodeSignUpInput {
  signupToken: string;
  firstName: string;
  lastName?: string;
  /** Required when the code came by SMS. */
  email?: string;
  referralCode?: string;
  marketingOptIn?: boolean;
}

export async function signUpWithCode(input: CodeSignUpInput): Promise<AuthSession> {
  return acceptAuthPayload(await apiPost<ApiAuthPayload>("/auth/otp/signup", input));
}

/* ---------------------------------------------------------- signed in */

export function getSecurity(): Promise<AccountSecurity> {
  return apiGet<AccountSecurity>("/account/security", AUTH);
}

/** Start connecting a provider: the browser is sent to the URL at once (its ticket lasts two minutes). */
export async function startLinking(provider: string, next = "/account/settings"): Promise<string> {
  const data = await apiPost<{ url: string }>(`/account/identities/${encodeURIComponent(provider)}/link`, { next }, AUTH);
  return data.url;
}

export function unlinkIdentity(id: number): Promise<AccountSecurity> {
  return apiDelete<AccountSecurity>(`/account/identities/${id}`, AUTH);
}

export function requestPhoneCode(phone: string): Promise<IssuedOtp> {
  return apiPost<IssuedOtp>("/account/phone/otp", { phone }, AUTH);
}

export function verifyPhoneCode(challengeId: string, code: string): Promise<AccountSecurity> {
  return apiPost<AccountSecurity>("/account/phone/verify", { challengeId, code }, AUTH);
}

export function removePhone(): Promise<AccountSecurity> {
  return apiDelete<AccountSecurity>("/account/phone", AUTH);
}

export type EmailCodeResult = { alreadyVerified: true } | ({ alreadyVerified: false } & IssuedOtp);

export function requestEmailCode(): Promise<EmailCodeResult> {
  return apiPost<EmailCodeResult>("/account/email/code", {}, AUTH);
}

export async function verifyEmailCode(challengeId: string, code: string): Promise<User> {
  return toUser(await apiPost<ApiCustomer>("/account/email/verify-code", { challengeId, code }, AUTH));
}

export function requestPasswordCode(): Promise<IssuedOtp> {
  return apiPost<IssuedOtp>("/account/password/otp", {}, AUTH);
}

/** Set a first password. Other devices are signed out; this one carries on with the token sent back. */
export async function setPasswordWithCode(challengeId: string, code: string, newPassword: string): Promise<void> {
  const data = await apiPost<{ token: ApiToken }>("/account/password/set", { challengeId, code, newPassword }, AUTH);
  storeCustomerToken(data.token);
}

export function getSessions(): Promise<SignedInSession[]> {
  return apiGet<SignedInSession[]>("/account/sessions", AUTH);
}

/** Sign one device out. When it is this one, this device is signed out here too. */
export async function revokeSession(id: string): Promise<{ signedOut: boolean }> {
  const data = await apiDelete<{ signedOut: boolean }>(`/account/sessions/${encodeURIComponent(id)}`, AUTH);
  if (data?.signedOut) endCustomerSession("You've been signed out on this device.");
  return { signedOut: Boolean(data?.signedOut) };
}

/** Sign out every other device; this one continues with the fresh token. */
export async function revokeOtherSessions(): Promise<number> {
  const data = await apiPost<{ revoked: number; token: ApiToken }>("/account/sessions/revoke-others", {}, AUTH);
  if (data?.token?.accessToken) storeCustomerToken(data.token);
  return data?.revoked ?? 0;
}

/* ------------------------------------------------------------ helpers */

/**
 * A full-page navigation (to a provider's sign-in page). An object so tests
 * can watch it: jsdom cannot leave the page.
 */
export const fullPage = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** The API's message, or a fallback when the failure was not the API's. */
export function messageOf(error: unknown, fallback = "Something went wrong. Please try again."): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

/** The API's error code, or "" for anything else. */
export function codeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : "";
}
