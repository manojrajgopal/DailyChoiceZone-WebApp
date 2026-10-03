"use client";

import { useState } from "react";
import { Copy, Lock } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminSelect, AdminToggle } from "@/components/admin/ui/AdminForm";
import { Badge, Tile, problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { ApiError } from "@/services/api/client";
import {
  getAuthMethods,
  saveAuthMethods,
  type AuthMethodKey,
  type AuthMethodsView,
  type SignupVerification,
} from "@/services/admin/authMethodsAdminService";
import { toast } from "@/store/toastStore";

const VERIFICATION_OPTIONS: { value: SignupVerification; label: string }[] = [
  { value: "link", label: "An emailed link" },
  { value: "code", label: "A code typed on the sign-up page" },
  { value: "both", label: "Either: link or code" },
];

/**
 * How customers sign in: email and password, a one-time code by email or
 * text, Google, Apple or Microsoft. A method shows as "not set up" until its
 * keys or SMS provider are configured on the server (credentials never come
 * through here); switching it on then makes it appear on the sign-in page.
 * The server refuses a set-up in which nobody could sign in, and every change
 * is recorded in the audit log.
 */
export function AdminAuthenticationView() {
  const loaded = useAdminResource(() => getAuthMethods(), []);
  // The edits; until the first one the page shows what was loaded.
  const [draft, setDraft] = useState<AuthMethodsView | null>(null);
  const [saving, setSaving] = useState(false);
  const view = draft ?? loaded.data ?? null;

  const header = (
    <AdminPageHeader
      title="Authentication"
      description="The ways customers can sign in and create an account."
      breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Settings", href: "/admin/settings" },
        { label: "Authentication" }]}
    />
  );

  if (loaded.error instanceof ApiError && loaded.error.status === 403) {
    return (
      <div>
        {header}
        <AdminCard>
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <Lock className="h-4 w-4 text-admin-muted" strokeWidth={1.75} aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-admin-ink">Your role doesn&rsquo;t include sign-in settings</p>
            <p className="mt-1 max-w-sm text-xs text-admin-muted">Ask a super admin to change how customers sign in.</p>
          </div>
        </AdminCard>
      </div>
    );
  }

  if (!view) {
    return (
      <div>
        {header}
        {loaded.error ? (
          <AdminCard>
            <div className="py-8 text-center">
              <p role="alert" className="text-sm text-admin-ink">{problem(loaded.error, "Sign-in settings didn't load.")}</p>
              <AdminButton size="sm" className="mt-3" onClick={() => void loaded.reload()}>Try again</AdminButton>
            </div>
          </AdminCard>
        ) : (
          <div aria-label="Loading sign-in settings" className="h-64 animate-pulse rounded-[3px] border border-admin-border bg-admin-surface" />
        )}
      </div>
    );
  }

  const saved = loaded.data;
  const dirty = Boolean(draft && saved && (
    draft.signupVerification !== saved.signupVerification
    || draft.methods.some((row) => row.enabled !== saved.methods.find((s) => s.key === row.key)?.enabled)));
  const working = view.methods.filter((row) => row.enabled && row.configured);

  const toggle = (key: AuthMethodKey, enabled: boolean) =>
    setDraft({ ...view, methods: view.methods.map((row) => (row.key === key ? { ...row, enabled } : row)) });

  const save = async () => {
    setSaving(true);
    try {
      const next = await saveAuthMethods({
        ...Object.fromEntries(view.methods.map((row) => [row.key, row.enabled])),
        signupVerification: view.signupVerification,
      });
      setDraft(null);
      await loaded.reload();
      toast.success(next.methods ? "Sign-in methods saved." : "Saved.");
    } catch (error) {
      toast.error(problem(error, "The sign-in methods weren't saved. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied.");
    } catch {
      toast.error("Couldn't copy; select the address and copy it.");
    }
  };

  const s = saved?.summary;

  return (
    <div>
      {header}

      {s ? (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Sign-ins today" value={String(s.signInsToday)} />
          <Tile label="Codes sent today" value={String(s.otpSentToday)} hint={`${s.otpVerifiedToday} used`} />
          <Tile label="Code send failures" value={String(s.otpSendFailuresToday)}
            tone={s.otpSendFailuresToday > 0 ? "bad" : undefined} />
          <Tile label="Provider sign-in failures" value={String(s.oauthFailuresToday)}
            tone={s.oauthFailuresToday > 0 ? "bad" : undefined} />
        </div>
      ) : null}

      {working.length === 1 ? (
        <p role="status" className="mb-4 rounded-[3px] border border-[#f0dcb4] bg-[#fdf6e7] px-3 py-2 text-xs text-[#8a5a12]">
          Only one working sign-in method is on. It can&rsquo;t be switched off until another one is on.
        </p>
      ) : null}

      <AdminCard title="Sign-in methods" description="Switched-on methods that are set up appear on the sign-in page.">
        <ul className="flex flex-col divide-y divide-admin-border">
          {view.methods.map((row) => (
            <li key={row.key} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <AdminToggle label={row.label} checked={row.enabled} disabled={saving}
                    description={row.configured ? undefined : row.reason || "Not set up on the server yet."}
                    onChange={(checked) => toggle(row.key, checked)} />
                </div>
                <Badge tone={!row.configured ? "grey" : row.enabled ? "green" : "amber"}>
                  {!row.configured ? "Not set up" : row.enabled ? "On" : "Off"}
                </Badge>
              </div>
              {row.redirectUri ? (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.6875rem] text-admin-muted">
                  <span>Redirect URI to register with {row.label}:</span>
                  <code className="break-all rounded-[2px] bg-admin-raised px-1.5 py-0.5 font-mono text-admin-ink">{row.redirectUri}</code>
                  <AdminButton size="sm" variant="ghost" aria-label={`Copy the ${row.label} redirect URI`}
                    onClick={() => void copy(row.redirectUri!)}>
                    <Copy className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                  </AdminButton>
                </div>
              ) : null}
              {s && s.signInsByMethod[row.key] ? (
                <p className="mt-1 text-[0.6875rem] text-admin-muted">{s.signInsByMethod[row.key]} sign-in(s) today</p>
              ) : null}
            </li>
          ))}
        </ul>
      </AdminCard>

      <AdminCard title="New accounts" className="mt-4">
        <AdminSelect label="New email-and-password accounts confirm their email with" value={view.signupVerification}
          disabled={saving} options={VERIFICATION_OPTIONS}
          onChange={(event) => setDraft({ ...view, signupVerification: event.target.value as SignupVerification })} />
        <p className="mt-2 text-[0.6875rem] text-admin-muted">
          Accounts made with a phone code or with Google, Apple or Microsoft are already confirmed.
        </p>
      </AdminCard>

      <p className="mt-4 text-[0.6875rem] text-admin-muted">
        Provider keys (Google, Apple, Microsoft) and the SMS provider are set in the server&rsquo;s environment; see
        docs/authentication.md. They are never shown or entered here.
      </p>

      <div className="mt-4 flex justify-end gap-2">
        {dirty ? <AdminButton disabled={saving} onClick={() => setDraft(null)}>Discard</AdminButton> : null}
        <AdminButton variant="primary" disabled={!dirty} loading={saving} onClick={() => void save()}>
          Save sign-in methods
        </AdminButton>
      </div>
    </div>
  );
}
