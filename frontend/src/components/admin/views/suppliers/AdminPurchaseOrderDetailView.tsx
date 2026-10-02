"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { PackageCheck, Pencil } from "lucide-react";

import type { PurchaseOrder, PurchaseOrderActions, PurchaseOrderTransition } from "@/types/suppliers";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminTextarea } from "@/components/admin/ui/AdminForm";
import { Detail } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { cancelPurchaseOrder, getPurchaseOrder, transitionPurchaseOrder } from "@/services/purchaseOrdersService";
import { toast } from "@/store/toastStore";

import { PoWarnings, PurchaseOrderForm } from "./AdminPurchaseOrderForm";
import { ReceiveGoodsDialog } from "./ReceiveGoodsDialog";
import {
  ADMIN_CRUMB,
  LoadFailed,
  NoAccess,
  PO_STATUS_LABELS,
  PURCHASE_ORDERS_CRUMB,
  PageSkeleton,
  PoStatusBadge,
  SupplierStatusBadge,
  isForbidden,
  isNotFound,
  problem,
  rupees,
} from "./shared";

const TRANSITIONS: Record<PurchaseOrderTransition, { label: string; done: string; confirm?: string }> = {
  submit: {
    label: "Submit",
    done: "Purchase order submitted",
    confirm: "Submit this purchase order? It can no longer be edited once submitted.",
  },
  send: {
    label: "Mark sent",
    done: "Purchase order marked sent",
    confirm: "Mark this purchase order as sent to the supplier?",
  },
  acknowledge: { label: "Mark acknowledged", done: "Supplier acknowledgement recorded" },
};

const TH = "px-3 py-2.5 font-medium";
const TD = "px-3 py-2.5";

/** `/admin/purchase-orders/detail?id=POR001`: lines, totals, timeline, receipts and the actions the server allows. */
export function AdminPurchaseOrderDetailView() {
  const params = useSearchParams();
  const poId = params?.get("id") ?? "";
  const loaded = useAdminResource(() => getPurchaseOrder(poId), [poId], { enabled: Boolean(poId) });

  if (!poId || isNotFound(loaded.error)) {
    return (
      <div>
        <AdminPageHeader title="Purchase order not found" breadcrumbs={[ADMIN_CRUMB, PURCHASE_ORDERS_CRUMB, { label: "Not found" }]} />
        <p className="text-sm text-admin-muted">We couldn&rsquo;t find this purchase order. The link may be out of date.</p>
        <AdminButtonLink href="/admin/purchase-orders" size="sm" className="mt-4">
          Back to purchase orders
        </AdminButtonLink>
      </div>
    );
  }
  const crumbs = [ADMIN_CRUMB, PURCHASE_ORDERS_CRUMB, { label: loaded.data?.poNumber ?? poId }];
  if (isForbidden(loaded.error)) {
    return (
      <div>
        <AdminPageHeader title="Purchase order" breadcrumbs={crumbs} />
        <NoAccess area="purchasing" />
      </div>
    );
  }
  if (loaded.error && !loaded.data) {
    return (
      <div>
        <AdminPageHeader title="Purchase order" breadcrumbs={crumbs} />
        <LoadFailed message={problem(loaded.error, "The purchase order didn't load.")} onRetry={() => void loaded.reload()} />
      </div>
    );
  }
  if (!loaded.data) return <PageSkeleton label="Loading purchase order" />;
  return <PurchaseOrderBody key={loaded.data.id} initial={loaded.data} />;
}

function PurchaseOrderBody({ initial }: { initial: PurchaseOrder }) {
  // The latest answer from any action; the server's copy of the PO is always what is shown.
  const [po, setPo] = useState<PurchaseOrder>(initial);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<PurchaseOrderTransition | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const actions: Partial<PurchaseOrderActions> = po.actions ?? {};

  const transition = async (action: PurchaseOrderTransition) => {
    setBusy(action);
    try {
      const updated = await transitionPurchaseOrder(po.id, action);
      setPo(updated);
      toast.success(TRANSITIONS[action].done);
      setConfirming(null);
    } catch (error) {
      toast.error(problem(error, "That didn't work. Please try again."));
      setConfirming(null);
    } finally {
      setBusy(null);
    }
  };

  if (editing) {
    return (
      <div>
        <AdminPageHeader title={po.poNumber} breadcrumbs={[ADMIN_CRUMB, PURCHASE_ORDERS_CRUMB, { label: po.poNumber }]} />
        <PurchaseOrderForm
          po={po}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            setPo(saved);
            setEditing(false);
          }}
        />
      </div>
    );
  }

  const outstanding = po.items.reduce((sum, item) => sum + item.outstandingQty, 0);

  return (
    <div>
      <AdminPageHeader
        title={po.poNumber}
        description={`${po.supplier.name} · raised ${formatDate(po.createdAt)}`}
        breadcrumbs={[ADMIN_CRUMB, PURCHASE_ORDERS_CRUMB, { label: po.poNumber }]}
        actions={
          <>
            <PoStatusBadge status={po.status} label={po.statusLabel} />
            {actions.edit ? (
              <AdminButton size="sm" onClick={() => setEditing(true)} disabled={busy !== null}>
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Edit
              </AdminButton>
            ) : null}
            {(Object.keys(TRANSITIONS) as PurchaseOrderTransition[]).map((action) =>
              actions[action] ? (
                <AdminButton
                  key={action}
                  size="sm"
                  variant="primary"
                  loading={busy === action}
                  disabled={busy !== null}
                  onClick={() => (TRANSITIONS[action].confirm ? setConfirming(action) : void transition(action))}
                >
                  {TRANSITIONS[action].label}
                </AdminButton>
              ) : null,
            )}
            {actions.receive ? (
              <AdminButton size="sm" variant="primary" onClick={() => setReceiving(true)} disabled={busy !== null}>
                <PackageCheck className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Receive goods
              </AdminButton>
            ) : null}
            {actions.cancel ? (
              <AdminButton size="sm" variant="danger" onClick={() => setCancelling(true)} disabled={busy !== null}>
                Cancel order
              </AdminButton>
            ) : null}
          </>
        }
      />

      <PoWarnings warnings={po.warnings} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <AdminCard title="Items" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-left text-xs">
                <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                  <tr>
                    <th className={TH}>Product</th>
                    <th className={cn(TH, "text-right")}>Ordered</th>
                    <th className={cn(TH, "text-right")}>Unit cost</th>
                    <th className={cn(TH, "text-right")}>GST</th>
                    <th className={cn(TH, "text-right")}>Line total</th>
                    <th className={cn(TH, "text-right")}>Received</th>
                    <th className={cn(TH, "text-right")}>Damaged</th>
                    <th className={cn(TH, "text-right")}>Rejected</th>
                    <th className={cn(TH, "text-right")}>Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-admin-border">
                  {po.items.map((item) => (
                    <tr key={item.id} className="align-top">
                      <td className={TD}>
                        <Link href={`/admin/products/edit?id=${encodeURIComponent(item.productId)}`} className="block font-medium text-admin-ink hover:text-copper-700">
                          {item.name}
                        </Link>
                        <span className="block text-admin-muted">
                          {item.sku}
                          {item.supplierSku ? ` · ${item.supplierSku}` : ""}
                        </span>
                      </td>
                      <td className={cn(TD, "text-right tabular-nums")}>{item.quantity}</td>
                      <td className={cn(TD, "text-right tabular-nums")}>{rupees(item.unitCost)}</td>
                      <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>
                        {item.taxRate}% · {rupees(item.lineTax)}
                      </td>
                      <td className={cn(TD, "text-right tabular-nums text-admin-ink")}>{rupees(item.lineTotal)}</td>
                      <td className={cn(TD, "text-right tabular-nums")}>{item.receivedQty}</td>
                      <td className={cn(TD, "text-right tabular-nums")}>{item.damagedQty}</td>
                      <td className={cn(TD, "text-right tabular-nums")}>{item.rejectedQty}</td>
                      <td className={cn(TD, "text-right tabular-nums font-medium", item.outstandingQty ? "text-[#8a5a12]" : "text-admin-muted")}>
                        {item.outstandingQty}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminCard>

          <AdminCard title="Receipts" description="Each delivery recorded against this order.">
            {po.receipts.length === 0 ? (
              <p className="py-4 text-center text-sm text-admin-muted">
                Nothing received yet.{actions.receive ? " Use “Receive goods” when the delivery arrives." : ""}
              </p>
            ) : (
              <ul className="flex flex-col gap-4">
                {po.receipts.map((receipt) => (
                  <li key={receipt.id} className="rounded-[3px] border border-admin-border">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-admin-border px-3 py-2 text-xs">
                      <span className="font-medium text-admin-ink">{receipt.receiptNumber}</span>
                      <span className="text-admin-muted">
                        {formatDate(receipt.receivedAt)}
                        {receipt.createdBy ? ` · ${receipt.createdBy}` : ""}
                      </span>
                    </div>
                    <table className="w-full text-left text-xs">
                      <thead className="text-admin-muted">
                        <tr>
                          <th className={TH}>Product</th>
                          <th className={cn(TH, "text-right")}>Received</th>
                          <th className={cn(TH, "text-right")}>Damaged</th>
                          <th className={cn(TH, "text-right")}>Rejected</th>
                          <th className={cn(TH, "text-right")}>Accepted</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-admin-border">
                        {receipt.items.map((item) => (
                          <tr key={item.poItemId}>
                            <td className={TD}>
                              {item.name}
                              {item.note ? <span className="block text-admin-muted">{item.note}</span> : null}
                            </td>
                            <td className={cn(TD, "text-right tabular-nums")}>{item.receivedQty}</td>
                            <td className={cn(TD, "text-right tabular-nums")}>{item.damagedQty}</td>
                            <td className={cn(TD, "text-right tabular-nums")}>{item.rejectedQty}</td>
                            <td className={cn(TD, "text-right tabular-nums font-medium text-admin-ink")}>{item.acceptedQty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {receipt.notes ? <p className="border-t border-admin-border px-3 py-2 text-xs text-admin-muted">{receipt.notes}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>

          <AdminCard title="Timeline" description="Every change to this order, oldest first.">
            {po.timeline.length === 0 ? (
              <p className="text-sm text-admin-muted">No events yet.</p>
            ) : (
              <ol className="flex flex-col gap-3" aria-label="Timeline">
                {po.timeline.map((event, index) => (
                  <li key={`${event.status}-${event.at}-${index}`} className="flex gap-2.5">
                    <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill bg-copper-500" />
                    <span className="text-xs">
                      <span className="block font-medium text-admin-ink">
                        {PO_STATUS_LABELS[event.status as keyof typeof PO_STATUS_LABELS] ?? event.status}
                      </span>
                      <span className="block text-[0.625rem] text-admin-muted">
                        {formatDateTime(event.at)}
                        {event.actor ? ` · ${event.actor}` : ""}
                      </span>
                      {event.note ? <span className="mt-0.5 block italic text-admin-muted">{event.note}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </AdminCard>
        </div>

        <div className="flex flex-col gap-4">
          <AdminCard title="Totals">
            <dl className="flex flex-col gap-1.5 text-xs" aria-label="Totals">
              <TotalRow label="Subtotal" value={po.subtotal} />
              {po.taxTotal === 0 ? (
                <TotalRow label="GST" value={0} hint="No GST for this supplier" />
              ) : po.taxMode === "inter-state" ? (
                <TotalRow label="IGST" value={po.igst} />
              ) : (
                <>
                  <TotalRow label="CGST" value={po.cgst} />
                  <TotalRow label="SGST" value={po.sgst} />
                </>
              )}
              <TotalRow label="Total tax" value={po.taxTotal} />
              <div className="mt-1 border-t border-admin-border pt-2">
                <TotalRow label="Total" value={po.total} strong />
              </div>
            </dl>
            <p className="mt-3 text-[0.6875rem] text-admin-muted">
              {po.taxMode === "inter-state" ? "Inter-state supply: IGST." : "Intra-state supply: CGST + SGST."} Prices exclude tax.
            </p>
          </AdminCard>

          <AdminCard title="Supplier">
            <dl className="grid gap-3 text-xs">
              <Detail label="Supplier">
                <Link href={`/admin/suppliers/detail?id=${encodeURIComponent(po.supplier.id)}`} className="font-medium hover:text-copper-700">
                  {po.supplier.name}
                </Link>{" "}
                <span className="text-admin-muted">{po.supplier.code}</span>
              </Detail>
              {po.supplier.status !== "active" ? (
                <Detail label="Supplier status">
                  <SupplierStatusBadge status={po.supplier.status} />
                </Detail>
              ) : null}
              {po.supplier.state ? <Detail label="State">{po.supplier.state}</Detail> : null}
              <Detail label="Expected">{po.expectedAt ? formatDate(po.expectedAt) : "Not set"}</Detail>
              <Detail label="Supplier reference">{po.supplierReference || "—"}</Detail>
              <Detail label="Outstanding units">{outstanding}</Detail>
              {po.notes ? (
                <Detail label="Notes">
                  <span className="whitespace-pre-line">{po.notes}</span>
                </Detail>
              ) : null}
            </dl>
          </AdminCard>
        </div>
      </div>

      {confirming && TRANSITIONS[confirming].confirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && busy === null && setConfirming(null)}
          title={`${TRANSITIONS[confirming].label} ${po.poNumber}?`}
          message={TRANSITIONS[confirming].confirm}
          confirmLabel={TRANSITIONS[confirming].label}
          destructive={false}
          loading={busy === confirming}
          onConfirm={() => void transition(confirming)}
        />
      ) : null}

      {cancelling ? (
        <CancelDialog
          po={po}
          onClose={() => setCancelling(false)}
          onCancelled={(updated) => {
            setPo(updated);
            setCancelling(false);
          }}
        />
      ) : null}

      {receiving ? (
        <ReceiveGoodsDialog
          po={po}
          onClose={() => setReceiving(false)}
          onReceived={(updated) => {
            setPo(updated);
            setReceiving(false);
          }}
        />
      ) : null}
    </div>
  );
}

function TotalRow({ label, value, hint, strong = false }: { label: string; value: number; hint?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn(strong ? "font-semibold text-admin-ink" : "text-admin-muted")}>
        {label}
        {hint ? <span className="block text-[0.625rem] text-admin-faint">{hint}</span> : null}
      </dt>
      <dd className={cn("tabular-nums", strong ? "text-sm font-semibold text-admin-ink" : "text-admin-ink")}>{rupees(value)}</dd>
    </div>
  );
}

function CancelDialog({
  po,
  onClose,
  onCancelled,
}: {
  po: PurchaseOrder;
  onClose: () => void;
  onCancelled: (po: PurchaseOrder) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!reason.trim()) {
      setError("Say why this order is being cancelled.");
      return;
    }
    setBusy(true);
    try {
      const updated = await cancelPurchaseOrder(po.id, reason.trim());
      toast.success("Purchase order cancelled");
      onCancelled(updated);
    } catch (failure) {
      setError(problem(failure, "The order wasn't cancelled. Please try again."));
      setBusy(false);
    }
  };

  return (
    <Modal open onOpenChange={(open) => !open && !busy && onClose()} title={`Cancel ${po.poNumber}?`} className="max-w-md">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-admin-muted">The supplier should be told separately. This can&rsquo;t be undone.</p>
        <AdminTextarea
          label="Reason"
          required
          rows={3}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError("");
          }}
          error={error}
          disabled={busy}
        />
        <div className="flex justify-end gap-2">
          <AdminButton variant="secondary" onClick={onClose} disabled={busy}>
            Keep order
          </AdminButton>
          <AdminButton type="submit" variant="danger" loading={busy}>
            Cancel order
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}
