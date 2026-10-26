"use client";

import { useMemo, useState } from "react";
import { KeyRound, Plus, RefreshCw, ShieldAlert } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminTextarea, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { FilterSelect } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState, problem } from "@/components/admin/views/operations/shared";
import { CRUMBS, CredentialState, NoAccess, TryOnTabs } from "@/components/admin/views/tryon/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { useAdminSession } from "@/hooks/useAdminSession";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import {
  type Credential,
  type CredentialAction,
  type CredentialInput,
  type Model,
  type Provider,
  STATE_LABELS,
  addCredential,
  addCredentials,
  credentialAction,
  credentialUsage,
  deleteCredential,
  listCredentials,
  listMappings,
  listModels,
  listProviders,
  reencryptCredentials,
  rotateCredential,
  updateCredential,
} from "@/services/admin/tryOnAdminService";
import { toast } from "@/store/toastStore";

/**
 * AI provider credentials. A token is typed once and never shown again:
 * the list carries a mask, the last four characters and what the provider
 * last said about it. Hidden credentials are still used; disabled ones aren't.
 */
export function AdminTryOnCredentialsView() {
  const { can } = useAdminSession();
  const [providerId, setProviderId] = useState("");
  const [state, setState] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const allowed = can("manage:tryOnCredentials");
  const list = useAdminResource(
    () => listCredentials({ providerId, state, includeHidden, includeDeleted }),
    [providerId, state, includeHidden, includeDeleted],
    { enabled: allowed },
  );
  const providers = useAdminResource(listProviders, [], { enabled: allowed });
  const models = useAdminResource(listModels, [], { enabled: allowed });
  const [editing, setEditing] = useState<Credential | "new" | null>(null);
  const [bulk, setBulk] = useState(false);
  const [rotating, setRotating] = useState<Credential | null>(null);
  const [deleting, setDeleting] = useState<Credential | null>(null);
  const [usageOf, setUsageOf] = useState<Credential | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const data = list.data;
  const providerName = (id: string) => providers.data?.find((p) => p.id === id)?.name ?? id;
  const modelName = (id: string) => models.data?.find((m) => m.id === id)?.name ?? id;

  if (!allowed) {
    return (
      <div>
        <AdminPageHeader title="Try-on credentials" breadcrumbs={[...CRUMBS, { label: "Credentials" }]} />
        <TryOnTabs />
        <NoAccess what="AI credentials" />
      </div>
    );
  }

  const act = async (row: Credential, action: CredentialAction) => {
    setBusy(`${row.id}:${action}`);
    try {
      const next = await credentialAction(row.id, action);
      if (action !== "validate") toast.success(`Credential ${action}d.`);
      else if (next.validationStatus === "valid") toast.success("Accepted by the provider.");
      else if (next.validationStatus === "invalid") toast.error("The provider rejected this token. Replace it.");
      else toast.error(`Couldn't check it: ${(next.lastError || STATE_LABELS[next.state] || "").replace(/\.$/, "")}. Try again in a moment.`);
      void list.reload();
    } catch (error) {
      toast.error(problem(error, "That didn't work."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="Try-on credentials"
        description="Tokens for the AI providers. Saved tokens are encrypted and never shown again — replace one to change it."
        breadcrumbs={[...CRUMBS, { label: "Credentials" }]}
        actions={
          <div className="flex flex-wrap gap-2">
            <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
              {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} Refresh
            </AdminButton>
            <AdminButton size="sm" onClick={() => setBulk(true)}>Add several</AdminButton>
            <AdminButton size="sm" variant="primary" onClick={() => setEditing("new")}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add credential
            </AdminButton>
          </div>
        }
      />
      <TryOnTabs />

      {data && !data.encryption.configured ? (
        <div className="mb-4 flex gap-2 rounded-[3px] border border-[#fab219]/40 bg-[#fdf3dd] p-3 text-xs text-[#8a5d00]" role="status">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          {data.encryption.available
            ? "VTO_ENCRYPTION_KEY is not set: credentials are encrypted with a key derived from the JWT secret. Set a dedicated key before going live."
            : "VTO_ENCRYPTION_KEY is not set, so credentials can't be saved or used. Set it on the server."}
        </div>
      ) : null}
      {data?.encryption.previousKeySet ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-[3px] border border-admin-border bg-admin-raised p-3 text-xs text-admin-muted">
          <span>An old encryption key is still configured. Re-encrypt every credential with the current key, then remove the old one.</span>
          <AdminButton size="sm" onClick={() => void reencryptCredentials().then((r) => { toast.success(`${r.reencrypted} re-encrypted${r.unreadable ? `, ${r.unreadable} unreadable` : ""}.`); void list.reload(); }, (e) => toast.error(problem(e, "Re-encryption failed.")))}>
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> Re-encrypt now
          </AdminButton>
        </div>
      ) : null}

      {data ? (
        <p className="mb-3 text-xs text-admin-muted">
          {data.counts.total} configured · {data.counts.healthy} healthy · {data.counts.unvalidated} not checked ·{data.counts.check_failed ? ` ${data.counts.check_failed} couldn't check ·` : ""} {data.counts.disabled} disabled ·{" "}
          {data.counts.invalid} invalid · {data.counts.rate_limited} rate limited · {data.counts.hidden} hidden · {data.counts.dedicated} dedicated
        </p>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <FilterSelect label="Provider" value={providerId} onChange={setProviderId}
          options={[{ value: "", label: "All providers" }, ...(providers.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
        <FilterSelect label="State" value={state} onChange={setState}
          options={[{ value: "", label: "Any state" }, ...Object.entries(STATE_LABELS).map(([value, label]) => ({ value, label }))]} />
        <AdminCheckbox label="Show hidden" checked={includeHidden} onChange={(e) => setIncludeHidden(e.target.checked)} />
        <AdminCheckbox label="Show deleted" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
      </div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[64rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr><th className={TH}>Credential</th><th className={TH}>State</th><th className={TH}>Used for</th><th className={TH}>Who</th>
                <th className={cn(TH, "text-right")}>Calls</th><th className={TH}>Last used</th><th className={TH}><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={7} loading={list.isLoading && !data} failed={Boolean(list.error && !data)} empty={Boolean(data && !data.items.length)}
                onRetry={() => void list.reload()} title="No credentials" hint="Add a Hugging Face token to start running try-ons." />
              {data?.items.map((row) => (
                <tr key={row.id} className={cn("align-top hover:bg-admin-raised", row.deletedAt && "opacity-60")}>
                  <td className={TD}>
                    <span className="font-medium text-admin-ink">{row.label}</span>
                    <span className="block font-mono text-admin-muted">{row.masked || "secret erased"}</span>
                    <span className="block text-admin-muted">{row.id} · {providerName(row.providerId)} · priority {row.priority}{row.hidden ? " · hidden" : ""}</span>
                  </td>
                  <td className={TD}>
                    <CredentialState state={row.state} />
                    {row.lastError ? <span className="mt-1 block max-w-[14rem] text-admin-muted">{row.lastError}</span> : null}
                    {row.cooldownUntil && row.state === "rate_limited" ? <span className="block text-admin-muted">Resting until {formatDateTime(row.cooldownUntil)}</span> : null}
                    {row.lastValidatedAt ? <span className="block text-admin-faint">Checked {formatDateTime(row.lastValidatedAt)}</span> : null}
                  </td>
                  <td className={TD}>
                    <span className="block">{row.modelIds.length ? row.modelIds.map(modelName).join(", ") : "All models"}</span>
                    <span className="block text-admin-muted">{row.capabilityKeys.length ? row.capabilityKeys.join(", ") : "Every kind its models support"}</span>
                    {row.categoryIds.length ? <span className="block text-admin-muted">Categories: {row.categoryIds.join(", ")}</span> : null}
                    {row.dailyLimit || row.monthlyLimit ? <span className="block text-admin-muted">Limits: {row.dailyLimit ?? "∞"}/day, {row.monthlyLimit ?? "∞"}/month</span> : null}
                  </td>
                  <td className={TD}>
                    {row.scope === "dedicated" ? <>Dedicated to <span className="font-medium">{row.dedicatedCustomerId}</span></> : row.autoSelect ? "Shared, picked automatically" : "Shared, not picked automatically"}
                  </td>
                  <td className={cn(TD, "text-right tabular-nums")}>{row.successCount} ok<span className="block text-admin-muted">{row.failureCount} failed</span></td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.lastUsedAt)}</td>
                  <td className={cn(TD, "whitespace-nowrap text-right")}>
                    {row.deletedAt ? <span className="text-admin-muted">Deleted {formatDateTime(row.deletedAt)}</span> : (
                      <div className="flex flex-wrap justify-end gap-1">
                        <AdminButton size="sm" variant="ghost" loading={busy === `${row.id}:validate`} onClick={() => void act(row, "validate")}>Check</AdminButton>
                        <AdminButton size="sm" variant="ghost" onClick={() => setEditing(row)}>Edit</AdminButton>
                        <AdminButton size="sm" variant="ghost" onClick={() => setRotating(row)}>Replace token</AdminButton>
                        <AdminButton size="sm" variant="ghost" onClick={() => void act(row, row.status === "disabled" ? "enable" : "disable")}>{row.status === "disabled" ? "Enable" : "Disable"}</AdminButton>
                        <AdminButton size="sm" variant="ghost" onClick={() => void act(row, row.hidden ? "unhide" : "hide")}>{row.hidden ? "Unhide" : "Hide"}</AdminButton>
                        <AdminButton size="sm" variant="ghost" onClick={() => setUsageOf(row)}>Usage</AdminButton>
                        <AdminButton size="sm" variant="ghost" onClick={() => setDeleting(row)}>Delete</AdminButton>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {editing ? (
        <CredentialForm value={editing === "new" ? null : editing} providers={providers.data ?? []} models={models.data ?? []}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />
      ) : null}
      {bulk ? <BulkForm providers={providers.data ?? []} onClose={() => setBulk(false)} onSaved={() => void list.reload()} /> : null}
      {rotating ? <RotateForm credential={rotating} onClose={() => setRotating(null)} onSaved={() => { setRotating(null); void list.reload(); }} /> : null}
      {usageOf ? <UsageDialog credential={usageOf} onClose={() => setUsageOf(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this credential?"
        message={<>The token of <strong>{deleting?.label}</strong> is erased and it is never used again. Requests it ran keep their history. This can&rsquo;t be undone.</>}
        loading={busy === "delete"}
        onConfirm={() => {
          if (!deleting) return;
          setBusy("delete");
          void deleteCredential(deleting.id).then(
            () => { toast.success("Credential deleted. Its token has been erased."); setDeleting(null); void list.reload(); },
            (error) => toast.error(problem(error, "It couldn't be deleted.")),
          ).finally(() => setBusy(null));
        }}
      />
    </div>
  );
}

function Choices({ label, options, value, onChange, hint }: {
  label: string; options: { value: string; label: string }[]; value: string[]; onChange: (next: string[]) => void; hint?: string;
}) {
  return (
    <fieldset className="text-xs">
      <legend className="mb-1 font-medium text-admin-ink">{label}</legend>
      {hint ? <p className="mb-1.5 text-admin-muted">{hint}</p> : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.length === 0 ? <span className="text-admin-muted">None available.</span> : options.map((o) => (
          <AdminCheckbox key={o.value} label={o.label} checked={value.includes(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))} />
        ))}
      </div>
    </fieldset>
  );
}

function CredentialForm({ value, providers, models, onClose, onSaved }: {
  value: Credential | null; providers: Provider[]; models: Model[]; onClose: () => void; onSaved: () => void;
}) {
  const mappings = useAdminResource(listMappings, []);
  const [form, setForm] = useState<CredentialInput>(() => value ? {
    label: value.label, hidden: value.hidden, autoSelect: value.autoSelect, priority: value.priority, scope: value.scope,
    dedicatedCustomerId: value.dedicatedCustomerId, modelIds: value.modelIds, capabilityKeys: value.capabilityKeys,
    categoryIds: value.categoryIds, dailyLimit: value.dailyLimit, monthlyLimit: value.monthlyLimit,
  } : { providerId: providers[0]?.id ?? "", secret: "", label: "", priority: 100, scope: "shared", autoSelect: true, hidden: false,
    modelIds: [], capabilityKeys: [], categoryIds: [], validateNow: true });
  const [saving, setSaving] = useState(false);
  const providerId = value?.providerId ?? form.providerId ?? "";
  const providerModels = models.filter((m) => m.providerId === providerId);
  // Only the kinds of item the chosen models (or every model of the provider) can do.
  const capabilityOptions = useMemo(() => {
    const chosen = form.modelIds?.length ? providerModels.filter((m) => form.modelIds!.includes(m.id)) : providerModels;
    return [...new Set(chosen.flatMap((m) => m.capabilities))].map((c) => ({ value: c, label: c }));
  }, [form.modelIds, providerModels]);
  const set = (patch: Partial<CredentialInput>) => setForm((f) => ({ ...f, ...patch }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form, capabilityKeys: (form.capabilityKeys ?? []).filter((c) => capabilityOptions.some((o) => o.value === c)) };
      if (value) await updateCredential(value.id, payload);
      else await addCredential(payload);
      // The token leaves the form the moment it's saved.
      set({ secret: "" });
      toast.success(value ? "Credential saved." : "Credential saved. Its token can't be shown again.");
      onSaved();
    } catch (error) {
      toast.error(problem(error, "It couldn't be saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={value ? `Edit ${value.label}` : "Add a credential"} className="max-w-2xl">
      <form onSubmit={save} className="flex flex-col gap-4" autoComplete="off">
        <FormGrid columns={2}>
          {value ? null : (
            <AdminSelect label="Provider" value={form.providerId} onChange={(e) => set({ providerId: e.target.value, modelIds: [], capabilityKeys: [] })}
              options={providers.map((p) => ({ value: p.id, label: p.name }))} />
          )}
          <AdminInput label="Name" required value={form.label ?? ""} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. HF token 3" />
          {value ? null : (
            <AdminInput label="Token" type="password" required autoComplete="new-password" spellCheck={false}
              value={form.secret ?? ""} onChange={(e) => set({ secret: e.target.value })} hint="Paste the full token. It is encrypted and can't be viewed again." />
          )}
          <AdminInput label="Priority" type="number" min={0} max={10000} value={form.priority ?? 100} onChange={(e) => set({ priority: Number(e.target.value) })} hint="Lower runs first." />
          <AdminSelect label="Who may use it" value={form.scope} onChange={(e) => set({ scope: e.target.value as "shared" | "dedicated" })}
            options={[{ value: "shared", label: "Shared by eligible customers" }, { value: "dedicated", label: "Dedicated to one customer" }]} />
          {form.scope === "dedicated" ? (
            <AdminInput label="Customer ID" required value={form.dedicatedCustomerId ?? ""} onChange={(e) => set({ dedicatedCustomerId: e.target.value.trim().toUpperCase() })}
              placeholder="CUS001" hint="Used only for this customer, and only while an allocation gives it to them." />
          ) : null}
          <AdminInput label="Daily limit" type="number" min={1} value={form.dailyLimit ?? ""} onChange={(e) => set({ dailyLimit: e.target.value ? Number(e.target.value) : null })} hint="Empty: no limit." />
          <AdminInput label="Monthly limit" type="number" min={1} value={form.monthlyLimit ?? ""} onChange={(e) => set({ monthlyLimit: e.target.value ? Number(e.target.value) : null })} hint="Empty: no limit." />
        </FormGrid>
        <Choices label="Models" value={form.modelIds ?? []} onChange={(modelIds) => set({ modelIds })} hint="None ticked: every model of the provider."
          options={providerModels.map((m) => ({ value: m.id, label: `${m.name}${m.routable ? "" : " (not in use)"}` }))} />
        <Choices label="Kinds of item" value={form.capabilityKeys ?? []} onChange={(capabilityKeys) => set({ capabilityKeys })}
          hint="Only what the chosen models support. None ticked: all of those." options={capabilityOptions} />
        <Choices label="Catalogue categories" value={form.categoryIds ?? []} onChange={(categoryIds) => set({ categoryIds })} hint="None ticked: every category."
          options={(mappings.data?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <div className="flex flex-wrap gap-6">
          {form.scope === "shared" ? <AdminToggle label="Pick automatically" checked={form.autoSelect ?? true} onChange={(autoSelect) => set({ autoSelect })} /> : null}
          <AdminToggle label="Hide from the list" description="Still used." checked={form.hidden ?? false} onChange={(hidden) => set({ hidden })} />
          {value ? null : <AdminToggle label="Check with the provider now" checked={form.validateNow ?? true} onChange={(validateNow) => set({ validateNow })} />}
        </div>
        <div className="flex justify-end gap-2">
          <AdminButton onClick={onClose} disabled={saving}>Cancel</AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving}>Save</AdminButton>
        </div>
      </form>
    </Modal>
  );
}

function BulkForm({ providers, onClose, onSaved }: { providers: Provider[]; onClose: () => void; onSaved: () => void }) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [secrets, setSecrets] = useState("");
  const [prefix, setPrefix] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ added: number; skipped: { line: number; reason: string }[] } | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const outcome = await addCredentials({ providerId, secrets, labelPrefix: prefix });
      setSecrets("");
      setResult({ added: outcome.added.length, skipped: outcome.skipped });
      onSaved();
    } catch (error) {
      toast.error(problem(error, "They couldn't be saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title="Add several credentials" className="max-w-xl">
      {result ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-admin-ink">{result.added} added.</p>
          {result.skipped.length ? (
            <ul className="list-disc pl-5 text-xs text-admin-muted">
              {result.skipped.map((s) => <li key={s.line}>Line {s.line}: {s.reason}</li>)}
            </ul>
          ) : null}
          <AdminButton variant="primary" onClick={onClose} className="self-end">Done</AdminButton>
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-4" autoComplete="off">
          <AdminSelect label="Provider" value={providerId} onChange={(e) => setProviderId(e.target.value)} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
          <AdminTextarea label="Tokens, one per line" required rows={6} spellCheck={false} value={secrets} onChange={(e) => setSecrets(e.target.value)}
            hint="Duplicates and malformed lines are skipped and reported by line number. Up to 200." className="font-mono" />
          <AdminInput label="Name prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="HF" hint="Named “HF 1”, “HF 2”…" />
          <div className="flex justify-end gap-2">
            <AdminButton onClick={onClose} disabled={saving}>Cancel</AdminButton>
            <AdminButton type="submit" variant="primary" loading={saving}>Add</AdminButton>
          </div>
        </form>
      )}
    </Modal>
  );
}

function RotateForm({ credential, onClose, onSaved }: { credential: Credential; onClose: () => void; onSaved: () => void }) {
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={`Replace the token of ${credential.label}`} className="max-w-md">
      <form autoComplete="off" className="flex flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void rotateCredential(credential.id, secret).then(
          () => { setSecret(""); toast.success("Token replaced."); onSaved(); },
          (error) => toast.error(problem(error, "It couldn't be replaced.")),
        ).finally(() => setSaving(false));
      }}>
        <p className="text-xs text-admin-muted">Current token ends in {credential.masked.slice(-4)}. Its history stays with this credential.</p>
        <AdminInput label="New token" type="password" required autoComplete="new-password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />
        <div className="flex justify-end gap-2">
          <AdminButton onClick={onClose} disabled={saving}>Cancel</AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving}>Replace</AdminButton>
        </div>
      </form>
    </Modal>
  );
}

function UsageDialog({ credential, onClose }: { credential: Credential; onClose: () => void }) {
  const usage = useAdminResource(() => credentialUsage(credential.id), [credential.id]);
  const data = usage.data;
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={`${credential.label} — usage`} className="max-w-2xl">
      {!data ? <span className="block h-32 animate-pulse rounded-[3px] bg-admin-raised" /> : (
        <div className="grid gap-4 text-xs sm:grid-cols-2">
          <div>
            <p className="mb-1 font-medium text-admin-ink">Customers</p>
            {data.customers.length ? (
              <ul className="space-y-1">{data.customers.map((c) => <li key={c.customerId}>{c.name || c.customerId} ({c.customerId}) — {c.requests} requests, {c.succeeded} ok</li>)}</ul>
            ) : <p className="text-admin-muted">No requests yet.</p>}
          </div>
          <div>
            <p className="mb-1 font-medium text-admin-ink">Plans</p>
            {data.plans.length ? <ul className="space-y-1">{data.plans.map((p) => <li key={`${p.source}-${p.plan}`}>{p.plan} ({p.source}) — {p.requests}</li>)}</ul> : <p className="text-admin-muted">—</p>}
            {credential.rateLimitInfo ? <p className="mt-3 text-admin-muted">Provider says: {Object.entries(credential.rateLimitInfo).map(([k, v]) => `${k}: ${v}`).join(" · ")}</p> : null}
          </div>
          <div className="sm:col-span-2">
            <p className="mb-1 font-medium text-admin-ink">Recent health checks</p>
            {data.healthChecks.length ? (
              <ul className="space-y-1">{data.healthChecks.map((h) => <li key={h.checkedAt}>{formatDateTime(h.checkedAt)} — {h.ok ? "accepted" : `${h.code}: ${h.detail}`} ({h.latencyMs} ms)</li>)}</ul>
            ) : <p className="text-admin-muted">Never checked.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}
