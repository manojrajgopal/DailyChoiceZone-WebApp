"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Ban, Loader2, ShieldCheck } from "lucide-react";

import {
  AdminButton,
  AdminButtonLink,
  AdminCard,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate, formatPrice } from "@/lib/utils/format";
import {
  getCustomer,
  getCustomerOrders,
  setCustomerStatus,
} from "@/services/admin/customerAdminService";
import { toast } from "@/store/toastStore";

/**
 * One customer.
 *
 * Aggregates are computed from their actual orders rather than trusted from the
 * customer record, so the figures here can never disagree with the order list
 * below them.
 */
export function AdminCustomerDetailView() {
  const searchParams = useSearchParams();
  const customerId = searchParams?.get("id") ?? "";

  const customer = useAdminResource(
    () => (customerId ? getCustomer(customerId) : Promise.resolve(null)),
    [customerId],
  );
  const orders = useAdminResource(
    () => (customerId ? getCustomerOrders(customerId) : Promise.resolve([])),
    [customerId],
  );

  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  if (customer.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading customer" />
      </div>
    );
  }

  const record = customer.data;

  if (!record) {
    return (
      <div>
        <AdminPageHeader
          title="Customer not found"
          breadcrumbs={[
            { label: "Admin", href: "/admin/dashboard" },
            { label: "Customers", href: "/admin/customers" },
            { label: "Not found" },
          ]}
        />
        <div className="rounded-[3px] border border-admin-border bg-admin-surface p-8 text-center">
          <p className="text-sm text-admin-ink">
            No customer matches <code>{customerId || "(none)"}</code>.
          </p>
          <AdminButtonLink href="/admin/customers" variant="secondary" className="mt-5">
            Back to customers
          </AdminButtonLink>
        </div>
      </div>
    );
  }

  const list = orders.data ?? [];
  const billable = list.filter((order) => order.status !== "cancelled");
  const spent = billable.reduce((sum, order) => sum + order.totals.total, 0);
  const average = billable.length > 0 ? Math.round(spent / billable.length) : 0;
  const blocked = record.status === "blocked";

  const onToggleStatus = async () => {
    setSaving(true);
    const result = await setCustomerStatus(record.id, blocked ? "active" : "blocked");
    setSaving(false);
    setConfirming(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(blocked ? "Customer unblocked" : "Customer blocked");
    await customer.reload();
  };

  return (
    <div>
      <AdminPageHeader
        title={`${record.firstName} ${record.lastName}`}
        description={`Customer since ${formatDate(record.joinedAt)}`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Customers", href: "/admin/customers" },
          { label: `${record.firstName} ${record.lastName}` },
        ]}
        actions={
          <span className="flex items-center gap-2">
            <DomainStatus domain="generic" status={record.status} />
            <AdminButton
              variant={blocked ? "secondary" : "danger"}
              onClick={() => setConfirming(true)}
            >
              {blocked ? (
                <>
                  <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Unblock
                </>
              ) : (
                <>
                  <Ban className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Block customer
                </>
              )}
            </AdminButton>
          </span>
        }
      />

      {/* -------------------------------------------------------- summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Orders", value: billable.length.toString() },
          { label: "Total spent", value: formatPrice(spent) },
          { label: "Average order", value: formatPrice(average) },
          {
            label: "Last order",
            value: record.lastOrderAt ? formatDate(record.lastOrderAt) : "Never",
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-[3px] border border-admin-border bg-admin-surface p-3"
          >
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
              {stat.label}
            </p>
            <p className="mt-1.5 text-sm font-semibold text-admin-ink tabular-nums">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        {/* ------------------------------------------------- order history */}
        <AdminCard
          title="Order history"
          /*
           * The cancelled count is spelt out because the tile above counts
           * only the billable ones — it has to, or it would disagree with the
           * spend beside it — and two different order counts on one screen
           * with no explanation reads as a bug.
           */
          description={
            list.length - billable.length > 0
              ? `${list.length} order${list.length === 1 ? "" : "s"}, newest first · ${list.length - billable.length} cancelled`
              : `${list.length} order${list.length === 1 ? "" : "s"}, newest first`
          }
        >
          {orders.isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="h-12 animate-pulse rounded-[3px] bg-admin-raised" />
              ))}
            </div>
          ) : list.length === 0 ? (
            <p className="py-6 text-center text-xs text-admin-muted">
              This customer has not ordered yet.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-admin-border">
              {list.map((order) => (
                <li key={order.id} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0">
                  <Link
                    href={`/admin/orders/detail?id=${order.id}`}
                    className="text-xs font-medium text-admin-ink hover:text-copper-700"
                  >
                    #{order.orderNumber}
                  </Link>
                  <span className="text-[0.6875rem] text-admin-muted">
                    {formatDate(order.placedAt)}
                  </span>
                  <span className="text-[0.6875rem] text-admin-muted tabular-nums">
                    {order.totals.itemCount} item{order.totals.itemCount === 1 ? "" : "s"}
                  </span>
                  <DomainStatus domain="order" status={order.status} />
                  <span className="ml-auto text-xs font-medium tabular-nums">
                    {formatPrice(order.totals.total)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AdminCard>

        {/* ------------------------------------------------- side column */}
        <div className="flex flex-col gap-4">
          <AdminCard title="Contact">
            <dl className="flex flex-col gap-2 text-xs">
              <div>
                <dt className="text-admin-muted">Email</dt>
                <dd className="mt-0.5 break-words text-admin-ink">{record.email}</dd>
              </div>
              <div>
                <dt className="text-admin-muted">Phone</dt>
                <dd className="mt-0.5 text-admin-ink tabular-nums">+91 {record.phone}</dd>
              </div>
            </dl>
            <p className="mt-3 rounded-[3px] bg-admin-raised px-2.5 py-2 text-[0.625rem] leading-relaxed text-admin-muted">
              These details are generated demo data, not a real person.
            </p>
          </AdminCard>

          <AdminCard title={`Addresses (${record.addresses.length})`}>
            {record.addresses.length === 0 ? (
              <p className="text-xs text-admin-muted">No saved addresses.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {record.addresses.map((address) => (
                  <li key={address.id}>
                    <address className="text-xs not-italic leading-relaxed text-admin-muted">
                      <span className="block font-medium text-admin-ink">{address.fullName}</span>
                      {address.line1}
                      {address.line2 ? `, ${address.line2}` : ""}
                      <br />
                      {address.city}, {address.state} {address.pincode}
                    </address>
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>

          <AdminCard title="Wishlist">
            <p className="text-xs text-admin-muted">
              {record.wishlistProductIds.length === 0
                ? "Nothing saved."
                : `${record.wishlistProductIds.length} product${record.wishlistProductIds.length === 1 ? "" : "s"} saved for later.`}
            </p>
          </AdminCard>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={blocked ? "Unblock customer?" : "Block customer?"}
        destructive={!blocked}
        loading={saving}
        confirmLabel={blocked ? "Unblock" : "Block customer"}
        message={
          blocked ? (
            <>
              <strong className="text-admin-ink">
                {record.firstName} {record.lastName}
              </strong>{" "}
              will be able to sign in and place orders again.
            </>
          ) : (
            <>
              <strong className="text-admin-ink">
                {record.firstName} {record.lastName}
              </strong>{" "}
              will no longer be able to place orders. Their past orders are kept.
            </>
          )
        }
        onConfirm={() => void onToggleStatus()}
      />
    </div>
  );
}
