"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { ReturnRequest, ReturnStatus } from "@/types/returns";
import type { LookupEntity } from "@/lib/lookup/entities";

import {
  AdminButton,
  AdminButtonLink,
  AdminCard,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { IdKindFilter } from "@/components/admin/ui/IdKindFilter";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { getReturn, listReturns, moveReturn } from "@/services/returnsService";
import { toast } from "@/store/toastStore";
import { RETURN_STATUS_LABELS } from "@/types/returns";

const FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "requested", label: "New" },
  { value: "approved", label: "Approved" },
  { value: "picked-up", label: "Picked up" },
  { value: "received", label: "Received" },
  { value: "replacement-shipped", label: "Replacement shipped" },
  { value: "refunded", label: "Refunded" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Declined" },
  { value: "cancelled", label: "Cancelled" },
];

const TONE: Record<string, string> = {
  requested: "bg-[#fdf3e3] text-[#8a5a12] ring-[#f2d9a8]",
  approved: "bg-[#e8f0fb] text-[#1f4f8f] ring-[#c4d7f2]",
  "picked-up": "bg-[#e8f0fb] text-[#1f4f8f] ring-[#c4d7f2]",
  received: "bg-[#e8f0fb] text-[#1f4f8f] ring-[#c4d7f2]",
  "replacement-shipped": "bg-[#e8f0fb] text-[#1f4f8f] ring-[#c4d7f2]",
  refunded: "bg-[#e7f5e7] text-[#0a6b0a] ring-[#bfe3bf]",
  completed: "bg-[#e7f5e7] text-[#0a6b0a] ring-[#bfe3bf]",
  rejected: "bg-[#fbeaea] text-[#a12b2b] ring-[#f1c4c4]",
  cancelled: "bg-admin-raised text-admin-muted ring-admin-border",
};

export function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-[3px] px-2 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset",
        TONE[status] ?? TONE.cancelled,
      )}
    >
      {RETURN_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/* ------------------------------------------------------------------ list */

export function AdminReturnsView() {
  const [filter, setFilter] = useState("");
  // Finding one request (or one order's, or one customer's) is by ID only.
  const [findBy, setFindBy] = useState<{ entity: LookupEntity; id: string }>({ entity: "return", id: "" });
  const [customer, setCustomer] = useState("");
  const [rows, setRows] = useState<ReturnRequest[] | null>(null);
  const q = findBy.id;

  useEffect(() => {
    let active = true;
    setRows(null);
    listReturns({ status: filter || undefined, q: q || undefined, customer: customer || undefined })
      .then((result) => active && setRows(result))
      .catch(() => active && setRows([]));
    return () => {
      active = false;
    };
  }, [filter, q, customer]);

  return (
    <div>
      <AdminPageHeader
        title="Returns & replacements"
        description="Requests from customers after delivery. Approve, arrange the pickup, and close each one with a refund or a replacement."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Returns" }]}
      />

      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by status">
        {FILTERS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={filter === entry.value}
            onClick={() => setFilter(entry.value)}
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

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <IdKindFilter kinds={["return", "order"]} entity={findBy.entity} value={findBy.id} onChange={setFindBy} />
        <IdFilter entity="customer" value={customer} onChange={setCustomer} className="w-52" />
      </div>

      <AdminCard padded={false}>
        {rows === null ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading" />
          </div>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-admin-muted">
            No requests {q || customer ? "match that ID" : filter ? "with this status" : "yet"}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-xs">
              <thead className="border-b border-admin-border text-admin-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Request</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Order</th>
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  <th className="px-4 py-2.5 font-medium">Items</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Requested</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-admin-border">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-admin-raised">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/returns/detail?id=${encodeURIComponent(row.id)}`}
                        className="font-medium text-admin-ink hover:text-copper-700"
                      >
                        {row.id}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-admin-ink">
                      {row.kind === "return" ? "Return" : "Replacement"}
                    </td>
                    <td className="px-4 py-3 text-admin-muted">#{row.orderNumber}</td>
                    <td className="px-4 py-3 text-admin-ink">{row.customerName}</td>
                    <td className="px-4 py-3 text-admin-muted">
                      {row.items.reduce((sum, item) => sum + item.quantity, 0)}
                    </td>
                    <td className="px-4 py-3">
                      <ReturnStatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-3 text-right text-admin-muted">{formatDate(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>
    </div>
  );
}

/* ---------------------------------------------------------------- detail */

const ACTION_COPY: Record<string, { label: string; confirm?: string; primary?: boolean; danger?: boolean }> = {
  approved: { label: "Approve", primary: true },
  rejected: { label: "Decline", danger: true, confirm: "Decline this request? The customer will see your note." },
  cancelled: { label: "Cancel request", danger: true, confirm: "Cancel this request? The items become available to request again." },
  "picked-up": { label: "Mark picked up", primary: true },
  received: { label: "Mark received", primary: true },
  refunded: {
    label: "Issue refund",
    primary: true,
    confirm:
      "Refund the customer now? Online payments are refunded to the original method; cash-on-delivery orders are recorded as paid back by you directly.",
  },
  "replacement-shipped": {
    label: "Ship replacement",
    primary: true,
    confirm: "Send the replacement now? The units are taken from stock.",
  },
  completed: { label: "Mark completed", primary: true },
};

export function AdminReturnDetailView() {
  const searchParams = useSearchParams();
  const id = searchParams?.get("id") ?? "";
  const [request, setRequest] = useState<ReturnRequest | null | undefined>(undefined);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ReturnStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setRequest(await getReturn(id));
    } catch {
      setRequest(null);
    }
  }, [id]);

  useEffect(() => {
    if (id) void load();
    else setRequest(null);
  }, [id, load]);

  const act = async (status: ReturnStatus) => {
    setBusy(true);
    const result = await moveReturn(id, status, note);
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      toast.error(result.reason);
      return;
    }
    toast.success(`Request ${RETURN_STATUS_LABELS[status].toLowerCase()}`);
    setNote("");
    setRequest(result.data);
  };

  if (request === undefined) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading request" />
      </div>
    );
  }

  if (request === null) {
    return (
      <div>
        <AdminPageHeader
          title="Request not found"
          breadcrumbs={[
            { label: "Admin", href: "/admin/dashboard" },
            { label: "Returns", href: "/admin/returns" },
          ]}
        />
        <p className="text-sm text-admin-muted">We couldn&rsquo;t find this request.</p>
      </div>
    );
  }

  const steps = request.nextSteps ?? [];
  const confirmCopy = pending ? ACTION_COPY[pending] : null;

  return (
    <div>
      <AdminPageHeader
        title={`${request.kind === "return" ? "Return" : "Replacement"} ${request.id}`}
        description={`Order #${request.orderNumber} · ${request.customerName} · requested ${formatDate(request.createdAt)}`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Returns", href: "/admin/returns" },
          { label: request.id },
        ]}
        actions={<ReturnStatusBadge status={request.status} />}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          <AdminCard title="Items">
            <ul className="flex flex-col divide-y divide-admin-border">
              {request.items.map((item) => (
                <li key={item.orderItemId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="h-14 w-11 shrink-0 overflow-hidden rounded-[2px] bg-admin-raised">
                    {item.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.image} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="block font-medium text-admin-ink">{item.name}</span>
                    <span className="block text-admin-muted">
                      {[item.size, item.color].filter(Boolean).join(" · ")} · Qty {item.quantity}
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-admin-ink">{formatMoney(item.amount)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-4 grid gap-2 border-t border-admin-border pt-4 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-admin-muted">Reason</dt>
                <dd className="mt-0.5 text-admin-ink">{request.reason}</dd>
              </div>
              <div>
                <dt className="text-admin-muted">
                  {request.kind === "return" ? "Refund value" : "Value of items"}
                </dt>
                <dd className="mt-0.5 font-medium tabular-nums text-admin-ink">{formatMoney(request.amount)}</dd>
              </div>
              {request.comment ? (
                <div className="sm:col-span-2">
                  <dt className="text-admin-muted">Customer&rsquo;s note</dt>
                  <dd className="mt-0.5 whitespace-pre-line text-admin-ink">{request.comment}</dd>
                </div>
              ) : null}
            </dl>
          </AdminCard>

          <AdminCard title="History" description="Every update to this request, oldest first.">
            <ol className="flex flex-col gap-3">
              {request.timeline.map((event, index) => (
                <li key={`${event.status}-${event.at}-${index}`} className="flex gap-2.5">
                  <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill bg-copper-500" />
                  <span className="text-xs">
                    <span className="block font-medium text-admin-ink">{RETURN_STATUS_LABELS[event.status]}</span>
                    <span className="block text-[0.625rem] text-admin-muted">
                      {formatDate(event.at)} · {event.by === "customer" ? "Customer" : event.by === "system" ? "Automatic" : "Staff"}
                    </span>
                    {event.note ? <span className="mt-0.5 block italic text-admin-muted">{event.note}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </AdminCard>
        </div>

        <div className="flex flex-col gap-4">
          <AdminCard title="Next step">
            {steps.length === 0 ? (
              <p className="text-xs leading-relaxed text-admin-muted">
                This request is {RETURN_STATUS_LABELS[request.status].toLowerCase()} and needs no
                further action.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-admin-ink">Note to the customer</span>
                  <textarea
                    rows={3}
                    value={note}
                    maxLength={500}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Optional — e.g. the pickup date, or why a request is declined."
                    className="rounded-[3px] border border-admin-border bg-admin-surface px-2.5 py-2 text-xs text-admin-ink placeholder:text-admin-faint focus:border-copper-500 focus:outline-none"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {steps.map((step) => {
                    const copy = ACTION_COPY[step] ?? { label: RETURN_STATUS_LABELS[step] };
                    return (
                      <AdminButton
                        key={step}
                        size="sm"
                        variant={copy.danger ? "danger" : copy.primary ? "primary" : "secondary"}
                        loading={busy && pending === null}
                        onClick={() => (copy.confirm ? setPending(step) : void act(step))}
                      >
                        {copy.label}
                      </AdminButton>
                    );
                  })}
                </div>
              </div>
            )}
            {request.resolutionNote ? (
              <p className="mt-3 border-t border-admin-border pt-3 text-[0.6875rem] text-admin-muted">
                Last note to the customer: {request.resolutionNote}
              </p>
            ) : null}
          </AdminCard>

          <AdminCard title="Order">
            <AdminButtonLink
              href={`/admin/orders/detail?id=${encodeURIComponent(request.orderId)}`}
              variant="secondary"
              size="sm"
            >
              Open order #{request.orderNumber}
            </AdminButtonLink>
          </AdminCard>
        </div>
      </div>

      {confirmCopy && pending ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          title={`${confirmCopy.label}?`}
          message={confirmCopy.confirm}
          confirmLabel={confirmCopy.label}
          destructive={Boolean(confirmCopy.danger)}
          loading={busy}
          onConfirm={() => void act(pending)}
        />
      ) : null}
    </div>
  );
}
