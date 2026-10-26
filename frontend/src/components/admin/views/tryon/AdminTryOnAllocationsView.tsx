"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminTextarea, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusTabs } from "@/components/admin/ui/LogPage";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { TD, TH, TableState, problem } from "@/components/admin/views/operations/shared";
import { CRUMBS, TryOnTabs } from "@/components/admin/views/tryon/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { useAdminSession } from "@/hooks/useAdminSession";
import { formatDateTime } from "@/lib/support/format";
import {
  type AccessRequest,
  type Allocation,
  type AllocationInput,
  decideAccessRequest,
  createAllocation,
  listAccessRequests,
  listAllocations,
  listCapabilities,
  listCredentials,
  revokeAllocation,
  updateAllocation,
} from "@/services/admin/tryOnAdminService";
import { toast } from "@/store/toastStore";

const REQUEST_TONE: Record<string, "warning" | "good" | "critical" | "neutral"> = { pending: "warning", approved: "good", rejected: "critical", withdrawn: "neutral" };
const ALLOCATION_TONE: Record<string, "good" | "neutral" | "critical" | "warning"> = { active: "good", disabled: "warning", revoked: "critical", expired: "neutral" };

/**
 * Customers asking for more (or dedicated) try-on access, and the
 * allocations the store has granted. A dedicated credential serves only the
 * customer it is dedicated to, and only while an active allocation names it.
 */
export function AdminTryOnAllocationsView() {
  const [requestStatus, setRequestStatus] = useState("pending");
  const [allocationStatus, setAllocationStatus] = useState("active");
  const requests = useAdminResource(() => listAccessRequests({ status: requestStatus, pageSize: 50 }), [requestStatus]);
  const allocations = useAdminResource(() => listAllocations({ status: allocationStatus, pageSize: 50 }), [allocationStatus]);
  const [deciding, setDeciding] = useState<{ request: AccessRequest; decision: "approve" | "reject" } | null>(null);
  const [editing, setEditing] = useState<Allocation | "new" | null>(null);
  const [revoking, setRevoking] = useState<Allocation | null>(null);

  return (
    <div>
      <AdminPageHeader title="Access & allocations" description="Requests for extra try-ons or dedicated capacity, and what has been granted."
        breadcrumbs={[...CRUMBS, { label: "Access & allocations" }]}
        actions={<AdminButton size="sm" variant="primary" onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5" aria-hidden="true" /> New allocation</AdminButton>} />
      <TryOnTabs />

      <h2 className="mb-2 text-sm font-semibold text-admin-ink">Requests</h2>
      <StatusTabs label="Which requests" value={requestStatus} onChange={setRequestStatus}
        tabs={[{ value: "pending", label: "Waiting", count: requests.data?.counts?.pending }, { value: "approved", label: "Approved" },
          { value: "rejected", label: "Rejected" }, { value: "withdrawn", label: "Withdrawn" }, { value: "", label: "All" }]} />
      <AdminCard padded={false} className="mb-6">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-xs">
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr><th className={TH}>Request</th><th className={TH}>Customer</th><th className={TH}>Asking for</th><th className={TH}>Why</th><th className={TH}>Status</th><th className={TH} /></tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={6} loading={requests.isLoading && !requests.data} failed={Boolean(requests.error && !requests.data)}
                empty={Boolean(requests.data && !requests.data.items.length)} onRetry={() => void requests.reload()} title="Nothing here" hint="Customers ask from their try-on page." />
              {requests.data?.items.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className={TD}><span className="font-medium text-admin-ink">{r.id}</span><span className="block text-admin-muted">{formatDateTime(r.createdAt)}</span></td>
                  <td className={TD}><Link href={`/admin/customers/detail?id=${encodeURIComponent(r.customerId)}`} className="hover:text-copper-700">{r.customerId}</Link></td>
                  <td className={TD}>{r.kind === "dedicated" ? "Dedicated capacity" : "More try-ons"}<span className="block text-admin-muted">~{r.expectedUsage} try-ons{r.startsOn || r.endsOn ? ` · ${r.startsOn ?? "now"} → ${r.endsOn ?? "open"}` : ""}</span>
                    {r.capabilities.length ? <span className="block text-admin-muted">{r.capabilities.join(", ")}</span> : null}</td>
                  <td className={TD}><span className="block max-w-xs">{r.reason}</span>{r.message ? <span className="block max-w-xs text-admin-muted">{r.message}</span> : null}</td>
                  <td className={TD}><StatusBadge tone={REQUEST_TONE[r.status] ?? "neutral"}>{r.status}</StatusBadge>{r.decisionNote ? <span className="mt-1 block text-admin-muted">{r.decisionNote}</span> : null}</td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    {r.status === "pending" ? (
                      <>
                        <AdminButton size="sm" variant="primary" onClick={() => setDeciding({ request: r, decision: "approve" })}>Approve</AdminButton>
                        <AdminButton size="sm" variant="ghost" onClick={() => setDeciding({ request: r, decision: "reject" })}>Reject</AdminButton>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <h2 className="mb-2 text-sm font-semibold text-admin-ink">Allocations</h2>
      <StatusTabs label="Which allocations" value={allocationStatus} onChange={setAllocationStatus}
        tabs={[{ value: "active", label: "Active" }, { value: "disabled", label: "Paused" }, { value: "revoked", label: "Revoked" }, { value: "expired", label: "Expired" }, { value: "", label: "All" }]} />
      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-xs">
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr><th className={TH}>Allocation</th><th className={TH}>Customer</th><th className={TH}>Grants</th><th className={TH}>Used</th><th className={TH}>Period</th><th className={TH}>Status</th><th className={TH} /></tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={7} loading={allocations.isLoading && !allocations.data} failed={Boolean(allocations.error && !allocations.data)}
                empty={Boolean(allocations.data && !allocations.data.items.length)} onRetry={() => void allocations.reload()} title="No allocations" hint="Approve a request or create one." />
              {allocations.data?.items.map((a) => (
                <tr key={a.id} className="align-top">
                  <td className={TD}><span className="font-medium text-admin-ink">{a.id}</span>{a.requestId ? <span className="block text-admin-muted">from {a.requestId}</span> : null}</td>
                  <td className={TD}><Link href={`/admin/customers/detail?id=${encodeURIComponent(a.customerId)}`} className="hover:text-copper-700">{a.customerId}</Link></td>
                  <td className={TD}>{a.generations === null ? "No cap" : `${a.generations} try-ons`}{a.perDay ? `, ${a.perDay}/day` : ""}
                    {a.dedicated ? <span className="block text-admin-muted">Dedicated: {a.credentialLabel || a.credentialId}</span> : null}
                    {a.capabilities.length ? <span className="block text-admin-muted">{a.capabilities.join(", ")}</span> : null}</td>
                  <td className={`${TD} tabular-nums`}>{a.used}{a.remaining !== null ? <span className="block text-admin-muted">{a.remaining} left</span> : null}</td>
                  <td className={`${TD} whitespace-nowrap text-admin-muted`}>{formatDateTime(a.startsAt)}<span className="block">→ {a.endsAt ? formatDateTime(a.endsAt) : "open"}</span></td>
                  <td className={TD}><StatusBadge tone={ALLOCATION_TONE[a.status] ?? "neutral"}>{a.status}</StatusBadge>{a.note ? <span className="mt-1 block max-w-[12rem] text-admin-muted">{a.note}</span> : null}</td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    {a.status === "active" || a.status === "disabled" ? (
                      <>
                        <AdminButton size="sm" variant="ghost" onClick={() => setEditing(a)}>Edit</AdminButton>
                        <AdminButton size="sm" variant="ghost" onClick={() => void updateAllocation(a.id, { status: a.status === "active" ? "disabled" : "active" })
                          .then(() => void allocations.reload(), (e) => toast.error(problem(e, "Not saved.")))}>{a.status === "active" ? "Pause" : "Resume"}</AdminButton>
                        <AdminButton size="sm" variant="ghost" onClick={() => setRevoking(a)}>Revoke</AdminButton>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {deciding ? (
        <DecisionDialog value={deciding} onClose={() => setDeciding(null)}
          onDone={() => { setDeciding(null); void requests.reload(); void allocations.reload(); }} />
      ) : null}
      {editing ? (
        <AllocationForm value={editing === "new" ? null : editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void allocations.reload(); }} />
      ) : null}
      <ConfirmDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)} title="Revoke this allocation?"
        message="The customer loses this access at once, and any dedicated credential stops serving them. They are told." confirmLabel="Revoke"
        onConfirm={() => {
          if (!revoking) return;
          void revokeAllocation(revoking.id).then(() => { toast.success("Revoked."); setRevoking(null); void allocations.reload(); }, (e) => toast.error(problem(e, "Not revoked.")));
        }} />
    </div>
  );
}

function AllocationFields({ form, set, customerFixed }: { form: AllocationInput; set: (patch: Partial<AllocationInput>) => void; customerFixed?: string }) {
  const { can } = useAdminSession();
  const capabilities = useAdminResource(listCapabilities, []);
  const customerId = customerFixed ?? form.customerId ?? "";
  const credentials = useAdminResource(() => listCredentials({ includeHidden: true }), [], { enabled: can("manage:tryOnCredentials") });
  const dedicated = (credentials.data?.items ?? []).filter((c) => c.scope === "dedicated" && c.dedicatedCustomerId === customerId);
  return (
    <div className="flex flex-col gap-4">
      <FormGrid columns={2}>
        {customerFixed ? null : <AdminInput label="Customer ID" required value={form.customerId ?? ""} onChange={(e) => set({ customerId: e.target.value.trim().toUpperCase() })} placeholder="CUS001" />}
        <AdminSelect label="Kind" value={form.kind ?? "allowance"} onChange={(e) => set({ kind: e.target.value as AllocationInput["kind"] })}
          options={[{ value: "allowance", label: "Extra try-ons (shared capacity)" }, { value: "dedicated_credential", label: "Dedicated credential" }]} />
        {form.kind === "dedicated_credential" ? (
          <AdminSelect label="Dedicated credential" value={form.credentialId ?? ""} onChange={(e) => set({ credentialId: e.target.value })} placeholder="Choose…"
            options={dedicated.map((c) => ({ value: c.id, label: `${c.label} (${c.masked})` }))}
            hint={dedicated.length ? undefined : "Mark a credential as dedicated to this customer first (Credentials)."} />
        ) : null}
        <AdminInput label="Try-ons granted" type="number" min={1} value={form.generations ?? ""} onChange={(e) => set({ generations: e.target.value ? Number(e.target.value) : null })} hint="Empty: no cap of its own." />
        <AdminInput label="Per day" type="number" min={1} value={form.perDay ?? ""} onChange={(e) => set({ perDay: e.target.value ? Number(e.target.value) : null })} />
        <AdminInput label="From" type="date" value={form.startsOn ?? ""} onChange={(e) => set({ startsOn: e.target.value || null })} />
        <AdminInput label="Until" type="date" value={form.endsOn ?? ""} onChange={(e) => set({ endsOn: e.target.value || null })} hint="Empty: until revoked." />
      </FormGrid>
      <fieldset className="text-xs">
        <legend className="mb-1 font-medium text-admin-ink">Kinds of item</legend>
        <div className="flex flex-wrap gap-x-4">
          {(capabilities.data ?? []).filter((c) => c.state === "available").map((c) => (
            <AdminCheckbox key={c.key} label={c.name} checked={form.capabilities?.includes(c.key) ?? false}
              onChange={(e) => set({ capabilities: e.target.checked ? [...(form.capabilities ?? []), c.key] : (form.capabilities ?? []).filter((k) => k !== c.key) })} />
          ))}
        </div>
      </fieldset>
      <AdminTextarea label="Note" rows={2} value={form.note ?? ""} onChange={(e) => set({ note: e.target.value })} />
    </div>
  );
}

function DecisionDialog({ value, onClose, onDone }: { value: { request: AccessRequest; decision: "approve" | "reject" }; onClose: () => void; onDone: () => void }) {
  const { request, decision } = value;
  const [note, setNote] = useState("");
  const [allocation, setAllocation] = useState<AllocationInput>({
    kind: request.kind === "dedicated" ? "dedicated_credential" : "allowance", generations: request.expectedUsage || null,
    capabilities: request.capabilities, startsOn: request.startsOn, endsOn: request.endsOn,
  });
  const [saving, setSaving] = useState(false);
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={decision === "approve" ? `Approve ${request.id}` : `Reject ${request.id}`} className="max-w-xl">
      <form className="flex flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void decideAccessRequest(request.id, decision, { note, allocation: decision === "approve" ? allocation : undefined })
          .then(() => { toast.success(decision === "approve" ? "Approved — the customer has been told." : "Rejected — the customer has been told."); onDone(); },
            (e) => toast.error(problem(e, "Not saved."))).finally(() => setSaving(false));
      }}>
        {decision === "approve" ? <AllocationFields form={allocation} set={(patch) => setAllocation((a) => ({ ...a, ...patch }))} customerFixed={request.customerId} /> : null}
        <AdminTextarea label="Message to the customer (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex justify-end gap-2"><AdminButton onClick={onClose}>Cancel</AdminButton>
          <AdminButton type="submit" variant={decision === "approve" ? "primary" : "danger"} loading={saving}>{decision === "approve" ? "Approve" : "Reject"}</AdminButton></div>
      </form>
    </Modal>
  );
}

function AllocationForm({ value, onClose, onSaved }: { value: Allocation | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<AllocationInput>(() => value ? {
    kind: value.kind, credentialId: value.credentialId, generations: value.generations, perDay: value.perDay, capabilities: value.capabilities,
    startsOn: value.startsAt.slice(0, 10), endsOn: value.endsAt ? value.endsAt.slice(0, 10) : null, note: value.note,
  } : { kind: "allowance", generations: 10, capabilities: [] });
  const [saving, setSaving] = useState(false);
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={value ? `Edit ${value.id}` : "New allocation"} className="max-w-xl">
      <form className="flex flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void (value ? updateAllocation(value.id, form) : createAllocation(form))
          .then(() => { toast.success("Allocation saved."); onSaved(); }, (e) => toast.error(problem(e, "Not saved."))).finally(() => setSaving(false));
      }}>
        <AllocationFields form={form} set={(patch) => setForm((f) => ({ ...f, ...patch }))} customerFixed={value?.customerId} />
        <div className="flex justify-end gap-2"><AdminButton onClick={onClose}>Cancel</AdminButton><AdminButton type="submit" variant="primary" loading={saving}>Save</AdminButton></div>
      </form>
    </Modal>
  );
}
