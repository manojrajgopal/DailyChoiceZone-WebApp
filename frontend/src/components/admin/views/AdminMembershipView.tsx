"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import {
  AdminButton,
  AdminCard,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import {
  AdminCheckbox,
  AdminInput,
  AdminTextarea,
  AdminToggle,
  FormGrid,
  FormSection,
} from "@/components/admin/ui/AdminForm";
import { Modal } from "@/components/ui/Dialog";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import {
  cancelMembership,
  createMembershipPlan,
  deleteMembershipPlan,
  getMembershipProgramme,
  listMembers,
  listMembershipPlans,
  saveMembershipProgramme,
  updateMembershipPlan,
  type MemberRow,
  type MembershipPlan,
  type MembershipPlanInput,
  type MembershipProgramme,
  type MembershipStatus,
} from "@/services/membershipService";
import { toast } from "@/store/toastStore";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

function months(value: number): string {
  if (value >= 12 && value % 12 === 0) {
    const years = value / 12;
    return `${years} ${years === 1 ? "year" : "years"}`;
  }
  return `${value} ${value === 1 ? "month" : "months"}`;
}

/* ------------------------------------------------------------------ badges */

const TONE = {
  green: "bg-[#e7f5e7] text-[#0a6b0a] ring-[#bfe3bf]",
  amber: "bg-[#fdf3e3] text-[#8a5a12] ring-[#f2d9a8]",
  red: "bg-[#fbeaea] text-[#a12b2b] ring-[#f1c4c4]",
  grey: "bg-admin-raised text-admin-muted ring-admin-border",
} as const;

function Badge({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-[3px] px-2 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset",
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

const MEMBER_STATUS: Record<MembershipStatus, { label: string; tone: keyof typeof TONE }> = {
  active: { label: "Active", tone: "green" },
  pending: { label: "Awaiting payment", tone: "amber" },
  expired: { label: "Ended", tone: "grey" },
  cancelled: { label: "Cancelled", tone: "red" },
};

const MEMBER_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "pending", label: "Awaiting payment" },
  { value: "expired", label: "Ended" },
  { value: "cancelled", label: "Cancelled" },
];

/* -------------------------------------------------------------------- view */

export function AdminMembershipView() {
  return (
    <div>
      <AdminPageHeader
        title="Membership"
        description="Name the programme, set the plans shoppers can buy and look after your members. Changes show on the storefront straight away."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Membership" }]}
      />

      <div className="flex flex-col gap-6">
        <ProgrammeSettings />
        <PlansSection />
        <MembersSection />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- programme */

function ProgrammeSettings() {
  const [draft, setDraft] = useState<MembershipProgramme | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    getMembershipProgramme()
      .then((value) => active && setDraft(value))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      setDraft(await saveMembershipProgramme(draft));
      toast.success("Membership settings saved");
    } catch (error) {
      toast.error(messageOf(error, "We couldn't save the settings. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormSection
      title="Programme"
      description="How the membership is named and described across the store."
    >
      {failed && !draft ? (
        <p className="text-sm text-admin-muted" role="alert">
          We couldn&rsquo;t load the programme settings. Refresh the page to try again.
        </p>
      ) : !draft ? (
        <div className="flex h-24 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading" />
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="flex flex-col gap-4"
        >
          <FormGrid>
            <AdminInput
              label="Programme name"
              value={draft.name}
              maxLength={40}
              required
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              hint="Shown on the membership page, in the account area and at checkout."
            />
            <AdminTextarea
              label="Tagline"
              rows={2}
              value={draft.tagline}
              maxLength={160}
              onChange={(event) => setDraft({ ...draft, tagline: event.target.value })}
              hint="One line under the name on the membership page."
            />
          </FormGrid>

          <AdminToggle
            label="Membership is open"
            description="When off, the plans are hidden and nobody can join. Existing members keep their benefits until their membership ends."
            checked={draft.enabled}
            onChange={(enabled) => setDraft({ ...draft, enabled })}
          />

          <div className="flex justify-end">
            <AdminButton type="submit" variant="primary" loading={saving}>
              Save settings
            </AdminButton>
          </div>
        </form>
      )}
    </FormSection>
  );
}

/* ------------------------------------------------------------------- plans */

/** The form works in strings so a field can be cleared while typing. */
interface PlanDraft {
  id: string | null;
  name: string;
  description: string;
  durationMonths: string;
  price: string;
  compareAtPrice: string;
  freeDelivery: boolean;
  freeDeliveriesPerMonth: string;
  memberDiscountPercent: string;
  extraReturnDays: string;
  earlyAccess: boolean;
  prioritySupport: boolean;
  badge: string;
  active: boolean;
  sortOrder: string;
}

const EMPTY_PLAN: PlanDraft = {
  id: null,
  name: "",
  description: "",
  durationMonths: "12",
  price: "",
  compareAtPrice: "",
  freeDelivery: true,
  freeDeliveriesPerMonth: "",
  memberDiscountPercent: "0",
  extraReturnDays: "0",
  earlyAccess: false,
  prioritySupport: false,
  badge: "",
  active: true,
  sortOrder: "0",
};

function toDraft(plan: MembershipPlan): PlanDraft {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description ?? "",
    durationMonths: String(plan.durationMonths),
    price: String(plan.price),
    compareAtPrice: plan.compareAtPrice === null ? "" : String(plan.compareAtPrice),
    freeDelivery: plan.freeDelivery,
    freeDeliveriesPerMonth:
      plan.freeDeliveriesPerMonth === null ? "" : String(plan.freeDeliveriesPerMonth),
    memberDiscountPercent: String(plan.memberDiscountPercent),
    extraReturnDays: String(plan.extraReturnDays),
    earlyAccess: plan.earlyAccess,
    prioritySupport: plan.prioritySupport,
    badge: plan.badge ?? "",
    active: plan.active,
    sortOrder: String(plan.sortOrder),
  };
}

function number(value: string, fallback = 0): number {
  const parsed = Number(value);
  return value.trim() === "" || Number.isNaN(parsed) ? fallback : parsed;
}

function toInput(draft: PlanDraft): MembershipPlanInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    durationMonths: Math.round(number(draft.durationMonths)),
    price: number(draft.price),
    compareAtPrice: draft.compareAtPrice.trim() === "" ? null : number(draft.compareAtPrice),
    freeDelivery: draft.freeDelivery,
    freeDeliveriesPerMonth:
      !draft.freeDelivery || draft.freeDeliveriesPerMonth.trim() === ""
        ? null
        : Math.round(number(draft.freeDeliveriesPerMonth)),
    memberDiscountPercent: number(draft.memberDiscountPercent),
    extraReturnDays: Math.round(number(draft.extraReturnDays)),
    earlyAccess: draft.earlyAccess,
    prioritySupport: draft.prioritySupport,
    badge: draft.badge.trim(),
    active: draft.active,
    sortOrder: Math.round(number(draft.sortOrder)),
  };
}

function benefitSummary(plan: MembershipPlan): string {
  const parts: string[] = [];
  if (plan.freeDelivery) {
    parts.push(
      plan.freeDeliveriesPerMonth === null
        ? "Free delivery"
        : `${plan.freeDeliveriesPerMonth} free deliveries/mo`,
    );
  }
  if (plan.memberDiscountPercent > 0) parts.push(`${plan.memberDiscountPercent}% off`);
  if (plan.extraReturnDays > 0) parts.push(`+${plan.extraReturnDays} return days`);
  if (plan.earlyAccess) parts.push("Early access");
  if (plan.prioritySupport) parts.push("Priority support");
  return parts.join(" · ") || "—";
}

function PlansSection() {
  const [plans, setPlans] = useState<MembershipPlan[] | null>(null);
  const [editing, setEditing] = useState<PlanDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<MembershipPlan | null>(null);
  const [busy, setBusy] = useState(false);

  // State is set only once the answer arrives, never synchronously.
  const load = useCallback(
    () =>
      listMembershipPlans().then(setPlans, (error: unknown) => {
        setPlans([]);
        toast.error(messageOf(error, "We couldn't load the plans. Please refresh the page."));
      }),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const input = toInput(editing);
      if (editing.id) await updateMembershipPlan(editing.id, input);
      else await createMembershipPlan(input);
      toast.success(editing.id ? "Plan updated" : "Plan added");
      setEditing(null);
      await load();
    } catch (error) {
      toast.error(messageOf(error, "We couldn't save the plan. Please check the details and try again."));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const { outcome } = await deleteMembershipPlan(deleting.id);
      toast.success(
        outcome === "retired"
          ? `${deleting.name} is retired. Existing members keep it until their membership ends.`
          : `${deleting.name} deleted`,
      );
      setDeleting(null);
      await load();
    } catch (error) {
      toast.error(messageOf(error, "We couldn't remove the plan. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const sorted = plans
    ? [...plans].sort(
        (a, b) => Number(b.active) - Number(a.active) || a.sortOrder - b.sortOrder,
      )
    : null;

  return (
    <AdminCard
      title="Plans"
      description="What shoppers can buy. A plan somebody has bought is retired rather than deleted, so existing members keep it."
      padded={false}
      action={
        <AdminButton variant="primary" size="sm" onClick={() => setEditing({ ...EMPTY_PLAN })}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Add plan
        </AdminButton>
      }
    >
      {sorted === null ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading" />
        </div>
      ) : sorted.length === 0 ? (
        <p className="p-8 text-center text-sm text-admin-muted">
          No plans yet. Add one to open membership to shoppers.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-left text-xs">
            <thead className="border-b border-admin-border text-admin-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Plan</th>
                <th className="px-4 py-2.5 font-medium">Length</th>
                <th className="px-4 py-2.5 font-medium">Price</th>
                <th className="px-4 py-2.5 font-medium">Benefits</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              {sorted.map((plan) => (
                <tr key={plan.id} className={cn("hover:bg-admin-raised", !plan.active && "text-admin-muted")}>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-admin-ink">{plan.name}</span>
                      {plan.badge ? <Badge tone="amber">{plan.badge}</Badge> : null}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-admin-ink">{months(plan.durationMonths)}</td>
                  <td className="px-4 py-3 tabular-nums">
                    <span className="text-admin-ink">{formatPrice(plan.price)}</span>
                    {plan.compareAtPrice !== null ? (
                      <span className="ml-1.5 text-admin-faint line-through">
                        {formatPrice(plan.compareAtPrice)}
                      </span>
                    ) : null}
                    <span className="block text-[0.6875rem] text-admin-muted">
                      {formatPrice(plan.pricePerMonth)}/mo
                    </span>
                  </td>
                  <td className="max-w-[16rem] px-4 py-3 text-admin-muted">{benefitSummary(plan)}</td>
                  <td className="px-4 py-3">
                    {plan.active ? <Badge tone="green">On sale</Badge> : <Badge tone="grey">Retired</Badge>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex justify-end gap-1">
                      <AdminButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(toDraft(plan))}
                        aria-label={`Edit ${plan.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                        Edit
                      </AdminButton>
                      <AdminButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleting(plan)}
                        aria-label={`Delete ${plan.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-[#c23434]" strokeWidth={1.75} aria-hidden="true" />
                        Delete
                      </AdminButton>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={editing !== null}
        onOpenChange={(open) => !open && !saving && setEditing(null)}
        title={editing?.id ? `Edit ${editing.name || "plan"}` : "Add plan"}
        className="max-w-2xl"
      >
        {editing ? (
          <PlanForm
            draft={editing}
            onChange={setEditing}
            saving={saving}
            onCancel={() => setEditing(null)}
            onSave={() => void save()}
          />
        ) : null}
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && !busy && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "plan"}?`}
        message="If nobody has bought this plan it is deleted. If somebody has, it is retired instead: it stops being sold, and existing members keep their benefits until their membership ends."
        confirmLabel="Delete plan"
        loading={busy}
        onConfirm={() => void remove()}
      />
    </AdminCard>
  );
}

function PlanForm({
  draft,
  onChange,
  saving,
  onCancel,
  onSave,
}: {
  draft: PlanDraft;
  onChange: (draft: PlanDraft) => void;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
      className="flex flex-col gap-5"
    >
      <FormGrid>
        <AdminInput
          label="Plan name"
          value={draft.name}
          maxLength={80}
          required
          onChange={(event) => set("name", event.target.value)}
        />
        <AdminInput
          label="Badge"
          value={draft.badge}
          maxLength={30}
          placeholder="e.g. Best value"
          onChange={(event) => set("badge", event.target.value)}
          hint="Optional. Highlights the plan on the membership page."
        />
        <AdminTextarea
          label="Description"
          rows={2}
          value={draft.description}
          onChange={(event) => set("description", event.target.value)}
          className="sm:col-span-2"
        />
      </FormGrid>

      <FormGrid columns={3}>
        <AdminInput
          label="Length (months)"
          type="number"
          inputMode="numeric"
          min={1}
          max={60}
          step={1}
          required
          value={draft.durationMonths}
          onChange={(event) => set("durationMonths", event.target.value)}
        />
        <AdminInput
          label="Price"
          type="number"
          inputMode="decimal"
          prefix="₹"
          min={1}
          step="any"
          required
          value={draft.price}
          onChange={(event) => set("price", event.target.value)}
        />
        <AdminInput
          label="Compare-at price"
          type="number"
          inputMode="decimal"
          prefix="₹"
          min={0}
          step="any"
          value={draft.compareAtPrice}
          onChange={(event) => set("compareAtPrice", event.target.value)}
          hint="Optional. Shown struck through."
        />
      </FormGrid>

      <fieldset className="flex flex-col gap-4 border-t border-admin-border pt-4">
        <legend className="sr-only">Benefits</legend>
        <p className="text-xs font-semibold text-admin-ink" aria-hidden="true">
          Benefits
        </p>
        <FormGrid>
          <AdminCheckbox
            label="Free standard delivery"
            checked={draft.freeDelivery}
            onChange={(event) => set("freeDelivery", event.target.checked)}
          />
          <AdminInput
            label="Free deliveries per month"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            disabled={!draft.freeDelivery}
            value={draft.freeDeliveriesPerMonth}
            onChange={(event) => set("freeDeliveriesPerMonth", event.target.value)}
            hint="Leave empty for unlimited."
          />
          <AdminInput
            label="Extra discount on every order (%)"
            type="number"
            inputMode="decimal"
            min={0}
            max={50}
            step="any"
            value={draft.memberDiscountPercent}
            onChange={(event) => set("memberDiscountPercent", event.target.value)}
            hint="Between 0 and 50."
          />
          <AdminInput
            label="Extra return days"
            type="number"
            inputMode="numeric"
            min={0}
            max={60}
            step={1}
            value={draft.extraReturnDays}
            onChange={(event) => set("extraReturnDays", event.target.value)}
            hint="Added to the store's usual return window."
          />
          <AdminCheckbox
            label="Early access to sales"
            checked={draft.earlyAccess}
            onChange={(event) => set("earlyAccess", event.target.checked)}
          />
          <AdminCheckbox
            label="Priority support"
            checked={draft.prioritySupport}
            onChange={(event) => set("prioritySupport", event.target.checked)}
          />
        </FormGrid>
      </fieldset>

      <FormGrid className="border-t border-admin-border pt-4">
        <AdminInput
          label="Display order"
          type="number"
          inputMode="numeric"
          step={1}
          value={draft.sortOrder}
          onChange={(event) => set("sortOrder", event.target.value)}
          hint="Lower numbers are shown first."
        />
        <AdminToggle
          label="On sale"
          description={
            draft.active
              ? "Shoppers can buy this plan."
              : "Retired: hidden from shoppers. Existing members keep it."
          }
          checked={draft.active}
          onChange={(active) => set("active", active)}
        />
      </FormGrid>

      <div className="flex justify-end gap-2 border-t border-admin-border pt-4">
        <AdminButton variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </AdminButton>
        <AdminButton type="submit" variant="primary" loading={saving}>
          {draft.id ? "Save plan" : "Add plan"}
        </AdminButton>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- members */

function MembersSection() {
  const [filter, setFilter] = useState("");
  const [rows, setRows] = useState<MemberRow[] | null>(null);
  const [ending, setEnding] = useState<MemberRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    listMembers({ status: filter || undefined })
      .then((result) => active && setRows(result))
      .catch(() => active && setRows([]));
    return () => {
      active = false;
    };
  }, [filter, reload]);

  const end = async () => {
    if (!ending) return;
    setBusy(true);
    try {
      await cancelMembership(ending.id);
      toast.success(`Membership ended for ${ending.customerName || ending.customerEmail}`);
      setEnding(null);
      setReload((count) => count + 1);
    } catch (error) {
      toast.error(messageOf(error, "We couldn't end this membership. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="members-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="members-heading" className="font-sans text-sm font-semibold tracking-normal text-admin-ink">
            Members
          </h2>
          <p className="mt-0.5 text-xs text-admin-muted">
            Everyone who has bought a plan, newest first.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter members by status">
        {MEMBER_FILTERS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={filter === entry.value}
            onClick={() => {
              if (filter === entry.value) return;
              setRows(null);
              setFilter(entry.value);
            }}
            className={cn(
              "rounded-[3px] px-2.5 py-1.5 text-xs transition-colors",
              filter === entry.value
                ? "bg-admin-ink text-white"
                : "bg-admin-surface text-admin-muted ring-1 ring-inset ring-admin-border hover:text-admin-ink",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <AdminCard padded={false}>
        {rows === null ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading" />
          </div>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-admin-muted">
            No members {filter ? "with this status" : "yet"}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[50rem] text-left text-xs">
              <thead className="border-b border-admin-border text-admin-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Starts</th>
                  <th className="px-4 py-2.5 font-medium">Ends</th>
                  <th className="px-4 py-2.5 text-right font-medium">Saved</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-admin-border">
                {rows.map((row) => {
                  const status = MEMBER_STATUS[row.status] ?? MEMBER_STATUS.expired;
                  return (
                    <tr key={row.id} className="hover:bg-admin-raised">
                      <td className="px-4 py-3">
                        <span className="block font-medium text-admin-ink">
                          {row.customerName || "—"}
                        </span>
                        <span className="block text-admin-muted">{row.customerEmail}</span>
                      </td>
                      <td className="px-4 py-3 text-admin-ink">{row.planName}</td>
                      <td className="px-4 py-3">
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                      <td className="px-4 py-3 text-admin-muted">
                        {row.startsAt ? formatDate(row.startsAt) : "—"}
                      </td>
                      <td className="px-4 py-3 text-admin-muted">
                        {row.endsAt ? formatDate(row.endsAt) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-admin-ink">
                        {formatPrice(row.savedOnOrders)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {row.status === "active" ? (
                          <AdminButton
                            variant="ghost"
                            size="sm"
                            onClick={() => setEnding(row)}
                            aria-label={`End membership for ${row.customerName || row.customerEmail}`}
                          >
                            End membership
                          </AdminButton>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(open) => !open && !busy && setEnding(null)}
        title="End this membership?"
        message={
          ending ? (
            <>
              {ending.customerName || ending.customerEmail}&rsquo;s {ending.planName} membership ends
              now and its benefits stop straight away. The payment is not refunded automatically.
            </>
          ) : null
        }
        confirmLabel="End membership"
        loading={busy}
        onConfirm={() => void end()}
      />
    </section>
  );
}
