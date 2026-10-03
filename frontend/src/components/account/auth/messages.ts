import { ApiError } from "@/services/api/client";

/**
 * Words for the codes the sign-in flows can end with.
 *
 * The OAuth round trip ends on `/auth/complete?error=<code>` with no message
 * of its own, so each code is given one here. Unknown codes read as a
 * general failure rather than as the raw code.
 */
export const OAUTH_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled. You can try again whenever you're ready.",
  provider_unavailable: "That sign-in option isn't available right now. Please try another way.",
  invalid_state: "That sign-in link has expired or was opened in a different browser. Please start again.",
  invalid_token: "We couldn't confirm who you are with that provider. Please try again.",
  identity_in_use: "That account is already connected to a different Daily Choice Zone account.",
  account_exists:
    "An account with this email already exists. Sign in with your password or a code first, then connect it from Settings → Security",
  email_missing: "That provider didn't share an email address with us, so we couldn't sign you in.",
  email_unverified: "That provider hasn't confirmed your email address yet, so we couldn't sign you in.",
  not_configured: "That sign-in option isn't set up yet. Please choose another way to sign in.",
  account_blocked: "This account has been suspended. Please contact support.",
  already_linked: "That account is already connected to yours.",
  failed: "Something went wrong while signing you in. Please try again.",
};

export function oauthErrorMessage(code: string | null | undefined): string {
  return (code && OAUTH_ERRORS[code]) || OAUTH_ERRORS.failed!;
}

/** Display names for the providers, for messages written before the API is asked. */
export function providerLabel(code: string): string {
  const known: Record<string, string> = { google: "Google", apple: "Apple", microsoft: "Microsoft" };
  return known[code] ?? (code ? code.charAt(0).toUpperCase() + code.slice(1) : "Your account");
}

/** Codes after which the code on screen is spent: a new one has to be asked for. */
export const DEAD_CODE = new Set([
  "OTP_INVALID",
  "OTP_USED",
  "OTP_SUPERSEDED",
  "OTP_LOCKED",
  "OTP_EXPIRED",
  // The number belongs to another account: the code is spent either way.
  "PHONE_IN_USE",
]);

/** What to say about a failed code check, and whether the code can be tried again. */
export function describeCodeError(error: unknown): { message: string; dead: boolean } {
  if (!(error instanceof ApiError)) {
    return { message: "We couldn't check the code just now. Please try again.", dead: false };
  }
  if (error.code === "OTP_INCORRECT") {
    const left = (error.details as { attemptsLeft?: unknown } | null | undefined)?.attemptsLeft;
    if (typeof left === "number") {
      return { message: `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`, dead: false };
    }
    return { message: error.message || "That code isn't right.", dead: false };
  }
  return { message: error.message, dead: DEAD_CODE.has(error.code) };
}

/** Seconds to wait before another code, when the API said to wait. */
export function retryAfterOf(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.code !== "OTP_RESEND_WAIT") return null;
  const wait = (error.details as { retryAfter?: unknown } | null | undefined)?.retryAfter;
  return typeof wait === "number" && wait > 0 ? Math.ceil(wait) : null;
}
