import { apiGet, apiPut } from "@/services/api/client";

/**
 * The store's sign-in methods (permission `auth-settings`). The server says
 * which methods are switched on, which are configured (and why not), and
 * refuses a set-up in which nobody could sign in. See docs/authentication.md.
 */

export type AuthMethodKey = "emailPassword" | "emailOtp" | "mobileOtp" | "google" | "apple" | "microsoft";
export type SignupVerification = "link" | "code" | "both";

export interface AuthMethodRow {
  key: AuthMethodKey;
  label: string;
  enabled: boolean;
  configured: boolean;
  reason: string;
  social: boolean;
  redirectUri?: string;
}

export interface AuthSummary {
  signInsToday: number;
  signInsByMethod: Record<string, number>;
  otpSentToday: number;
  otpVerifiedToday: number;
  otpSendFailuresToday: number;
  oauthFailuresToday: number;
}

export interface AuthMethodsView {
  methods: AuthMethodRow[];
  signupVerification: SignupVerification;
  summary?: AuthSummary;
}

const ADMIN = { auth: "admin" } as const;

export function getAuthMethods(): Promise<AuthMethodsView> {
  return apiGet("/admin/auth/methods", ADMIN);
}

export function saveAuthMethods(
  input: Partial<Record<AuthMethodKey, boolean>> & { signupVerification?: SignupVerification },
): Promise<AuthMethodsView> {
  return apiPut("/admin/auth/methods", input, ADMIN);
}
