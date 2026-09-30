/**
 * Outgoing email: the store's sending account, which emails go out, the recent
 * send log, and each customer's own choices.
 *
 * Secrets never come back from the server — only masked hints of what is
 * saved — so every save that leaves a secret blank keeps the saved value.
 */

import { apiDelete, apiGet, apiPost, apiPut } from "@/services/api/client";

const ADMIN = { auth: "admin" } as const;
const CUSTOMER = { auth: "customer" } as const;

/* ------------------------------------------------------------------- types */

export type EmailProviderKey = "gmail-oauth" | "smtp";
export type SmtpSecurity = "starttls" | "ssl" | "none";

export interface EmailProviderOption {
  key: EmailProviderKey;
  label: string;
}

/** Hints of the saved credentials. Secrets are masked, e.g. `••••••••abcd`. */
export interface EmailAccountFields {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  host?: string;
  port?: string;
  security?: string;
  username?: string;
  password?: string;
  [key: string]: string | undefined;
}

export interface EmailAccount {
  configured: boolean;
  /** The address Google returns to after "Connect with Google". Read-only. */
  redirectUri: string;
  providers: EmailProviderOption[];
  provider?: EmailProviderKey;
  senderEmail?: string;
  senderName?: string;
  replyTo?: string;
  verifiedAt?: string | null;
  updatedAt?: string | null;
  /** False when the saved credentials can no longer be read and must be re-entered. */
  readable?: boolean;
  fields?: EmailAccountFields;
  /** Whether bounce notices in the sending mailbox are being read. */
  bounceTracking?: {
    enabled: boolean;
    /** Why it's off, when it is. */
    reason: string;
    lastCheckedAt: string | null;
    bouncesFound: number;
  };
}

export interface EmailType {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  customerCanOptOut: boolean;
}

export interface EmailSettings {
  account: EmailAccount;
  types: EmailType[];
}

export interface EmailAccountInput {
  provider: EmailProviderKey;
  senderEmail: string;
  senderName: string;
  replyTo: string;
  testRecipient: string;
  // Gmail
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  // SMTP
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  password: string;
}

export interface GoogleStartInput {
  clientId: string;
  /** Blank keeps the saved secret. */
  clientSecret: string;
  senderEmail: string;
  senderName: string;
  replyTo: string;
  testRecipient: string;
}

export interface EmailLogEntry {
  id: number | string;
  type: string;
  recipient: string;
  subject: string;
  status: "sent" | "failed";
  error?: string | null;
  reference?: string | null;
  at: string;
  /** Set when the provider accepted it but a bounce notice came back later. */
  bouncedAt?: string | null;
}

export interface EmailPreference {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  /** Required emails: always sent, cannot be turned off. */
  locked: boolean;
}

/* ------------------------------------------------------------------- admin */

export function getEmailSettings(): Promise<EmailSettings> {
  return apiGet<EmailSettings>("/admin/email", ADMIN);
}

/**
 * Send a test email with these details, and save them only if it sends.
 * A failed test throws an `ApiError` (422) and nothing is saved.
 */
export function saveEmailAccount(
  input: EmailAccountInput,
): Promise<{ account: EmailAccount; sentTo: string }> {
  return apiPost<{ account: EmailAccount; sentTo: string }>("/admin/email/account", input, ADMIN);
}

/** Send a test email with the saved account. */
export async function sendTestEmail(recipient: string): Promise<void> {
  await apiPost<null>("/admin/email/test", { recipient }, ADMIN);
}

/** Stop sending email: forget the saved account. */
export async function disconnectEmailAccount(): Promise<void> {
  await apiDelete<null>("/admin/email/account", ADMIN);
}

export function saveEmailTypes(types: EmailType[]): Promise<EmailType[]> {
  return apiPut<EmailType[]>(
    "/admin/email/types",
    types.map(({ key, enabled, customerCanOptOut }) => ({ key, enabled, customerCanOptOut })),
    ADMIN,
  );
}

/** The most recent sends, newest first (at most 100). */
export function getEmailLog(limit?: number): Promise<EmailLogEntry[]> {
  return apiGet<EmailLogEntry[]>(`/admin/email/log${limit ? `?limit=${limit}` : ""}`, ADMIN);
}

export interface EmailLogFilters {
  status?: string;
  type?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface EmailLogPage {
  items: EmailLogEntry[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  /** Per status, under every filter except the status itself — for the tabs. */
  counts: { sent: number; failed: number };
  types: { key: string; label: string }[];
}

/** The whole email log, filtered and paged by the server. */
export function searchEmailLog(filters: EmailLogFilters): Promise<EmailLogPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return apiGet<EmailLogPage>(`/admin/email/log/search${text ? `?${text}` : ""}`, ADMIN);
}

/** Begin "Connect with Google". Send the browser to `authorizationUrl` next. */
export function startGoogleConnect(
  input: GoogleStartInput,
): Promise<{ authorizationUrl: string; redirectUri: string }> {
  return apiPost<{ authorizationUrl: string; redirectUri: string }>(
    "/admin/email/google/start",
    input,
    ADMIN,
  );
}

/** Email an invoice to its customer. */
export async function sendInvoiceEmail(invoiceId: string): Promise<void> {
  await apiPost<null>(`/admin/billing/invoices/${encodeURIComponent(invoiceId)}/send`, {}, ADMIN);
}

/* ---------------------------------------------------------------- customer */

export function getEmailPreferences(): Promise<EmailPreference[]> {
  return apiGet<EmailPreference[]>("/account/email-preferences", CUSTOMER);
}

export function saveEmailPreferences(choices: Record<string, boolean>): Promise<EmailPreference[]> {
  return apiPut<EmailPreference[]>("/account/email-preferences", choices, CUSTOMER);
}
