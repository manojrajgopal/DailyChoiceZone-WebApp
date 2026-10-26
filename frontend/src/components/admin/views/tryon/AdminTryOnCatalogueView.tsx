"use client";

import { useState } from "react";
import { FlaskConical, Plus } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminTextarea, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { TD, TH, problem } from "@/components/admin/views/operations/shared";
import { CRUMBS, TryOnTabs } from "@/components/admin/views/tryon/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { useAdminSession } from "@/hooks/useAdminSession";
import { formatDateTime } from "@/lib/support/format";
import {
  type Capability,
  type Model,
  type Provider,
  checkProvider,
  deleteMapping,
  deleteModel,
  listAdapters,
  listCapabilities,
  listMappings,
  listModels,
  listProviders,
  saveCapability,
  saveMapping,
  saveModel,
  saveProvider,
  testModel,
} from "@/services/admin/tryOnAdminService";
import { toast } from "@/store/toastStore";

const CAPABILITY_STATE: Record<string, { label: string; tone: "good" | "warning" | "neutral" | "info" }> = {
  available: { label: "Available", tone: "good" },
  unavailable: { label: "No model running it", tone: "warning" },
  coming_soon: { label: "Coming soon", tone: "info" },
  unsupported: { label: "Off", tone: "neutral" },
};

/**
 * What can be tried on and what runs it: kinds of item (capabilities), the
 * catalogue categories mapped to them, the AI providers, and their models.
 * A model is used for customers only when enabled **and** verified.
 */
export function AdminTryOnCatalogueView() {
  const { can } = useAdminSession();
  const capabilities = useAdminResource(listCapabilities, []);
  const mappings = useAdminResource(listMappings, []);
  const providers = useAdminResource(listProviders, []);
  const models = useAdminResource(listModels, []);
  const adapters = useAdminResource(listAdapters, []);
  const [editingCapability, setEditingCapability] = useState<Capability | "new" | null>(null);
  const [editingModel, setEditingModel] = useState<Model | "new" | null>(null);
  const [testing, setTesting] = useState<Model | null>(null);
  const [removing, setRemoving] = useState<Model | null>(null);
  const [mapping, setMapping] = useState({ categoryId: "", subcategory: "", capabilityKey: "" });
  const capabilityName = (key: string) => capabilities.data?.find((c) => c.key === key)?.name ?? key;
  const categories = mappings.data?.categories ?? [];
  const chosenCategory = categories.find((c) => c.id === mapping.categoryId);
  const reloadAll = () => { void capabilities.reload(); void mappings.reload(); void models.reload(); void providers.reload(); };

  const addMapping = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await saveMapping(mapping);
      toast.success("Category mapped.");
      setMapping({ categoryId: "", subcategory: "", capabilityKey: "" });
      void mappings.reload();
    } catch (error) {
      toast.error(problem(error, "It couldn't be mapped."));
    }
  };

  return (
    <div>
      <AdminPageHeader title="Models & categories" description="Kinds of try-on, the categories that use them, and the AI models that run them."
        breadcrumbs={[...CRUMBS, { label: "Models & categories" }]} />
      <TryOnTabs />

      <div className="grid gap-5">
        <AdminCard title="Kinds of try-on" description="Each has its own photo requirements. Customers only see “Try it on” for an available kind."
          padded={false} action={<AdminButton size="sm" onClick={() => setEditingCapability("new")}><Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add</AdminButton>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-xs">
              <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                <tr><th className={TH}>Kind</th><th className={TH}>Photo</th><th className={TH}>Status</th><th className={TH}>For customers</th><th className={TH} /></tr>
              </thead>
              <tbody className="divide-y divide-admin-border">
                {capabilities.data?.map((c) => (
                  <tr key={c.key} className="align-top">
                    <td className={TD}><span className="font-medium text-admin-ink">{c.name}</span><span className="block font-mono text-admin-muted">{c.key}</span></td>
                    <td className={TD}>{c.subjectKind.replace("_", " ")}{c.inputRules.minWidth ? <span className="block text-admin-muted">min {c.inputRules.minWidth}×{c.inputRules.minHeight}</span> : null}</td>
                    <td className={TD}>{c.status.replace("_", " ")}</td>
                    <td className={TD}><StatusBadge tone={CAPABILITY_STATE[c.state]?.tone ?? "neutral"}>{CAPABILITY_STATE[c.state]?.label ?? c.state}</StatusBadge></td>
                    <td className={`${TD} text-right`}><AdminButton size="sm" variant="ghost" onClick={() => setEditingCapability(c)}>Edit</AdminButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>

        <AdminCard title="Categories" description="Which catalogue categories (or subcategories) use which kind of try-on. A subcategory mapping wins over its category's.">
          <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={addMapping}>
            <AdminSelect label="Category" value={mapping.categoryId} onChange={(e) => setMapping({ ...mapping, categoryId: e.target.value, subcategory: "" })}
              placeholder="Choose…" options={categories.map((c) => ({ value: c.id, label: c.name }))} className="w-48" />
            <AdminSelect label="Subcategory" value={mapping.subcategory} onChange={(e) => setMapping({ ...mapping, subcategory: e.target.value })}
              placeholder="Whole category" options={(chosenCategory?.subcategories ?? []).map((s) => ({ value: s.slug, label: s.name }))} className="w-48" />
            <AdminSelect label="Kind of try-on" value={mapping.capabilityKey} onChange={(e) => setMapping({ ...mapping, capabilityKey: e.target.value })}
              placeholder="Choose…" options={(capabilities.data ?? []).map((c) => ({ value: c.key, label: `${c.name}${c.state === "available" ? "" : ` (${CAPABILITY_STATE[c.state]?.label.toLowerCase()})`}` }))} className="w-64" />
            <AdminButton type="submit" variant="primary" disabled={!mapping.categoryId || !mapping.capabilityKey}>Map</AdminButton>
          </form>
          <table className="w-full text-left text-xs">
            <tbody className="divide-y divide-admin-border">
              {mappings.data?.items.length ? mappings.data.items.map((m) => {
                const category = categories.find((c) => c.id === m.categoryId);
                return (
                  <tr key={m.id}>
                    <td className={TD}>{category?.name ?? m.categoryId}{m.subcategory ? ` › ${category?.subcategories.find((s) => s.slug === m.subcategory)?.name ?? m.subcategory}` : " (all)"}</td>
                    <td className={TD}>{capabilityName(m.capabilityKey)}</td>
                    <td className={TD}><AdminToggle label={m.enabled ? "On" : "Off"} checked={m.enabled}
                      onChange={(enabled) => void saveMapping({ enabled }, m.id).then(() => void mappings.reload(), (e) => toast.error(problem(e, "Not saved.")))} /></td>
                    <td className={`${TD} text-right`}><AdminButton size="sm" variant="ghost"
                      onClick={() => void deleteMapping(m.id).then(() => { toast.success("Mapping removed."); void mappings.reload(); }, (e) => toast.error(problem(e, "Not removed.")))}>Remove</AdminButton></td>
                  </tr>
                );
              }) : <tr><td className={TD}><span className="text-admin-muted">No categories mapped yet: no product offers try-on.</span></td></tr>}
            </tbody>
          </table>
        </AdminCard>

        <AdminCard title="Providers" padded={false}>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr><th className={TH}>Provider</th><th className={TH}>Health</th><th className={TH}>Timeout · retries · rest</th><th className={TH}>On</th><th className={TH} /></tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              {providers.data?.map((p) => <ProviderRow key={p.id} provider={p} canCheck={can("manage:tryOnCredentials")} onChanged={() => void providers.reload()} />)}
            </tbody>
          </table>
        </AdminCard>

        <AdminCard title="Models" description="Only enabled and verified models are used. Verify a model with “Test” before enabling it for customers." padded={false}
          action={<AdminButton size="sm" onClick={() => setEditingModel("new")}><Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add model</AdminButton>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-left text-xs">
              <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                <tr><th className={TH}>Model</th><th className={TH}>Adapter</th><th className={TH}>Can try on</th><th className={TH}>State</th><th className={TH}>Avg · cost</th><th className={TH} /></tr>
              </thead>
              <tbody className="divide-y divide-admin-border">
                {models.data?.map((m) => (
                  <tr key={m.id} className="align-top">
                    <td className={TD}><span className="font-medium text-admin-ink">{m.name}</span><span className="block text-admin-muted">{m.id} · priority {m.priority} · {m.qualityTier}</span>
                      {m.description ? <span className="block max-w-xs text-admin-muted">{m.description}</span> : null}</td>
                    <td className={TD}>{m.adapterLabel}{m.adapterAvailable ? null : <span className="block text-[#a32424]">Not available on this server</span>}</td>
                    <td className={TD}>{m.capabilities.map(capabilityName).join(", ") || "—"}</td>
                    <td className={TD}><StatusBadge tone={m.routable ? "good" : m.enabled ? "warning" : "neutral"}>{m.routable ? "In use" : m.enabled ? "Enabled, not verified" : "Disabled"}</StatusBadge></td>
                    <td className={TD}>{m.avgSeconds}s{m.costPerCall !== null ? <span className="block text-admin-muted">{m.costCurrency} {m.costPerCall}/call</span> : null}</td>
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      {can("manage:tryOnCredentials") ? <AdminButton size="sm" variant="ghost" onClick={() => setTesting(m)}><FlaskConical className="h-3.5 w-3.5" aria-hidden="true" /> Test</AdminButton> : null}
                      <AdminButton size="sm" variant="ghost" onClick={() => setEditingModel(m)}>Edit</AdminButton>
                      <AdminButton size="sm" variant="ghost" onClick={() => setRemoving(m)}>Delete</AdminButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>
      </div>

      {editingCapability ? <CapabilityForm value={editingCapability === "new" ? null : editingCapability} onClose={() => setEditingCapability(null)} onSaved={() => { setEditingCapability(null); reloadAll(); }} /> : null}
      {editingModel ? (
        <ModelForm value={editingModel === "new" ? null : editingModel} providers={providers.data ?? []} capabilities={capabilities.data ?? []}
          adapters={adapters.data?.adapters ?? []} onClose={() => setEditingModel(null)} onSaved={() => { setEditingModel(null); reloadAll(); }} />
      ) : null}
      {testing ? <TestDialog model={testing} capabilities={capabilities.data ?? []} onClose={() => setTesting(null)} /> : null}
      <ConfirmDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)} title="Delete this model?"
        message="A model that has run requests is disabled instead, so its history keeps its name."
        onConfirm={() => {
          if (!removing) return;
          void deleteModel(removing.id).then((r) => { toast.success(r.outcome === "deleted" ? "Model deleted." : "Model disabled."); setRemoving(null); reloadAll(); },
            (e) => toast.error(problem(e, "Not deleted.")));
        }} />
    </div>
  );
}

function ProviderRow({ provider, canCheck, onChanged }: { provider: Provider; canCheck: boolean; onChanged: () => void }) {
  const [form, setForm] = useState({ timeoutSeconds: provider.timeoutSeconds, maxRetries: provider.maxRetries, cooldownSeconds: provider.cooldownSeconds });
  const [busy, setBusy] = useState(false);
  const save = (patch: Partial<Provider>) =>
    void saveProvider(patch, provider.id).then(() => { toast.success("Provider saved."); onChanged(); }, (e) => toast.error(problem(e, "Not saved.")));
  return (
    <tr className="align-top">
      <td className={TD}><span className="font-medium text-admin-ink">{provider.name}</span><span className="block text-admin-muted">{provider.id} · {provider.kind}</span></td>
      <td className={TD}><StatusBadge tone={provider.health === "healthy" ? "good" : provider.health === "degraded" ? "warning" : provider.health === "down" ? "critical" : "neutral"}>
        {provider.health === "unknown" ? "Not checked" : provider.health}</StatusBadge>
        {provider.healthDetail ? <span className="mt-1 block text-admin-muted">{provider.healthDetail}</span> : null}
        {provider.lastCheckedAt ? <span className="block text-admin-faint">{formatDateTime(provider.lastCheckedAt)}</span> : null}</td>
      <td className={TD}>
        <div className="flex gap-1.5">
          <input aria-label="Timeout seconds" type="number" min={10} max={600} value={form.timeoutSeconds} onChange={(e) => setForm({ ...form, timeoutSeconds: Number(e.target.value) })} className="h-8 w-16 rounded-[3px] border border-admin-border px-1.5" />
          <input aria-label="Retries" type="number" min={0} max={5} value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })} className="h-8 w-12 rounded-[3px] border border-admin-border px-1.5" />
          <input aria-label="Rest after a rate limit, seconds" type="number" min={60} max={86400} value={form.cooldownSeconds} onChange={(e) => setForm({ ...form, cooldownSeconds: Number(e.target.value) })} className="h-8 w-20 rounded-[3px] border border-admin-border px-1.5" />
          <AdminButton size="sm" variant="ghost" onClick={() => save(form)}>Save</AdminButton>
        </div>
      </td>
      <td className={TD}><AdminToggle label={provider.enabled ? "On" : "Off"} checked={provider.enabled} onChange={(enabled) => save({ enabled })} /></td>
      <td className={`${TD} text-right`}>
        {canCheck ? <AdminButton size="sm" variant="ghost" loading={busy} onClick={() => {
          setBusy(true);
          void checkProvider(provider.id).then((p) => { toast.info(p.healthDetail || p.health); onChanged(); }, (e) => toast.error(problem(e, "Check failed."))).finally(() => setBusy(false));
        }}>Check health</AdminButton> : null}
      </td>
    </tr>
  );
}

function CapabilityForm({ value, onClose, onSaved }: { value: Capability | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Partial<Capability> & { guidanceText?: string }>(() => value
    ? { ...value, guidanceText: value.guidance.join("\n") }
    : { key: "", name: "", family: "", description: "", subjectKind: "half_body", status: "disabled", inputRules: { minWidth: 400, minHeight: 400, maxMegapixels: 40 }, guidanceText: "" });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const rules = form.inputRules ?? {};
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={value ? `Edit ${value.name}` : "Add a kind of try-on"} className="max-w-xl">
      <form className="flex flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        const { guidanceText, state: _state, ...rest } = form;
        void _state;
        void saveCapability({ ...rest, guidance: (guidanceText ?? "").split("\n").map((t) => t.trim()).filter(Boolean) }, value?.key).then(
          () => { toast.success("Saved."); onSaved(); }, (e) => toast.error(problem(e, "Not saved."))).finally(() => setSaving(false));
      }}>
        <FormGrid columns={2}>
          {value ? null : <AdminInput label="Key" required value={form.key ?? ""} onChange={(e) => set({ key: e.target.value })} placeholder="eyewear.frames" />}
          <AdminInput label="Name" required value={form.name ?? ""} onChange={(e) => set({ name: e.target.value })} />
          <AdminInput label="Family" value={form.family ?? ""} onChange={(e) => set({ family: e.target.value })} placeholder="garment, eyewear, wrist…" />
          <AdminSelect label="The customer's photo shows" value={form.subjectKind} onChange={(e) => set({ subjectKind: e.target.value })}
            options={[["half_body", "Head to hips"], ["full_body", "Whole body"], ["face", "Face"], ["wrist", "Wrist"], ["foot", "Feet"], ["hand", "Hand"]].map(([v, l]) => ({ value: v!, label: l! }))} />
          <AdminSelect label="Status" value={form.status} onChange={(e) => set({ status: e.target.value as Capability["status"] })}
            options={[{ value: "enabled", label: "Enabled" }, { value: "disabled", label: "Disabled" }, { value: "coming_soon", label: "Coming soon" }]}
            hint="Enabled shows only when a verified model runs it." />
          <AdminInput label="Minimum width (px)" type="number" min={0} value={rules.minWidth ?? ""} onChange={(e) => set({ inputRules: { ...rules, minWidth: Number(e.target.value) } })} />
          <AdminInput label="Minimum height (px)" type="number" min={0} value={rules.minHeight ?? ""} onChange={(e) => set({ inputRules: { ...rules, minHeight: Number(e.target.value) } })} />
        </FormGrid>
        <AdminTextarea label="Description" rows={2} value={form.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
        <AdminTextarea label="Photo tips, one per line" rows={4} value={form.guidanceText ?? ""} onChange={(e) => set({ guidanceText: e.target.value })} />
        <div className="flex justify-end gap-2"><AdminButton onClick={onClose}>Cancel</AdminButton><AdminButton type="submit" variant="primary" loading={saving}>Save</AdminButton></div>
      </form>
    </Modal>
  );
}

function ModelForm({ value, providers, capabilities, adapters, onClose, onSaved }: {
  value: Model | null; providers: Provider[]; capabilities: Capability[];
  adapters: { key: string; providerKind: string; label: string; maxCapabilities: string[] }[]; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<Partial<Model> & { configText: string }>(() => value
    ? { ...value, configText: JSON.stringify(value.config, null, 2) }
    : { providerId: providers[0]?.id ?? "", adapterKey: "", name: "", description: "", capabilities: [], qualityTier: "standard", priority: 100, avgSeconds: 45,
        enabled: false, verified: false, costPerCall: null, costCurrency: "USD", configText: "{}" });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const provider = providers.find((p) => p.id === form.providerId);
  const adapter = adapters.find((a) => a.key === form.adapterKey);
  const allowedKinds = capabilities.filter((c) => !adapter || adapter.maxCapabilities.includes("*") || adapter.maxCapabilities.includes(c.key));

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={value ? `Edit ${value.name}` : "Add a model"} className="max-w-2xl">
      <form className="flex flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        let config: Record<string, unknown>;
        try {
          config = JSON.parse(form.configText || "{}");
        } catch {
          toast.error("The configuration isn't valid JSON.");
          return;
        }
        setSaving(true);
        const { configText: _c, adapterLabel: _l, adapterAvailable: _a, routable: _r, id: _id, ...rest } = form;
        void [_c, _l, _a, _r, _id];
        void saveModel({ ...rest, config }, value?.id).then(() => { toast.success("Model saved."); onSaved(); }, (e) => toast.error(problem(e, "Not saved.")))
          .finally(() => setSaving(false));
      }}>
        <FormGrid columns={2}>
          {value ? null : (
            <>
              <AdminSelect label="Provider" value={form.providerId} onChange={(e) => set({ providerId: e.target.value, adapterKey: "" })} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
              <AdminSelect label="Adapter" value={form.adapterKey} onChange={(e) => set({ adapterKey: e.target.value, capabilities: [] })} placeholder="Choose…"
                options={adapters.filter((a) => a.providerKind === provider?.kind).map((a) => ({ value: a.key, label: a.label }))} />
            </>
          )}
          <AdminInput label="Name" required value={form.name ?? ""} onChange={(e) => set({ name: e.target.value })} />
          <AdminInput label="Quality tier" value={form.qualityTier ?? ""} onChange={(e) => set({ qualityTier: e.target.value })} hint="What plans' quality options name, e.g. standard, hd." />
          <AdminInput label="Priority" type="number" min={0} value={form.priority ?? 100} onChange={(e) => set({ priority: Number(e.target.value) })} hint="Lower is tried first." />
          <AdminInput label="Typical seconds" type="number" min={1} value={form.avgSeconds ?? 45} onChange={(e) => set({ avgSeconds: Number(e.target.value) })} />
          <AdminInput label="Cost per call" type="number" min={0} step="0.0001" value={form.costPerCall ?? ""} onChange={(e) => set({ costPerCall: e.target.value === "" ? null : Number(e.target.value) })} hint="Optional; used for the dashboard estimate." />
          <AdminInput label="Currency" value={form.costCurrency ?? "USD"} onChange={(e) => set({ costCurrency: e.target.value })} />
        </FormGrid>
        <AdminTextarea label="Description" rows={2} value={form.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
        <fieldset className="text-xs">
          <legend className="mb-1 font-medium text-admin-ink">Can try on</legend>
          <p className="mb-1.5 text-admin-muted">Only what this adapter can do, and only what you have tested.</p>
          <div className="flex flex-wrap gap-x-4">
            {allowedKinds.map((c) => (
              <AdminCheckbox key={c.key} label={c.name} checked={form.capabilities?.includes(c.key) ?? false}
                onChange={(e) => set({ capabilities: e.target.checked ? [...(form.capabilities ?? []), c.key] : (form.capabilities ?? []).filter((k) => k !== c.key) })} />
            ))}
          </div>
        </fieldset>
        <AdminTextarea label="Endpoint configuration (JSON)" rows={6} className="font-mono" value={form.configText} onChange={(e) => set({ configText: e.target.value })}
          hint='e.g. {"space": "owner/name", "apiName": "/process_hd", "params": {"n_steps": 20}}' />
        <div className="flex flex-wrap gap-6">
          <AdminToggle label="Enabled" checked={form.enabled ?? false} onChange={(enabled) => set({ enabled })} />
          <AdminToggle label="Verified" description="Tested with real credentials and products." checked={form.verified ?? false} onChange={(verified) => set({ verified })} />
        </div>
        <div className="flex justify-end gap-2"><AdminButton onClick={onClose}>Cancel</AdminButton><AdminButton type="submit" variant="primary" loading={saving}>Save</AdminButton></div>
      </form>
    </Modal>
  );
}

function TestDialog({ model, capabilities, onClose }: { model: Model; capabilities: Capability[]; onClose: () => void }) {
  const [person, setPerson] = useState<File | null>(null);
  const [garment, setGarment] = useState<File | null>(null);
  const [capability, setCapability] = useState(model.capabilities[0] ?? "");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof testModel>> | null>(null);
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={`Test ${model.name}`} description="One generation with your own photos. Nothing is stored." className="max-w-xl">
      <form className="flex flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        if (!person || !garment) return;
        setRunning(true);
        setResult(null);
        void testModel(model.id, { person, garment, capability }).then(setResult, (e) => toast.error(problem(e, "The test couldn't run."))).finally(() => setRunning(false));
      }}>
        <label className="text-xs text-admin-ink">Photo of a person<input type="file" accept="image/jpeg,image/png,image/webp" className="mt-1 block text-xs" onChange={(e) => setPerson(e.target.files?.[0] ?? null)} /></label>
        <label className="text-xs text-admin-ink">Photo of the item<input type="file" accept="image/jpeg,image/png,image/webp" className="mt-1 block text-xs" onChange={(e) => setGarment(e.target.files?.[0] ?? null)} /></label>
        <AdminSelect label="Kind of try-on" value={capability} onChange={(e) => setCapability(e.target.value)}
          options={capabilities.filter((c) => model.capabilities.includes(c.key) || model.adapterKey === "huggingface.ootd_full_body").map((c) => ({ value: c.key, label: c.name }))} />
        {result ? (
          result.ok && result.image ? (
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element -- an inline test result */}
              <img src={result.image} alt="Test result" className="max-h-96 w-full rounded-[3px] object-contain" />
              <p className="mt-1 text-xs text-admin-muted">Took {(result.latencyMs / 1000).toFixed(1)}s. If it looks right, mark the model verified.</p>
            </div>
          ) : (
            <p className="rounded-[3px] bg-[#fbeaea] p-3 text-xs text-[#a32424]" role="alert">{result.explanation} {result.detail ? `(${result.detail})` : ""}</p>
          )
        ) : null}
        <div className="flex justify-end gap-2"><AdminButton onClick={onClose}>Close</AdminButton>
          <AdminButton type="submit" variant="primary" loading={running} disabled={!person || !garment || !capability}>Run test</AdminButton></div>
      </form>
    </Modal>
  );
}
