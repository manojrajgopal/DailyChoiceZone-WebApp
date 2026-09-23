import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminProductForm } from "@/components/admin/views/AdminProductForm";

export const metadata: Metadata = { title: "Edit product" };

/**
 * Edit a product, addressed as `/admin/products/edit?id=prod_001`.
 *
 * A query parameter rather than a path segment because the site is exported as
 * static HTML: a dynamic segment would need every id known at build time, and
 * a product the admin creates would have no page.
 */
export default function AdminEditProductPage() {
  return (
    <Suspense fallback={null}>
      <AdminProductForm mode="edit" />
    </Suspense>
  );
}
