/**
 * Ways of signing in beyond the password: one-time codes, Google / Apple /
 * Microsoft, linked accounts and signed-in devices.
 *
 * Shapes as the API sends them (camelCase). Codes themselves never appear in
 * any of these: a code is typed by the shopper and sent once, nothing more.
 */

/** A social sign-in provider the store offers. */
export interface SignInProvider {
  code: string;
  label: string;
}

/** `GET /auth/methods`: what the sign-in page should offer. */
export interface SignInMethods {
  emailPassword: boolean;
  emailOtp: boolean;
  mobileOtp: boolean;
  providers: SignInProvider[];
  /** How a new email-and-password account confirms its address. */
  signupVerification: "link" | "code" | "both";
}

export type OtpChannel = "sms" | "email";

/** What the API says about a code it has just sent. */
export interface IssuedOtp {
  challengeId: string;
  channel: OtpChannel;
  /** Masked, e.g. "+91 ******3210" — safe to show. */
  destination: string;
  /** Seconds until the code stops working. */
  expiresIn: number;
  /** Seconds before another code can be asked for. */
  resendIn: number;
  /** How many digits the code has. */
  length: number;
}

/** A bearer token as the API sends it. */
export interface ApiToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
}

/** A connected Google / Apple / Microsoft account. */
export interface LinkedIdentity {
  id: number;
  provider: string;
  label: string;
  email: string;
  linkedAt: string;
  lastUsedAt: string | null;
}

/** `GET /account/security`: the Security section in one read. */
export interface AccountSecurity {
  email: string;
  emailVerified: boolean;
  /** The sign-in mobile number, "" when there is none. */
  phone: string;
  phoneVerified: boolean;
  /** The contact number on the profile (not necessarily a sign-in number). */
  contactPhone: string;
  hasPassword: boolean;
  identities: LinkedIdentity[];
  providers: (SignInProvider & { linked: boolean })[];
  /** Whether sign-in by SMS code is on, so a mobile number can be added. */
  mobileOtp: boolean;
  /** How many ways in the account has. One means none of them may be removed. */
  waysIn: number;
}

/** One signed-in device (`GET /account/sessions`). */
export interface SignedInSession {
  id: string;
  current: boolean;
  method: string;
  methodLabel: string;
  device: string;
  location: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
}
