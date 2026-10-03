"use client";

import Link from "next/link";

import { AdminCard } from "@/components/admin/ui/AdminChrome";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { getCustomerDiscovery } from "@/services/admin/discoveryAdminService";

/**
 * What a customer has looked at recently and put aside from their bag — on
 * the customer screen, read-only, for whoever is helping them. Needs the
 * `customers` permission, like the rest of the screen.
 */
export function CustomerDiscoveryCard({ customerId }: { customerId: string }) {
  const data = useAdminResource(() => getCustomerDiscovery(customerId), [customerId], { enabled: Boolean(customerId) });

  if (data.error instanceof ApiError && data.error.status === 403) return null;

  return (
    <AdminCard title="Browsing and saved for later">
      {data.error && !data.data ? (
        <p role="alert" className="text-xs text-admin-ink">This didn&rsquo;t load.</p>
      ) : !data.data ? (
        <span aria-busy="true" aria-label="Loading browsing history" className="block h-12 animate-pulse rounded-[2px] bg-admin-border" />
      ) : (
        <div className="flex flex-col gap-4 text-xs">
          <div>
            <p className="font-medium text-admin-ink">Saved for later ({data.data.savedForLater.length})</p>
            {data.data.savedForLater.length === 0 ? (
              <p className="mt-1 text-admin-muted">Nothing put aside.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {data.data.savedForLater.map((row) => (
                  <li key={row.id} className="flex justify-between gap-3">
                    <Link href={`/admin/products/edit?id=${encodeURIComponent(row.productId)}`} className="truncate text-admin-ink hover:underline">
                      {row.name}
                    </Link>
                    <span className="shrink-0 text-admin-muted">
                      {[row.size, row.color].filter(Boolean).join(" · ")} × {row.quantity}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="font-medium text-admin-ink">Recently viewed ({data.data.recentlyViewed.length})</p>
            {data.data.recentlyViewed.length === 0 ? (
              <p className="mt-1 text-admin-muted">No history kept for this account.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {data.data.recentlyViewed.slice(0, 10).map((row) => (
                  <li key={row.productId} className="flex justify-between gap-3">
                    <span className="truncate text-admin-ink">{row.name}</span>
                    <span className="shrink-0 text-admin-muted">{formatDate(row.viewedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </AdminCard>
  );
}
