"use client";

import Link from "next/link";
import { Star } from "lucide-react";

import { AdminButton, AdminButtonLink } from "@/components/admin/ui/AdminChrome";
import { FormSection } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { listProductSuppliers } from "@/services/suppliersService";

import { SupplierStatusBadge, isForbidden, rupees } from "./shared";

/**
 * Who supplies this product, on the product edit page. Links are managed
 * from each supplier's page; this is the read-only view from the product side.
 */
export function ProductSuppliersPanel({ productId }: { productId: string }) {
  const links = useAdminResource(() => listProductSuppliers(productId), [productId], { enabled: Boolean(productId) });
  const rows = links.data ?? [];

  return (
    <FormSection title="Suppliers" description="Who you buy this product from, and at what cost. Links are managed on each supplier's page.">
      {isForbidden(links.error) ? (
        <p className="text-xs text-admin-muted">Your role doesn&rsquo;t include suppliers.</p>
      ) : links.error && !links.data ? (
        <div role="alert" className="text-xs text-admin-ink">
          The suppliers didn&rsquo;t load.
          <AdminButton size="sm" className="ml-2" onClick={() => void links.reload()}>
            Try again
          </AdminButton>
        </div>
      ) : !links.data ? (
        <div aria-label="Loading suppliers" aria-busy="true" className="flex flex-col gap-2">
          <span className="block h-4 w-full animate-pulse rounded-[2px] bg-admin-border" />
          <span className="block h-4 w-2/3 animate-pulse rounded-[2px] bg-admin-border" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-[3px] bg-admin-raised px-3 py-6 text-center">
          <p className="text-sm text-admin-ink">No suppliers linked yet.</p>
          <p className="mt-1 text-xs text-admin-muted">Open a supplier and use &ldquo;Link a product&rdquo; to add this one.</p>
          <AdminButtonLink href="/admin/suppliers" size="sm" className="mt-3">
            Go to suppliers
          </AdminButtonLink>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-xs">
            <thead className="border-b border-admin-border text-admin-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Supplier</th>
                <th className="px-3 py-2 font-medium">Supplier SKU</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">MOQ</th>
                <th className="px-3 py-2 text-right font-medium">Lead time</th>
                <th className="py-2 pl-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="py-2.5 pr-3">
                    <Link href={`/admin/suppliers/detail?id=${encodeURIComponent(row.supplierId)}`} className="font-medium text-admin-ink hover:text-copper-700">
                      {row.supplierName}
                    </Link>
                    {row.preferred ? (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 text-[0.6875rem] text-[#1d5aa3]">
                        <Star className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                        Preferred
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-admin-muted">{row.supplierSku || "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-admin-ink">{rupees(row.purchaseCost)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.moq}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-admin-muted">{row.leadTimeDays === null ? "—" : `${row.leadTimeDays} d`}</td>
                  <td className={cn("py-2.5 pl-3")}>
                    <span className="flex flex-wrap gap-1">
                      <StatusBadge tone={row.status === "active" ? "good" : "neutral"}>{row.status === "active" ? "Active link" : "Inactive link"}</StatusBadge>
                      {row.supplierStatus !== "active" ? <SupplierStatusBadge status={row.supplierStatus} /> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </FormSection>
  );
}
