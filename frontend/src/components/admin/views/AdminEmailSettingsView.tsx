"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Copy, History, Info, Loader2, RefreshCw, X } from "lucide-react";

import {
  AdminButton,
  AdminButtonLink,
  AdminCard,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, FormGrid } from "@/components/admin/ui/AdminForm";
import { SettingsLayout, useSettingsSection } from "@/components/admin/ui/SettingsLayout";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import {
  disconnectEmailAccount,
  getEmailLog,
  getEmailSettings,
  saveEmailAccount,
  saveEmailTypes,
  sendTestEmail,
  startGoogleConnect,
  type EmailAccount,
  type EmailAccountFields,
  type EmailLogEntry,
  type EmailProviderKey,
  type EmailSettings as EmailSettingsData,
  type EmailType,
  type SmtpSecurity,
} from "@/services/emailSettingsService";
import { toast } from "@/store/toastStore";

/**
 * Outgoing email settings.
 *
 * Three things on one page: the account the store sends from, which emails go
 * out (and which a customer may refuse), and what was sent recently. The
 * account is never saved on trust — the server sends a test email with the
 * details first and keeps them only if it arrives — so the form says so, and a
 * failure explains itself instead of leaving a half-working setup behind.
 */

const PROVIDER_NAMES: Record<EmailProviderKey, string> = {
  "gmail-oauth": "Gmail",
  smtp: "SMTP",
};

const SECURITY_OPTIONS: { value: SmtpSecurity; label: string }[] = [
  { value: "starttls", label: "STARTTLS (usually port 587)" },
  { value: "ssl", label: "SSL/TLS (usually port 465)" },
  { value: "none", label: "None (not recommended)" },
];

const DEFAULT_PORT: Record<SmtpSecurity, string> = { starttls: "587", ssl: "465", none: "25" };

const GOOGLE_NOTICE: Record<string, { tone: "good" | "bad" | "info"; fallback: string }> = {
  connected: {
    tone: "good",
    fallback: "Your Google account is connected. A test email was sent and your settings are saved.",
  },
  failed: { tone: "bad", fallback: "We couldn't connect your Google account. Please try again." },
  cancelled: { tone: "info", fallback: "Google sign-in was cancelled. Nothing was changed." },
};

interface Draft {
  provider: EmailProviderKey;
  senderEmail: string;
  senderName: string;
  replyTo: string;
  testRecipient: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  password: string;
}

function isSecurity(value: string | undefined): value is SmtpSecurity {
  return value === "starttls" || value === "ssl" || value === "none";
}

/** A fresh form from the saved account. Secrets always start blank. */
function draftFrom(account: EmailAccount): Draft {
  const fields: EmailAccountFields = account.readable === false ? {} : (account.fields ?? {});
  return {
    provider: account.provider ?? "gmail-oauth",
    senderEmail: account.senderEmail ?? "",
    senderName: account.senderName ?? "",
    replyTo: account.replyTo ?? "",
    testRecipient: "",
    clientId: fields.clientId ?? "",
    clientSecret: "",
    refreshToken: "",
    accessToken: "",
    host: fields.host ?? "",
    port: fields.port ?? "587",
    security: isSecurity(fields.security) ? fields.security : "starttls",
    username: fields.username ?? "",
    password: "",
  };
}

/** Server times are UTC without an offset; read them as UTC. */
/** How many sends the settings page previews; the rest are on the history page. */
const RECENT_EMAILS = 8;

const EMAIL_SECTIONS = ["account", "types", "recent"];

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const date = new Date(hasZone ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value: string): string {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/* ------------------------------------------------------------------ switch */

/** A compact on/off switch for table cells, labelled for screen readers. */
function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "relative inline-flex shrink-0",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <span className="sr-only">{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          "block h-5 w-9 rounded-pill transition-colors",
          checked ? "bg-copper-600" : "bg-admin-border-strong",
          "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-copper-600",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0.5 top-0.5 block h-4 w-4 rounded-pill bg-white shadow-subtle transition-transform",
          checked && "translate-x-4",
        )}
      />
    </label>
  );
}

export function LogStatusBadge({ status }: { status: EmailLogEntry["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-[3px] px-2 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset",
        status === "sent"
          ? "bg-[#e7f5e7] text-[#0a6b0a] ring-[#bfe3bf]"
          : "bg-[#fbeaea] text-[#a12b2b] ring-[#f1c4c4]",
      )}
    >
      {status === "sent" ? "Sent" : "Failed"}
    </span>
  );
}

/* -------------------------------------------------------------------- view */

export function AdminEmailSettingsView() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-64 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading" />
        </div>
      }
    >
      <EmailSettings />
    </Suspense>
  );
}

function EmailSettings() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // What Google said on the way back, read once on arrival.
  const [notice, setNotice] = useState<{ tone: "good" | "bad" | "info"; message: string } | null>(
    () => {
      const outcome = searchParams?.get("google") ?? "";
      const known = GOOGLE_NOTICE[outcome];
      if (!known) return null;
      return { tone: known.tone, message: searchParams?.get("message") || known.fallback };
    },
  );

  // Clean the address once the notice has been read, so a reload doesn't repeat it.
  const cleaned = useRef(false);
  useEffect(() => {
    if (cleaned.current || !searchParams?.get("google")) return;
    cleaned.current = true;
    router.replace("/admin/settings/email", { scroll: false });
  }, [router, searchParams]);

  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [types, setTypes] = useState<EmailType[]>([]);
  const [savedTypes, setSavedTypes] = useState<EmailType[]>([]);
  const [log, setLog] = useState<EmailLogEntry[] | null>(null);
  const [section, setSection] = useSettingsSection(EMAIL_SECTIONS);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [savingTypes, setSavingTypes] = useState(false);
  const [refreshingLog, setRefreshingLog] = useState(false);

  const applySettings = useCallback((settings: EmailSettingsData) => {
    setAccount(settings.account);
    setDraft(draftFrom(settings.account));
    setTypes(settings.types);
    setSavedTypes(settings.types);
    setLoadFailed(false);
  }, []);

  const applyLog = useCallback((entries: EmailLogEntry[]) => {
    setLog([...entries].sort((a, b) => (toDate(b.at)?.getTime() ?? 0) - (toDate(a.at)?.getTime() ?? 0)));
  }, []);

  const onLogError = useCallback((error: unknown) => {
    setLog((current) => current ?? []);
    toast.error(errorMessage(error, "We couldn't load recent emails. Please try again."));
  }, []);

  const load = async () => {
    try {
      applySettings(await getEmailSettings());
    } catch {
      setLoadFailed(true);
    }
  };

  const loadLog = async () => {
    try {
      applyLog(await getEmailLog(RECENT_EMAILS));
    } catch (error) {
      onLogError(error);
    }
  };

  useEffect(() => {
    let active = true;
    getEmailSettings()
      .then((settings) => active && applySettings(settings))
      .catch(() => active && setLoadFailed(true));
    getEmailLog(RECENT_EMAILS)
      .then((entries) => active && applyLog(entries))
      .catch((error: unknown) => active && onLogError(error));
    return () => {
      active = false;
    };
  }, [applySettings, applyLog, onLogError]);

  if (loadFailed && !account) {
    return (
      <div>
        <Header />
        <AdminCard>
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-admin-muted">We couldn&rsquo;t load your email settings.</p>
            <AdminButton
              size="sm"
              onClick={() => {
                setLoadFailed(false);
                void load();
              }}
            >
              Try again
            </AdminButton>
          </div>
        </AdminCard>
      </div>
    );
  }

  if (!account || !draft) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading email settings" />
      </div>
    );
  }

  /* --------------------------------------------------------- derived */

  const unreadable = account.configured && account.readable === false;
  // Saved hints apply only to the provider they were saved for.
  const saved: EmailAccountFields =
    account.configured && !unreadable && draft.provider === account.provider
      ? (account.fields ?? {})
      : {};
  const keepHint = "Leave blank to keep the saved value.";
  const typesDirty = JSON.stringify(types) !== JSON.stringify(savedTypes);
  const typeLabels = new Map(savedTypes.map((type) => [type.key, type.label]));

  const patch = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const onSecurityChange = (security: SmtpSecurity) =>
    setDraft((current) => {
      if (!current) return current;
      // Follow the usual port for the new setting, unless a custom one was typed.
      const usual = Object.values(DEFAULT_PORT).includes(current.port) || !current.port;
      return { ...current, security, port: usual ? DEFAULT_PORT[security] : current.port };
    });

  /* --------------------------------------------------------- actions */

  const validSender = () => {
    if (!draft.senderEmail.includes("@")) {
      toast.error("Enter the email address your store sends from.");
      return false;
    }
    if (draft.replyTo.trim() && !draft.replyTo.includes("@")) {
      toast.error("Enter a valid reply-to address, or leave it blank.");
      return false;
    }
    if (draft.testRecipient.trim() && !draft.testRecipient.includes("@")) {
      toast.error("Enter a valid address to send the test email to.");
      return false;
    }
    return true;
  };

  const onSave = async () => {
    setSaveError("");
    if (!validSender()) return;

    if (draft.provider === "gmail-oauth") {
      if (!draft.clientId.trim() || !(draft.clientSecret || saved.clientSecret)) {
        toast.error("Enter the Client ID and Client secret from your Google Cloud OAuth client.");
        return;
      }
      if (!(draft.refreshToken || saved.refreshToken)) {
        toast.error("Enter a refresh token, or use Connect with Google to get one automatically.");
        return;
      }
    } else if (!draft.host.trim() || !draft.port.trim()) {
      toast.error("Enter your SMTP server and port.");
      return;
    }

    setSaving(true);
    try {
      const result = await saveEmailAccount({
        ...draft,
        testRecipient: draft.testRecipient.trim() || draft.senderEmail.trim(),
      });
      setAccount(result.account);
      setDraft(draftFrom(result.account));
      toast.success(`Test email sent to ${result.sentTo}. Your email settings are saved.`);
      void loadLog();
    } catch (error) {
      const message = errorMessage(error, "The test email couldn't be sent, so nothing was saved.");
      setSaveError(message);
      toast.error(message);
      void loadLog();
    } finally {
      setSaving(false);
    }
  };

  const onConnectGoogle = async () => {
    setSaveError("");
    if (!validSender()) return;
    if (!draft.clientId.trim() || !(draft.clientSecret || saved.clientSecret)) {
      toast.error("Enter the Client ID and Client secret first, then connect with Google.");
      return;
    }
    setConnecting(true);
    try {
      const { authorizationUrl } = await startGoogleConnect({
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret,
        senderEmail: draft.senderEmail.trim(),
        senderName: draft.senderName.trim(),
        replyTo: draft.replyTo.trim(),
        testRecipient: draft.testRecipient.trim() || draft.senderEmail.trim(),
      });
      // Leave the page for Google's sign-in; it sends the admin back here.
      window.location.href = authorizationUrl;
    } catch (error) {
      setConnecting(false);
      toast.error(errorMessage(error, "We couldn't start the Google sign-in. Please try again."));
    }
  };

  const onSendTest = async () => {
    const recipient = testTo.trim() || account.senderEmail || "";
    if (!recipient.includes("@")) {
      toast.error("Enter an address to send the test email to.");
      return;
    }
    setTesting(true);
    try {
      await sendTestEmail(recipient);
      toast.success(`Test email sent to ${recipient}.`);
    } catch (error) {
      toast.error(errorMessage(error, "The test email couldn't be sent. Please try again."));
    } finally {
      setTesting(false);
      void loadLog();
    }
  };

  const onStop = async () => {
    setStopping(true);
    try {
      await disconnectEmailAccount();
      setConfirmStop(false);
      toast.success("Email sending is turned off.");
      await load();
    } catch (error) {
      toast.error(errorMessage(error, "We couldn't turn off email sending. Please try again."));
    } finally {
      setStopping(false);
    }
  };

  const onSaveTypes = async () => {
    setSavingTypes(true);
    try {
      const next = await saveEmailTypes(types);
      setTypes(next);
      setSavedTypes(next);
      toast.success("Your email choices are saved.");
    } catch (error) {
      toast.error(errorMessage(error, "We couldn't save your email choices. Please try again."));
    } finally {
      setSavingTypes(false);
    }
  };

  const onRefreshLog = async () => {
    setRefreshingLog(true);
    await loadLog();
    setRefreshingLog(false);
  };

  const patchType = (key: string, change: Partial<EmailType>) =>
    setTypes((current) => current.map((type) => (type.key === key ? { ...type, ...change } : type)));

  const copyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(account.redirectUri);
      toast.success("Address copied");
    } catch {
      toast.error("We couldn't copy it. Select the address and copy it manually.");
    }
  };

  const verified = toDate(account.verifiedAt);
  const providerName = account.provider ? PROVIDER_NAMES[account.provider] : "";
  const providers = account.providers.length
    ? account.providers
    : (Object.keys(PROVIDER_NAMES) as EmailProviderKey[]).map((key) => ({
        key,
        label: PROVIDER_NAMES[key],
      }));

  /* ---------------------------------------------------------- render */

  return (
    <div>
      <Header />

      {notice ? (
        <div
          role="status"
          className={cn(
            "mb-4 flex items-start gap-2.5 rounded-[3px] border p-3 text-xs leading-relaxed",
            notice.tone === "good" && "border-[#bfe3bf] bg-[#e7f5e7] text-[#0a6b0a]",
            notice.tone === "bad" && "border-[#f1c4c4] bg-[#fbeaea] text-[#a12b2b]",
            notice.tone === "info" && "border-[#c4d7f2] bg-[#e8f0fb] text-[#1f4f8f]",
          )}
        >
          {notice.tone === "good" ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : notice.tone === "bad" ? (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <p className="min-w-0 flex-1">{notice.message}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss message"
            className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <SettingsLayout
        label="Email settings sections"
        active={section}
        onChange={setSection}
        sections={[
          {
            id: "account",
            label: "Sending account",
            group: "Setup",
            content: (
            <AdminCard
              title="Sending account"
              description="The email account your store's messages are sent from."
            >
              {/* status */}
              <div className="mb-5 rounded-[3px] border border-admin-border bg-admin-raised p-3">
                {!account.configured ? (
                  <div className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-pill bg-status-warning"
                    />
                    <p className="text-xs leading-relaxed text-admin-ink">
                      <strong className="font-medium">Not set up</strong> — customers won&rsquo;t
                      receive emails until you connect an account.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-start gap-2.5">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-1.5 h-2 w-2 shrink-0 rounded-pill",
                          unreadable ? "bg-status-critical" : "bg-status-good",
                        )}
                      />
                      <div className="min-w-0 text-xs leading-relaxed">
                        <p className="text-admin-ink">
                          <strong className="font-medium">
                            {unreadable ? "Needs attention" : "Sending emails"}
                          </strong>{" "}
                          from{" "}
                          <span className="font-medium">
                            {account.senderName
                              ? `${account.senderName} <${account.senderEmail}>`
                              : account.senderEmail}
                          </span>
                          {providerName ? ` using ${providerName}` : ""}.
                        </p>
                        <p className="mt-0.5 text-admin-muted">
                          {verified ? `Last verified ${formatDate(verified)}` : "Not verified yet"}
                          {account.replyTo ? ` · Replies go to ${account.replyTo}` : ""}
                        </p>
                      </div>
                    </div>

                    {unreadable ? (
                      <p className="rounded-[3px] border border-[#f1c4c4] bg-[#fbeaea] p-2.5 text-[0.6875rem] leading-relaxed text-[#a12b2b]">
                        The saved sign-in details can no longer be read, so emails can&rsquo;t be sent.
                        Please enter them again below and send a test email to save them.
                      </p>
                    ) : null}

                    {!unreadable ? (
                      <div className="flex flex-wrap items-end gap-2 border-t border-admin-border pt-3">
                        <AdminInput
                          label="Send a test to"
                          type="email"
                          value={testTo}
                          placeholder={account.senderEmail ?? ""}
                          onChange={(event) => setTestTo(event.target.value)}
                          className="w-full sm:w-72"
                        />
                        <AdminButton size="md" onClick={() => void onSendTest()} loading={testing}>
                          Send another test
                        </AdminButton>
                        <AdminButton
                          size="md"
                          variant="ghost"
                          onClick={() => setConfirmStop(true)}
                          className="text-[#c23434] hover:text-[#a32c2c] sm:ml-auto"
                        >
                          Stop sending emails
                        </AdminButton>
                      </div>
                    ) : (
                      <div className="flex justify-end">
                        <AdminButton
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmStop(true)}
                          className="text-[#c23434] hover:text-[#a32c2c]"
                        >
                          Stop sending emails
                        </AdminButton>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* provider */}
              <fieldset className="mb-5">
                <legend className="mb-2 text-xs font-medium text-admin-ink">
                  How should emails be sent?
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {providers.map((option) => {
                    const selected = draft.provider === option.key;
                    return (
                      <label
                        key={option.key}
                        className={cn(
                          "flex cursor-pointer items-start gap-2.5 rounded-[3px] border p-3 transition-colors",
                          selected
                            ? "border-copper-500 bg-copper-50"
                            : "border-admin-border hover:border-admin-border-strong",
                        )}
                      >
                        <input
                          type="radio"
                          name="email-provider"
                          value={option.key}
                          checked={selected}
                          onChange={() => {
                            setSaveError("");
                            patch("provider", option.key);
                          }}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-copper-600"
                        />
                        <span className="min-w-0">
                          <span className="block text-[0.8125rem] font-medium text-admin-ink">
                            {PROVIDER_NAMES[option.key] ?? option.label}
                          </span>
                          <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-admin-muted">
                            {option.label}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {account.configured && account.provider && draft.provider !== account.provider ? (
                  <p className="mt-2 text-[0.6875rem] leading-relaxed text-admin-muted">
                    Switching from {PROVIDER_NAMES[account.provider]}: your current account keeps
                    working until the test email for the new one has been sent.
                  </p>
                ) : null}
              </fieldset>

              {/* provider fields */}
              {draft.provider === "gmail-oauth" ? (
                <div className="mb-5 flex flex-col gap-4">
                  <div className="rounded-[3px] border border-[#c4d7f2] bg-[#e8f0fb] p-3 text-[0.6875rem] leading-relaxed text-admin-ink">
                    <p>
                      <strong className="font-medium">Setting up Gmail.</strong> In Google Cloud
                      Console, create an OAuth client of type &ldquo;Web application&rdquo; and copy
                      its Client ID and Client secret here. Then either paste a refresh token below,
                      or use <strong className="font-medium">Connect with Google</strong> and we&rsquo;ll
                      get one for you.
                    </p>
                    <p className="mt-2">
                      Add this address as an Authorised redirect URI in your Google Cloud OAuth client:
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <code
                        className="min-w-0 flex-1 select-all truncate rounded-[3px] border border-admin-border bg-admin-surface px-2.5 py-1.5 font-mono text-[0.6875rem] text-admin-ink"
                        title={account.redirectUri}
                      >
                        {account.redirectUri}
                      </code>
                      <AdminButton size="sm" onClick={() => void copyRedirect()} aria-label="Copy redirect address">
                        <Copy className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                        Copy
                      </AdminButton>
                    </div>
                    <p className="mt-1.5 text-admin-muted">
                      This address is set automatically for your store — you only need to add it in
                      Google Cloud.
                    </p>
                  </div>

                  <FormGrid>
                    <AdminInput
                      label="Client ID"
                      value={draft.clientId}
                      onChange={(event) => patch("clientId", event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      required
                      className="sm:col-span-2"
                    />
                    <AdminInput
                      label="Client secret"
                      type="password"
                      autoComplete="off"
                      value={draft.clientSecret}
                      placeholder={saved.clientSecret ?? ""}
                      onChange={(event) => patch("clientSecret", event.target.value)}
                      hint={saved.clientSecret ? keepHint : undefined}
                      required={!saved.clientSecret}
                    />
                    <AdminInput
                      label="Refresh token"
                      type="password"
                      autoComplete="off"
                      value={draft.refreshToken}
                      placeholder={saved.refreshToken ?? ""}
                      onChange={(event) => patch("refreshToken", event.target.value)}
                      hint={
                        saved.refreshToken
                          ? keepHint
                          : "Don't have one? Use Connect with Google below instead."
                      }
                    />
                    <AdminInput
                      label="Access token (optional)"
                      type="password"
                      autoComplete="off"
                      value={draft.accessToken}
                      placeholder={saved.accessToken ?? ""}
                      onChange={(event) => patch("accessToken", event.target.value)}
                      hint={
                        saved.accessToken
                          ? `${keepHint} It's refreshed automatically.`
                          : "Optional — it's refreshed automatically."
                      }
                      className="sm:col-span-2"
                    />
                  </FormGrid>
                </div>
              ) : (
                <div className="mb-5">
                  <FormGrid>
                    <AdminInput
                      label="Server"
                      value={draft.host}
                      placeholder="smtp.example.com"
                      onChange={(event) => patch("host", event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                    <div className="grid grid-cols-[6rem_1fr] gap-4">
                      <AdminInput
                        label="Port"
                        inputMode="numeric"
                        value={draft.port}
                        onChange={(event) => patch("port", event.target.value.replace(/\D/g, ""))}
                        autoComplete="off"
                        required
                      />
                      <AdminSelect
                        label="Security"
                        value={draft.security}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (isSecurity(value)) onSecurityChange(value);
                        }}
                        options={SECURITY_OPTIONS}
                      />
                    </div>
                    <AdminInput
                      label="Username"
                      value={draft.username}
                      onChange={(event) => patch("username", event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      hint="Usually your full email address."
                    />
                    <AdminInput
                      label="Password"
                      type="password"
                      autoComplete="off"
                      value={draft.password}
                      placeholder={saved.password ?? ""}
                      onChange={(event) => patch("password", event.target.value)}
                      hint={
                        saved.password
                          ? keepHint
                          : "Some providers ask for an app password rather than your normal one."
                      }
                    />
                  </FormGrid>
                </div>
              )}

              {/* common */}
              <FormGrid>
                <AdminInput
                  label="Sender email"
                  type="email"
                  value={draft.senderEmail}
                  placeholder="orders@yourstore.com"
                  onChange={(event) => patch("senderEmail", event.target.value)}
                  hint="Customers see emails as coming from this address."
                  required
                />
                <AdminInput
                  label="Sender name"
                  value={draft.senderName}
                  placeholder="Your store name"
                  onChange={(event) => patch("senderName", event.target.value)}
                  hint="Shown next to the address in the customer's inbox."
                />
                <AdminInput
                  label="Reply-to (optional)"
                  type="email"
                  value={draft.replyTo}
                  onChange={(event) => patch("replyTo", event.target.value)}
                  hint="Where customer replies go, if not the sender email."
                />
                <AdminInput
                  label="Send the test email to"
                  type="email"
                  value={draft.testRecipient}
                  placeholder={draft.senderEmail || "Defaults to the sender email"}
                  onChange={(event) => patch("testRecipient", event.target.value)}
                  hint="Defaults to the sender email."
                />
              </FormGrid>

              {saveError ? (
                <p
                  role="alert"
                  className="mt-4 rounded-[3px] border border-[#f1c4c4] bg-[#fbeaea] p-3 text-[0.6875rem] leading-relaxed text-[#a12b2b]"
                >
                  {saveError}
                </p>
              ) : null}

              <div className="mt-5 flex flex-col gap-3 border-t border-admin-border pt-4 sm:flex-row sm:items-start sm:justify-between">
                <p className="max-w-md text-[0.6875rem] leading-relaxed text-admin-muted">
                  We&rsquo;ll send a test email with these details first. They&rsquo;re only saved once
                  the test email has been sent — if it can&rsquo;t be sent, nothing changes.
                </p>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  {draft.provider === "gmail-oauth" ? (
                    <AdminButton
                      onClick={() => void onConnectGoogle()}
                      loading={connecting}
                      disabled={saving}
                    >
                      Connect with Google
                    </AdminButton>
                  ) : null}
                  <AdminButton
                    variant="primary"
                    onClick={() => void onSave()}
                    loading={saving}
                    disabled={connecting}
                  >
                    Send test and save
                  </AdminButton>
                </div>
              </div>
            </AdminCard>
            ),
          },
          {
            id: "types",
            label: "Emails sent",
            group: "Setup",
            dirty: typesDirty,
            content: (
            <AdminCard
              title="Emails your store sends"
              description="Choose which emails go out, and which ones customers may turn off in their account."
              padded={false}
              action={
                <AdminButton
                  size="sm"
                  variant="primary"
                  onClick={() => void onSaveTypes()}
                  loading={savingTypes}
                  disabled={!typesDirty}
                >
                  Save
                </AdminButton>
              }
            >
              {types.length === 0 ? (
                <p className="p-8 text-center text-sm text-admin-muted">No emails to manage yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[36rem] text-left text-xs">
                    <thead className="border-b border-admin-border text-admin-muted">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Email</th>
                        <th className="w-24 px-4 py-2.5 text-center font-medium">Send</th>
                        <th className="w-40 px-4 py-2.5 text-center font-medium">Customers can turn off</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-admin-border">
                      {types.map((type) => (
                        <tr key={type.key} className="hover:bg-admin-raised">
                          <td className="px-4 py-3">
                            <span className="block font-medium text-admin-ink">{type.label}</span>
                            {type.description ? (
                              <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-admin-muted">
                                {type.description}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <Switch
                              label={`Send ${type.label}`}
                              checked={type.enabled}
                              onChange={(checked) => patchType(type.key, { enabled: checked })}
                            />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <Switch
                              label={`Customers can turn off ${type.label}`}
                              checked={type.customerCanOptOut}
                              disabled={!type.enabled}
                              onChange={(checked) => patchType(type.key, { customerCanOptOut: checked })}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {types.length > 0 ? (
                <p className="border-t border-admin-border px-4 py-3 text-[0.6875rem] leading-relaxed text-admin-faint">
                  Emails customers can&rsquo;t turn off are always sent, such as order confirmations
                  they need for their records.
                </p>
              ) : null}
            </AdminCard>
            ),
          },
          {
            id: "recent",
            label: "Recent emails",
            group: "Activity",
            content: (
            <AdminCard
              title="Recent emails"
              description={`The ${RECENT_EMAILS} latest emails sent from your store, newest first.${
                account.bounceTracking?.enabled ? " Emails that bounce back are marked Failed automatically." : ""
              }`}
              padded={false}
              action={
                <div className="flex flex-wrap gap-2">
                  <AdminButton size="sm" onClick={() => void onRefreshLog()} loading={refreshingLog}>
                    {refreshingLog ? null : <RefreshCw className="h-3 w-3" strokeWidth={2} aria-hidden="true" />}
                    Refresh
                  </AdminButton>
                  <AdminButtonLink href="/admin/settings/email/history" size="sm" variant="primary">
                    <History className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    Open email history
                    <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </AdminButtonLink>
                </div>
              }
            >
              {account.configured && account.bounceTracking && !account.bounceTracking.enabled && account.bounceTracking.reason ? (
                <p className="flex items-start gap-2 border-b border-admin-border bg-[#fdf6e3] px-4 py-2.5 text-xs leading-relaxed text-[#8a5d00]">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Bounce checking is off: {account.bounceTracking.reason}
                </p>
              ) : null}
              {log === null ? (
                <div className="flex h-40 items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading recent emails" />
                </div>
              ) : log.length === 0 ? (
                <p className="p-8 text-center text-sm text-admin-muted">No emails have been sent yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[44rem] text-left text-xs">
                    <thead className="border-b border-admin-border text-admin-muted">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Email</th>
                        <th className="px-4 py-2.5 font-medium">Sent to</th>
                        <th className="px-4 py-2.5 font-medium">Status</th>
                        <th className="px-4 py-2.5 font-medium">Reference</th>
                        <th className="px-4 py-2.5 text-right font-medium">Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-admin-border">
                      {log.map((entry) => (
                        <tr key={entry.id} className="align-top hover:bg-admin-raised">
                          <td className="max-w-xs px-4 py-3">
                            <span className="block font-medium text-admin-ink">{entry.subject || "—"}</span>
                            <span className="mt-0.5 block text-[0.6875rem] text-admin-muted">
                              {entry.type === "test"
                                ? "Test email"
                                : (typeLabels.get(entry.type) ?? entry.type)}
                            </span>
                            {entry.status === "failed" && entry.error ? (
                              <span className="mt-1 block text-[0.6875rem] leading-relaxed text-[#a12b2b]">
                                {entry.error}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 text-admin-ink">{entry.recipient}</td>
                          <td className="px-4 py-3">
                            <LogStatusBadge status={entry.status} />
                          </td>
                          <td className="px-4 py-3 text-admin-muted">{entry.reference || "—"}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right text-admin-muted">
                            {formatDateTime(entry.at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </AdminCard>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop sending emails?"
        message="Your saved sending account will be removed. Customers won't receive order updates, invoices or any other emails until you connect an account again."
        confirmLabel="Stop sending"
        loading={stopping}
        onConfirm={() => void onStop()}
      />
    </div>
  );
}

function Header() {
  return (
    <AdminPageHeader
      title="Email"
      description="Connect the account your store sends email from, and choose which emails customers receive."
      breadcrumbs={[
        { label: "Admin", href: "/admin/dashboard" },
        { label: "Settings", href: "/admin/settings" },
        { label: "Email" },
      ]}
    />
  );
}
