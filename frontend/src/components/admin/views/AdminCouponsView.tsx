"use client";

import { useState } from "react";
import { Pencil, Plus, Power, Trash2 } from "lucide-react";

import type { AdminCoupon, CouponStatus } from "@/types/admin";

import {
  AdminButton,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import {
  AdminInput,
  AdminSelect,
  AdminTextarea,
  FormGrid,
} from "@/components/admin/ui/AdminForm";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate, formatPrice } from "@/lib/utils/format";
import {
  deleteCoupon,
  effectiveStatus,
  emptyCoupon,
  listCoupons,
  saveCoupon,
  setCouponStatus,
} from "@/services/admin/couponAdminService";
import { toast } from "@/store/toastStore";

/** ISO timestamp to the `yyyy-MM-dd` a date input expects. */
const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** A date input's value back to an ISO timestamp, or null when cleared. */
const fromDateInput = (value: string) =>
  value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;

/**
 * Coupon management.
 *
 * The status column shows the *effective* status — a coupon whose end date has
 * passed reads as expired regardless of what is stored, because the storefront
 * will refuse it either way and showing "active" would be a lie.
 */
export function AdminCouponsView() {
  const coupons = useAdminResource(() => listCoupons(), []);

  const [editing, setEditing] = useState<AdminCoupon | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminCoupon | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = coupons.data ?? [];

  const onSave = async () => {
    if (!editing) return;
    setSaving(true);
    const result = await saveCoupon(editing);
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data.code} saved`);
    setEditing(null);
    await coupons.reload();
  };

  const onToggle = async (coupon: AdminCoupon) => {
    const next: CouponStatus = coupon.status === "disabled" ? "active" : "disabled";
    const result = await setCouponStatus(coupon.id, next);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${coupon.code} ${next === "disabled" ? "disabled" : "enabled"}`);
    await coupons.reload();
  };

  const onDelete = async () => {
    if (!pendingDelete) return;
    setSaving(true);
    const result = await deleteCoupon(pendingDelete.id);
    setSaving(false);
    setPendingDelete(null);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data} deleted`);
    await coupons.reload();
  };

  const describeValue = (coupon: AdminCoupon) => {
    if (coupon.type === "percent") {
      return `${coupon.value}% off${coupon.maxDiscount ? ` (max ${formatPrice(coupon.maxDiscount)})` : ""}`;
    }
    if (coupon.type === "flat") return `${formatPrice(coupon.value)} off`;
    return "Free delivery";
  };

  const columns: Column<AdminCoupon>[] = [
    {
      id: "code",
      header: "Code",
      sortValue: (coupon) => coupon.code,
      cell: (coupon) => (
        <span className="min-w-0">
          <span className="block font-mono text-xs font-semibold text-admin-ink">
            {coupon.code}
          </span>
          <span className="block max-w-[14rem] truncate text-[0.625rem] text-admin-faint">
            {coupon.description}
          </span>
        </span>
      ),
    },
    {
      id: "value",
      header: "Discount",
      hideBelow: "sm",
      cell: (coupon) => <span className="text-xs text-admin-ink">{describeValue(coupon)}</span>,
    },
    {
      id: "minSubtotal",
      header: "Min order",
      align: "right",
      hideBelow: "md",
      sortValue: (coupon) => coupon.minSubtotal,
      cell: (coupon) => (
        <span className="whitespace-nowrap tabular-nums text-admin-muted">
          {coupon.minSubtotal > 0 ? formatPrice(coupon.minSubtotal) : "None"}
        </span>
      ),
    },
    {
      id: "window",
      header: "Active window",
      hideBelow: "lg",
      sortValue: (coupon) => coupon.startsAt,
      cell: (coupon) => (
        <span className="whitespace-nowrap text-[0.6875rem] text-admin-muted">
          {formatDate(coupon.startsAt)}
          {" → "}
          {coupon.endsAt ? formatDate(coupon.endsAt) : "no end"}
        </span>
      ),
    },
    {
      id: "usage",
      header: "Used",
      align: "right",
      sortValue: (coupon) => coupon.usageCount,
      cell: (coupon) => (
        <span className="tabular-nums">
          {coupon.usageCount}
          <span className="text-admin-faint">
            {coupon.usageLimit !== null ? ` / ${coupon.usageLimit}` : ""}
          </span>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (coupon) => effectiveStatus(coupon),
      cell: (coupon) => <DomainStatus domain="coupon" status={effectiveStatus(coupon)} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (coupon) => (
        <span className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            onClick={() => setEditing({ ...coupon })}
            aria-label={`Edit ${coupon.code}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => void onToggle(coupon)}
            aria-label={
              coupon.status === "disabled" ? `Enable ${coupon.code}` : `Disable ${coupon.code}`
            }
            title={coupon.status === "disabled" ? "Enable" : "Disable"}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
          >
            <Power className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => setPendingDelete(coupon)}
            aria-label={`Delete ${coupon.code}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424]"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Coupons"
        description="Discount codes customers can apply at checkout."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Coupons" }]}
        actions={
          <AdminButton variant="primary" onClick={() => setEditing(emptyCoupon())}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
            Add coupon
          </AdminButton>
        }
      />

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(coupon) => coupon.id}
        isLoading={coupons.isLoading}
        pageSize={12}
        emptyTitle="No coupons yet"
        emptyDescription="Create one to run a promotion."
      />

      <Modal
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.code ? `Edit ${editing.code}` : "Add coupon"}
        className="max-w-lg"
      >
        {editing ? (
          <div className="flex flex-col gap-4">
            <FormGrid>
              <AdminInput
                label="Code"
                value={editing.code}
                onChange={(event) =>
                  setEditing({ ...editing, code: event.target.value.toUpperCase() })
                }
                required
                hint="4–20 letters and numbers. Customers type this exactly."
                className="font-mono"
              />

              <AdminSelect
                label="Discount type"
                value={editing.type}
                onChange={(event) =>
                  setEditing({ ...editing, type: event.target.value as AdminCoupon["type"] })
                }
                options={[
                  { value: "percent", label: "Percentage off" },
                  { value: "flat", label: "Fixed amount off" },
                  { value: "free-shipping", label: "Free delivery" },
                ]}
              />

              <AdminTextarea
                label="Description"
                rows={2}
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                hint="Shown beside the code in the customer's bag."
                className="sm:col-span-2"
              />

              {editing.type !== "free-shipping" ? (
                <AdminInput
                  label={editing.type === "percent" ? "Percentage" : "Amount"}
                  type="number"
                  min={1}
                  prefix={editing.type === "flat" ? "₹" : undefined}
                  value={editing.value}
                  onChange={(event) => setEditing({ ...editing, value: Number(event.target.value) })}
                  required
                />
              ) : null}

              {editing.type === "percent" ? (
                <AdminInput
                  label="Maximum discount"
                  type="number"
                  min={0}
                  prefix="₹"
                  value={editing.maxDiscount ?? ""}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      maxDiscount: event.target.value === "" ? null : Number(event.target.value),
                    })
                  }
                  hint="Caps a percentage discount. Leave blank for no cap."
                />
              ) : null}

              <AdminInput
                label="Minimum order value"
                type="number"
                min={0}
                prefix="₹"
                value={editing.minSubtotal}
                onChange={(event) =>
                  setEditing({ ...editing, minSubtotal: Number(event.target.value) })
                }
                hint="Zero for no minimum."
              />

              <AdminInput
                label="Usage limit"
                type="number"
                min={0}
                value={editing.usageLimit ?? ""}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    usageLimit: event.target.value === "" ? null : Number(event.target.value),
                  })
                }
                hint="Total redemptions. Blank for unlimited."
              />

              <AdminInput
                label="Starts"
                type="date"
                value={toDateInput(editing.startsAt)}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    startsAt: fromDateInput(event.target.value) ?? editing.startsAt,
                  })
                }
              />

              <AdminInput
                label="Ends"
                type="date"
                value={toDateInput(editing.endsAt)}
                onChange={(event) =>
                  setEditing({ ...editing, endsAt: fromDateInput(event.target.value) })
                }
                hint="Leave blank to run indefinitely."
              />

              <AdminSelect
                label="Status"
                value={editing.status === "disabled" ? "disabled" : "active"}
                onChange={(event) =>
                  setEditing({ ...editing, status: event.target.value as CouponStatus })
                }
                options={[
                  { value: "active", label: "Enabled — dates decide when it runs" },
                  { value: "disabled", label: "Disabled — never accepted" },
                ]}
                className="sm:col-span-2"
              />
            </FormGrid>

            <div className="flex justify-end gap-2">
              <AdminButton variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </AdminButton>
              <AdminButton variant="primary" loading={saving} onClick={() => void onSave()}>
                Save coupon
              </AdminButton>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete coupon?"
        loading={saving}
        confirmLabel="Delete coupon"
        message={
          <>
            Delete <strong className="text-admin-ink">{pendingDelete?.code}</strong>? Anyone who
            tries it at checkout will be told it is invalid. If you only want to stop it for now,
            disable it instead — that keeps the record.
          </>
        }
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
