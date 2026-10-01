import type { AuthSession, Credentials, RegisterInput, User } from "@/types";

import { ApiError, apiGet, apiPost, apiPut, setToken } from "@/services/api/client";

/**
 * Customer authentication.
 *
 * Real authentication now: the password is verified against a bcrypt hash on
 * the server, and the token that comes back is what every account endpoint
 * checks. Nothing about a session is decided in the browser.
 *
 * The token lives in local storage. That is not "local storage as the
 * database" — it holds no business data, only proof of who is asking, and it
 * is the ordinary place for a bearer token in a single-page application. The
 * stronger option is an httpOnly cookie, which needs the API and the site to
 * share an origin or a cookie domain; that swap is confined to `client.ts`.
 *
 * The signatures are unchanged from the mock this replaced, which is why no
 * account page or hook had to be touched.
 */

interface ApiCustomer {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  phone: string;
  status: string;
  joinedAt: string;
  emailVerified?: boolean;
}

interface ApiAuthPayload {
  token: { accessToken: string; tokenType: string; expiresIn: number };
  customer: ApiCustomer;
}

export type AuthResult = { ok: true; session: AuthSession } | { ok: false; reason: string };

function toUser(payload: ApiCustomer): User {
  return {
    id: payload.id,
    firstName: payload.firstName,
    lastName: payload.lastName,
    email: payload.email,
    phone: payload.phone,
    memberSince: payload.joinedAt,
    emailVerified: payload.emailVerified ?? false,
  };
}

async function authenticate(path: string, body: unknown): Promise<AuthResult> {
  try {
    const payload = await apiPost<ApiAuthPayload>(path, body);
    setToken(payload.token.accessToken, "customer");
    return {
      ok: true,
      session: { user: toUser(payload.customer), token: payload.token.accessToken },
    };
  } catch (error) {
    // The API's messages are already written for a customer to read — "That
    // email and password do not match", not a status code.
    if (error instanceof ApiError) return { ok: false, reason: error.message };
    return { ok: false, reason: "Something went wrong. Please try again." };
  }
}

export function signIn(credentials: Credentials): Promise<AuthResult> {
  return authenticate("/auth/login", credentials);
}

export function register(input: RegisterInput): Promise<AuthResult> {
  return authenticate("/auth/register", input);
}

export async function signOut(): Promise<void> {
  // Told to the server as well as forgotten locally. There is nothing to
  // invalidate today — a JWT is valid until it expires, by design — but this
  // is where a denylist would hook in.
  try {
    await apiPost("/auth/logout", {}, { auth: "customer" });
  } catch {
    /* signing out has to succeed even when the request does not */
  }
  setToken(null, "customer");
}

/**
 * Who is signed in, according to the server.
 *
 * Asked rather than remembered: a token expires, and an account can be
 * suspended, between one page and the next. Returns null rather than throwing,
 * because signed out is a normal state and not an error.
 */
export async function getCurrentUser(): Promise<User | null> {
  try {
    return toUser(await apiGet<ApiCustomer>("/auth/me", { auth: "customer" }));
  } catch (error) {
    if (error instanceof ApiError && (error.isAuthError || error.status === 403)) {
      setToken(null, "customer");
    }
    return null;
  }
}

export async function updateProfile(patch: Partial<User>): Promise<User | null> {
  try {
    const payload = await apiPut<ApiCustomer>(
      "/account/profile",
      {
        firstName: patch.firstName,
        lastName: patch.lastName,
        phone: patch.phone,
      },
      { auth: "customer" },
    );
    return toUser(payload);
  } catch {
    return null;
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await apiPut("/account/password", { currentPassword, newPassword }, { auth: "customer" });
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, reason: error.message };
    return { ok: false, reason: "Could not change your password." };
  }
}

/* ------------------------------------------------------ account recovery */

type Outcome = { ok: true; message: string } | { ok: false; reason: string; code?: string };

async function attempt(run: () => Promise<unknown>, fallback: string, success: string): Promise<Outcome> {
  try {
    await run();
    return { ok: true, message: success };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, reason: error.message, code: error.code };
    return { ok: false, reason: fallback };
  }
}

/**
 * Ask for a reset link. The server answers the same way whether or not the
 * address has an account, so this says nothing about which addresses do.
 */
export function requestPasswordReset(email: string): Promise<Outcome> {
  return attempt(
    () => apiPost("/auth/password/forgot", { email }),
    "We couldn't send the link just now. Please try again.",
    "If an account exists for that email, we've sent a link to reset the password.",
  );
}

/** Whether a reset link can still be used — checked before the form is shown. */
export function checkResetToken(token: string): Promise<Outcome> {
  return attempt(() => apiPost("/auth/password/reset/check", { token }), "We couldn't check this link.", "");
}

export function resetPassword(token: string, password: string, confirmPassword: string): Promise<Outcome> {
  return attempt(
    () => apiPost("/auth/password/reset", { token, password, confirmPassword }),
    "We couldn't change your password. Please try again.",
    "Your password has been changed. Sign in with your new password.",
  );
}

export function verifyEmail(token: string): Promise<Outcome> {
  return attempt(() => apiPost("/auth/email/verify", { token }), "We couldn't confirm your email just now.",
    "Your email address is confirmed.");
}

/** Send the verification link again to the signed-in customer. */
export async function resendVerification(): Promise<Outcome & { alreadyVerified?: boolean }> {
  try {
    const data = await apiPost<{ alreadyVerified: boolean }>("/account/email/verification", {}, { auth: "customer" });
    return {
      ok: true,
      alreadyVerified: data.alreadyVerified,
      message: data.alreadyVerified ? "Your email address is already confirmed." : "We've sent a new link — check your inbox.",
    };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, reason: error.message, code: error.code };
    return { ok: false, reason: "We couldn't send the link just now." };
  }
}
