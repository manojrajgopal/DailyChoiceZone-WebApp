"use client";

import { useState } from "react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminTextarea, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { TD, TH, problem } from "@/components/admin/views/operations/shared";
import { CRUMBS, TryOnTabs } from "@/components/admin/views/tryon/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { type TryOnSettings, getSettings, listCapabilities, listCleanup, runCleanup, saveSettings } from "@/services/admin/tryOnAdminService";
import { toast } from "@/store/toastStore";

/**
 * The feature's switch, the non-member trial, abuse limits and reminders —
 * and, read-only, where images are stored and whether the encryption key is
 * set (both come from the server's environment, never from here).
 */
export function AdminTryOnSettingsView() {
  const settings = useAdminResource(getSettings, []);
  const capabilities = useAdminResource(listCapabilities, []);
  const cleanup = useAdminResource(() => listCleanup(), []);
  const [edited, setForm] = useState<TryOnSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const form = edited ?? settings.data ?? null;
  const set = (patch: Partial<TryOnSettings>) => setForm((f) => {
    const base = f ?? settings.data;
    return base ? { ...base, ...patch } : f;
  });
  const storage = settings.data?.storage;
  const encryption = settings.data?.encryption;

  return (
    <div>
      <AdminPageHeader title="Try-on settings" breadcrumbs={[...CRUMBS, { label: "Settings" }]} />
      <TryOnTabs />
      <div className="grid gap-4 lg:grid-cols-3">
        <AdminCard title="Programme" className="lg:col-span-2">
          {!form ? <span className="block h-40 animate-pulse rounded-[3px] bg-admin-raised" /> : (
            <form className="flex flex-col gap-4" onSubmit={(event) => {
              event.preventDefault();
              setSaving(true);
              void saveSettings(form).then((saved) => { setForm({ ...form, ...saved }); toast.success("Settings saved."); }, (e) => toast.error(problem(e, "Not saved.")))
                .finally(() => setSaving(false));
            }}>
              <AdminToggle label="Virtual try-on is on" description="Off hides it everywhere and refuses new requests." checked={form.enabled} onChange={(enabled) => set({ enabled })} />
              <fieldset className="rounded-[3px] border border-admin-border p-3">
                <legend className="px-1 text-xs font-medium text-admin-ink">Free trial for customers without a qualifying plan</legend>
                <AdminToggle label="Offer a trial" checked={form.trial.enabled} onChange={(enabled) => set({ trial: { ...form.trial, enabled } })} />
                {form.trial.enabled ? (
                  <div className="mt-3 flex flex-col gap-3">
                    <AdminInput label="Try-ons per customer (lifetime)" type="number" min={1} max={100} value={form.trial.generations}
                      onChange={(e) => set({ trial: { ...form.trial, generations: Number(e.target.value) } })} className="max-w-xs" />
                    <div className="flex flex-wrap gap-x-4 text-xs">
                      {(capabilities.data ?? []).filter((c) => c.state === "available").map((c) => (
                        <AdminCheckbox key={c.key} label={c.name} checked={form.trial.capabilities.includes(c.key)}
                          onChange={(e) => set({ trial: { ...form.trial, capabilities: e.target.checked ? [...form.trial.capabilities, c.key] : form.trial.capabilities.filter((k) => k !== c.key) } })} />
                      ))}
                    </div>
                  </div>
                ) : null}
              </fieldset>
              <FormGrid columns={3}>
                <AdminInput label="Try-ons one customer may start per hour" type="number" min={1} value={form.submitPerHour} onChange={(e) => set({ submitPerHour: Number(e.target.value) })} />
                <AdminInput label="Photos one customer may upload per hour" type="number" min={1} value={form.uploadsPerHour} onChange={(e) => set({ uploadsPerHour: Number(e.target.value) })} />
                <AdminInput label="Warn when this much is used (%)" type="number" min={50} max={100} value={form.usageWarningPercent} onChange={(e) => set({ usageWarningPercent: Number(e.target.value) })} />
                <AdminInput label="Remind before deletion (days)" type="number" min={0} max={30} value={form.retentionReminderDays} onChange={(e) => set({ retentionReminderDays: Number(e.target.value) })} />
                <AdminInput label="Keep results after a membership ends (days)" type="number" min={0} max={365} value={form.lapsedGraceDays} onChange={(e) => set({ lapsedGraceDays: Number(e.target.value) })} />
              </FormGrid>
              <AdminToggle label="Ask customers to rate results" checked={form.feedback} onChange={(feedback) => set({ feedback })} />
              <AdminTextarea label="Privacy notice shown before upload" rows={3} maxLength={1000} value={form.privacyNotice} onChange={(e) => set({ privacyNotice: e.target.value })} />
              <AdminButton type="submit" variant="primary" loading={saving} className="self-end">Save</AdminButton>
            </form>
          )}
        </AdminCard>

        <div className="flex flex-col gap-4">
          <AdminCard title="Image storage" description="Set on the server (VTO_STORAGE, AWS_*). Read-only here.">
            {storage ? (
              <dl className="grid gap-2 text-xs">
                <div><dt className="text-admin-muted">In use</dt><dd><StatusBadge tone={storage.active === "s3" ? "good" : storage.active === "ephemeral" ? "warning" : "critical"}>
                  {storage.active === "s3" ? "Private S3" : storage.active === "ephemeral" ? "Ephemeral — nothing kept" : "Unavailable"}</StatusBadge></dd></div>
                {storage.active === "s3" ? <div><dt className="text-admin-muted">Where</dt><dd className="font-mono text-admin-ink">{storage.bucket}/{storage.prefix}/ · {storage.encryption}</dd></div> : null}
                {storage.active === "ephemeral" ? <div><dt className="text-admin-muted">Lifetime</dt><dd className="text-admin-ink">{storage.ephemeralTtlMinutes} minutes, encrypted, then deleted</dd></div> : null}
                {storage.s3Problem ? <div><dt className="text-admin-muted">S3</dt><dd className="text-admin-ink">{storage.s3Problem}</dd></div> : null}
                <div><dt className="text-admin-muted">Permanent storage for plans</dt><dd className="text-admin-ink">{storage.permanentAvailable ? "Available" : "Not until S3 is configured"}</dd></div>
              </dl>
            ) : null}
          </AdminCard>
          <AdminCard title="Credential encryption">
            {encryption ? (
              <p className="text-xs text-admin-muted">
                {encryption.configured ? "VTO_ENCRYPTION_KEY is set." : encryption.available ? "Using a key derived from the JWT secret (development)." : "VTO_ENCRYPTION_KEY is missing: credentials can't be used."}
                {encryption.previousKeySet ? " An old key is still configured — re-encrypt from Credentials, then remove it." : ""}
              </p>
            ) : null}
          </AdminCard>
          <AdminCard title="Deletions waiting" padded={false}
            action={<AdminButton size="sm" onClick={() => void runCleanup().then((r) => { toast.info(`${r.done} deleted, ${r.failed} still failing.`); void cleanup.reload(); }, (e) => toast.error(problem(e, "Retry failed.")))}>Retry now</AdminButton>}>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-admin-border bg-admin-raised text-admin-muted"><tr><th className={TH}>Why</th><th className={TH}>Tries</th><th className={TH}>Next</th></tr></thead>
              <tbody className="divide-y divide-admin-border">
                {cleanup.data?.items.length ? cleanup.data.items.map((t) => (
                  <tr key={t.id}><td className={TD}>{t.reason}<span className="block text-admin-muted">{t.storage}{t.lastError ? ` · ${t.lastError}` : ""}</span></td>
                    <td className={TD}>{t.attempts}</td><td className={`${TD} whitespace-nowrap text-admin-muted`}>{formatDateTime(t.nextAttemptAt)}</td></tr>
                )) : <tr><td className={TD} colSpan={3}><span className="text-admin-muted">None — every deletion was confirmed.</span></td></tr>}
              </tbody>
            </table>
          </AdminCard>
        </div>
      </div>
    </div>
  );
}
