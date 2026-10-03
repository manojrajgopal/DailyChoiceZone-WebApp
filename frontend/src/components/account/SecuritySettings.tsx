"use client";

import { useCallback, useEffect, useState } from "react";
import { Monitor } from "lucide-react";

import type { AccountSecurity, IssuedOtp, LinkedIdentity, SignedInSession } from "@/types/identity";

import { CodeStep } from "@/components/account/auth/CodeStep";
import { PhoneVerifyDialog } from "@/components/account/PhoneVerifyDialog";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDate } from "@/lib/utils/format";
import { formatMobile } from "@/lib/utils/phone";
import { changePassword } from "@/services/authService";
import {
  codeOf,
  fullPage,
  getSecurity,
  getSessions,
  messageOf,
  removePhone,
  requestEmailCode,
  requestPasswordCode,
  revokeOtherSessions,
  revokeSession,
  setPasswordWithCode,
  startLinking,
  unlinkIdentity,
  verifyEmailCode,
} from "@/services/identityService";
import { useSessionStore } from "@/store/sessionStore";
import { toast } from "@/store/toastStore";

const PASSWORD_HINT = "At least eight characters, with a letter and a number.";
const LAST_WAY_IN =
  "This is your only way to sign in, so it can't be removed. Set a password or connect another account first.";

/** The API's words for "can't remove the last way in", or ours when it sent none. */
function removalMessage(error: unknown, fallback: string): string {
  return codeOf(error) === "LAST_SIGN_IN_METHOD" ? messageOf(error, LAST_WAY_IN) : messageOf(error, fallback);
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const id = `security-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="border-t border-ink-200 pt-5 first:border-t-0 first:pt-0">
      <h3 id={id} className="text-sm font-medium text-ink">
        {title}
      </h3>
      {description ? <p className="mt-1 text-xs leading-relaxed text-ink-500">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Problem({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-2 text-xs text-danger">
      {message}
    </p>
  );
}

/**
 * Settings → Security: every way into the account, in one place.
 *
 * Which ways in there are (password, mobile number, Google / Apple /
 * Microsoft), whether the email and phone are confirmed, connecting and
 * disconnecting accounts, a first password for an account that never had
 * one, and the devices that are signed in. The server keeps the rule that the
 * last way in can't be removed; this page says so when it does.
 */
export function SecuritySettings() {
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setSecurity(await getSecurity());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getSecurity()
      .then((data) => active && setSecurity(data))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);

  return (
    <section aria-labelledby="security-heading" className="mb-5 rounded-card border border-ink-200 bg-shell p-5">
      <h2 id="security-heading" className="label-wide text-ink">
        Security
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        How you sign in, the accounts connected to yours, and where you&rsquo;re signed in.
      </p>

      {security === null && !failed ? (
        <div className="mt-4 flex flex-col gap-3" role="status" aria-label="Loading your security settings">
          <Skeleton className="h-4 w-56 max-w-full" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-4 w-48 max-w-full" />
        </div>
      ) : security === null ? (
        <div className="mt-4">
          <p className="text-sm text-ink-700">We couldn&rsquo;t load your security settings just now.</p>
          <Button variant="outline" className="mt-3" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-5">
          <WaysIn security={security} />
          <EmailRow security={security} onChange={setSecurity} reload={load} />
          <PasswordRow security={security} reload={load} />
          <PhoneRow security={security} onChange={setSecurity} />
          <LinkedAccounts security={security} onChange={setSecurity} />
          <Sessions />
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ summary */

function WaysIn({ security }: { security: AccountSecurity }) {
  const ways = [
    security.hasPassword ? "Email and password" : null,
    security.phone && security.phoneVerified ? `Mobile number (${formatMobile(security.phone)})` : null,
    ...security.identities.map((identity) => identity.label),
  ].filter((way): way is string => Boolean(way));
  const count = security.waysIn || ways.length;

  return (
    <Section title="Ways to sign in">
      <p className="text-sm text-ink-700">
        You can sign in {count === 1 ? "one way" : `${count} ways`}
        {ways.length ? ": " : "."}
        {ways.length ? <span className="text-ink">{ways.join(", ")}.</span> : null}
      </p>
      {count === 1 ? (
        <p className="mt-1 text-xs text-ink-500">
          Add another — a password, your mobile number or a connected account — so you&rsquo;re never locked out.
        </p>
      ) : null}
    </Section>
  );
}

/* -------------------------------------------------------------- email */

function EmailRow({
  security,
  onChange,
  reload,
}: {
  security: AccountSecurity;
  onChange: (security: AccountSecurity) => void;
  reload: () => Promise<void>;
}) {
  const updateUser = useSessionStore((state) => state.updateUser);
  const [issued, setIssued] = useState<IssuedOtp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await requestEmailCode();
      if (result.alreadyVerified) {
        updateUser({ emailVerified: true });
        await reload();
        return;
      }
      setIssued(result);
    } catch (failure) {
      setError(messageOf(failure, "We couldn't send the code just now. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Email address">
      <div className="flex flex-wrap items-center gap-3">
        <span className="break-all text-sm text-ink">{security.email}</span>
        <Badge tone={security.emailVerified ? "stock" : "neutral"}>
          {security.emailVerified ? "Verified" : "Not verified"}
        </Badge>
        {!security.emailVerified && !issued ? (
          <Button variant="outline" size="sm" onClick={() => void send()} disabled={busy}>
            {busy ? "Sending…" : "Verify with a code"}
          </Button>
        ) : null}
      </div>
      <Problem message={error} />
      {issued ? (
        <div className="mt-4 max-w-sm">
          <CodeStep
            key={issued.challengeId}
            issued={issued}
            submitLabel="Confirm email"
            onVerify={async (challengeId, code) => {
              await verifyEmailCode(challengeId, code);
              updateUser({ emailVerified: true });
              setIssued(null);
              onChange({ ...security, emailVerified: true });
              toast.success("Your email address is confirmed");
            }}
            onResend={async () => {
              const result = await requestEmailCode();
              if (result.alreadyVerified) {
                setIssued(null);
                updateUser({ emailVerified: true });
                onChange({ ...security, emailVerified: true });
                return issued;
              }
              return result;
            }}
            onBack={() => setIssued(null)}
            backLabel="Cancel"
            hint="Can't see it? Check your spam or promotions folder."
          />
        </div>
      ) : null}
    </Section>
  );
}

/* ----------------------------------------------------------- password */

function PasswordRow({ security, reload }: { security: AccountSecurity; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedOtp | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const reset = () => {
    setOpen(false);
    setIssued(null);
    setNewPassword("");
    setCurrentPassword("");
    setError(undefined);
  };

  const sendCode = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setIssued(await requestPasswordCode());
      setOpen(true);
    } catch (failure) {
      if (codeOf(failure) === "PASSWORD_ALREADY_SET") await reload();
      setError(messageOf(failure, "We couldn't send the code just now. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const change = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const result = await changePassword(currentPassword, newPassword);
    setBusy(false);
    if (result.ok) {
      reset();
      toast.success("Your password is changed. Other devices have been signed out.");
      return;
    }
    if (result.code === "PASSWORD_NOT_SET") await reload();
    setError(result.reason);
  };

  if (!security.hasPassword) {
    return (
      <Section
        title="Password"
        description="You sign in without a password. Set one if you'd also like to sign in with your email and a password."
      >
        {issued ? (
          <div className="max-w-sm">
            <CodeStep
              key={issued.challengeId}
              issued={issued}
              submitLabel="Set password"
              autoSubmit={false}
              canSubmit={newPassword.length >= 8}
              onVerify={async (challengeId, code) => {
                await setPasswordWithCode(challengeId, code, newPassword);
                reset();
                toast.success("Your password is set. Other devices have been signed out.");
                await reload();
              }}
              onResend={requestPasswordCode}
              onBack={reset}
              backLabel="Cancel"
            >
              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                hint={PASSWORD_HINT}
                minLength={8}
                required
              />
            </CodeStep>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => void sendCode()} disabled={busy}>
            {busy ? "Sending…" : "Set a password"}
          </Button>
        )}
        <Problem message={error} />
      </Section>
    );
  }

  return (
    <Section title="Password">
      {open ? (
        <form onSubmit={change} className="flex max-w-sm flex-col gap-4">
          <Input
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            hint={PASSWORD_HINT}
            minLength={8}
            required
          />
          <Problem message={error} />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={reset} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !currentPassword || newPassword.length < 8}>
              {busy ? "Saving…" : "Change password"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-ink-700">A password is set.</span>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            Change password
          </Button>
        </div>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------- phone */

function PhoneRow({ security, onChange }: { security: AccountSecurity; onChange: (security: AccountSecurity) => void }) {
  const updateUser = useSessionStore((state) => state.updateUser);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string>();
  const hasPhone = Boolean(security.phone);

  if (!hasPhone && !security.mobileOtp) return null;

  const remove = async () => {
    setError(undefined);
    try {
      const next = await removePhone();
      onChange(next);
      updateUser({ phoneVerified: false });
      toast.success("Mobile number removed");
    } catch (failure) {
      setError(removalMessage(failure, "We couldn't remove the number just now. Please try again."));
    }
  };

  return (
    <Section
      title="Mobile number"
      description={security.mobileOtp ? "A confirmed number can be used to sign in with a texted code." : undefined}
    >
      {hasPhone ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-ink">{formatMobile(security.phone)}</span>
          <Badge tone={security.phoneVerified ? "stock" : "neutral"}>
            {security.phoneVerified ? "Verified" : "Not verified"}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
            {security.phoneVerified ? "Change" : "Verify"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
            Remove
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
          Add a mobile number
        </Button>
      )}
      <Problem message={error} />

      <PhoneVerifyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialPhone={hasPhone ? "" : security.contactPhone}
        title={hasPhone ? "Change your mobile number" : "Add a mobile number"}
        onVerified={(next) => {
          onChange(next);
          updateUser({ phone: next.phone, phoneVerified: next.phoneVerified });
          setDialogOpen(false);
          setError(undefined);
          toast.success("Your mobile number is confirmed");
        }}
      />
      <ConfirmModal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove your mobile number?"
        message="You won't be able to sign in with a texted code any more."
        confirmLabel="Remove number"
        onConfirm={remove}
      />
    </Section>
  );
}

/* --------------------------------------------------- linked accounts */

function LinkedAccounts({ security, onChange }: { security: AccountSecurity; onChange: (security: AccountSecurity) => void }) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<LinkedIdentity | null>(null);
  const [error, setError] = useState<string>();

  // Every provider on offer, plus any connected one the store has since switched off.
  const offered = security.providers.map((provider) => provider.code);
  const rows = [
    ...security.providers.map((provider) => ({
      code: provider.code,
      label: provider.label,
      identity: security.identities.find((identity) => identity.provider === provider.code) ?? null,
    })),
    ...security.identities
      .filter((identity) => !offered.includes(identity.provider))
      .map((identity) => ({ code: identity.provider, label: identity.label, identity })),
  ];

  if (rows.length === 0) return null;

  const connect = async (code: string) => {
    setConnecting(code);
    setError(undefined);
    try {
      const url = await startLinking(code, "/account/settings");
      // A one-time ticket that lasts two minutes: go now.
      fullPage.assign(url);
    } catch (failure) {
      setError(messageOf(failure, "That sign-in provider isn't available right now."));
      setConnecting(null);
    }
  };

  const disconnect = async () => {
    if (!disconnecting) return;
    setError(undefined);
    try {
      onChange(await unlinkIdentity(disconnecting.id));
      toast.success(`${disconnecting.label} is disconnected`);
    } catch (failure) {
      setError(removalMessage(failure, "We couldn't disconnect that account just now. Please try again."));
    }
  };

  return (
    <Section title="Connected accounts" description="Sign in with one of these instead of a password or a code.">
      <ul className="flex flex-col divide-y divide-ink-100">
        {rows.map((row) => (
          <li key={row.code} className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0">
            <span className="min-w-0">
              <span className="block text-sm text-ink">{row.label}</span>
              <span className="block text-xs text-ink-500">
                {row.identity
                  ? `Connected${row.identity.email ? ` as ${row.identity.email}` : ""} · since ${formatDate(row.identity.linkedAt)}`
                  : "Not connected"}
              </span>
            </span>
            {row.identity ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDisconnecting(row.identity)}
                aria-label={`Disconnect ${row.label}`}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void connect(row.code)}
                disabled={connecting !== null}
                aria-label={`Connect ${row.label}`}
              >
                {connecting === row.code ? "Opening…" : "Connect"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Problem message={error} />

      <ConfirmModal
        open={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        title={`Disconnect ${disconnecting?.label ?? "this account"}?`}
        message={`You won't be able to sign in with ${disconnecting?.label ?? "it"} any more. You can connect it again later.`}
        confirmLabel="Disconnect"
        onConfirm={disconnect}
      />
    </Section>
  );
}

/* ----------------------------------------------------------- sessions */

function Sessions() {
  const [sessions, setSessions] = useState<SignedInSession[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setSessions(await getSessions());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getSessions()
      .then((list) => active && setSessions(list))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);

  const signOutOne = async (session: SignedInSession) => {
    setBusyId(session.id);
    setError(undefined);
    try {
      const { signedOut } = await revokeSession(session.id);
      // This device: the session is over here too, and the page has already been told.
      if (signedOut) return;
      setSessions((list) => (list ?? []).filter((item) => item.id !== session.id));
      toast.success("That device is signed out");
    } catch (failure) {
      setError(messageOf(failure, "We couldn't sign that device out just now. Please try again."));
    } finally {
      setBusyId(null);
    }
  };

  const signOutOthers = async () => {
    setError(undefined);
    try {
      const count = await revokeOtherSessions();
      toast.success(
        count === 0 ? "No other devices were signed in" : `Signed out of ${count} other ${count === 1 ? "device" : "devices"}`,
      );
      await load();
    } catch (failure) {
      setError(messageOf(failure, "We couldn't sign out your other devices just now. Please try again."));
    }
  };

  const others = (sessions ?? []).filter((session) => !session.current);

  return (
    <Section title="Where you're signed in">
      {sessions === null && !failed ? (
        <div role="status" aria-label="Loading your signed-in devices" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="h-4 w-52 max-w-full" />
        </div>
      ) : sessions === null ? (
        <div>
          <p className="text-sm text-ink-700">We couldn&rsquo;t load your signed-in devices.</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-ink-100" aria-label="Signed-in devices">
            {sessions.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0">
                <span className="flex min-w-0 items-start gap-2.5">
                  <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" strokeWidth={1.5} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
                      {session.device}
                      {session.current ? <Badge tone="new">This device</Badge> : null}
                    </span>
                    <span className="block text-xs text-ink-500">
                      {[
                        session.methodLabel,
                        session.location,
                        `signed in ${formatDate(session.createdAt)}`,
                        session.lastSeenAt ? `last active ${formatDate(session.lastSeenAt)}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void signOutOne(session)}
                  disabled={busyId !== null}
                  aria-label={session.current ? "Sign out of this device" : `Sign out ${session.device}`}
                >
                  {busyId === session.id ? "Signing out…" : "Sign out"}
                </Button>
              </li>
            ))}
          </ul>
          {others.length > 0 ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => setConfirmAll(true)}>
              Sign out of all other devices
            </Button>
          ) : null}
        </>
      )}
      <Problem message={error} />

      <ConfirmModal
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Sign out of all other devices?"
        message="Every other phone, tablet and browser signed in to your account will be signed out. This one stays signed in."
        confirmLabel="Sign out others"
        onConfirm={signOutOthers}
      />
    </Section>
  );
}
