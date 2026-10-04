"use client";

import Link from "next/link";
import { useState } from "react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { FormSection } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { IdSelector } from "@/components/common/IdSelector";
import { useAdminResource } from "@/hooks/useAdminResource";
import { ApiError } from "@/services/api/client";
import { getProductSizeGuide, setProductSizeGuide } from "@/services/admin/discoveryAdminService";
import { toast } from "@/store/toastStore";

const SOURCE: Record<string, string> = {
  product: "This product's own guide",
  category: "Its category's guide",
  default: "The store's default guide",
  none: "No guide",
};

/**
 * The size guide a product shows, on its edit page: give it its own (over the
 * category's), or let it fall back. Warns when the guide doesn't cover every
 * size the product is sold in.
 */
export function ProductSizeGuidePanel({ productId }: { productId: string }) {
  const state = useAdminResource(() => getProductSizeGuide(productId), [productId], { enabled: Boolean(productId) });
  const [saving, setSaving] = useState(false);

  const save = async (sizeGuideId: string | null) => {
    setSaving(true);
    try {
      await setProductSizeGuide(productId, sizeGuideId);
      await state.reload();
      toast.success(sizeGuideId ? "Size guide assigned." : "Now using the category's guide.");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "That didn't save.");
    } finally {
      setSaving(false);
    }
  };

  const data = state.data;
  const missing = data?.guide?.sizeMatch?.missingFromGuide ?? [];

  return (
    <FormSection
      title="Size guide"
      description="Shown from the size picker. A product's own guide overrides its category's; otherwise the store default applies to products with sizes."
    >
      {state.error && !data ? (
        <div role="alert" className="text-xs text-admin-ink">
          The size guide didn&rsquo;t load.
          <AdminButton size="sm" className="ml-2" onClick={() => void state.reload()}>Try again</AdminButton>
        </div>
      ) : !data ? (
        <span aria-busy="true" aria-label="Loading size guide" className="block h-9 w-full animate-pulse rounded-[2px] bg-admin-border" />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-admin-muted">
            Showing: <span className="font-medium text-admin-ink">{SOURCE[data.source]}</span>
            {data.guide ? <> — {data.guide.name}</> : null}
          </p>
          {/* Chosen by Size guide ID; clearing falls back to the category's or the default. */}
          <IdSelector
            entity="size_guide"
            label="This product's own guide — Size guide ID"
            heading="This product's own guide"
            hint="None chosen: the category's guide or the store default applies."
            disabled={saving}
            value={data.assignedGuideId ?? null}
            onChange={(sizeGuideId) => void save(sizeGuideId)}
          />
          {missing.length > 0 ? (
            <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-admin-ink">
              <StatusBadge tone="warning">Check sizes</StatusBadge>
              The guide has no row for {missing.join(", ")}.
            </p>
          ) : data.guide ? (
            <p className="text-xs text-admin-muted">Every size this product comes in is in the guide.</p>
          ) : null}
          <Link href="/admin/size-guides" className="text-xs text-copper-700 underline underline-offset-2">
            Manage size guides
          </Link>
        </div>
      )}
    </FormSection>
  );
}
