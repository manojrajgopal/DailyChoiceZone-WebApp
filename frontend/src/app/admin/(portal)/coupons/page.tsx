import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminCouponsView } from "@/components/admin/views/AdminCouponsView";

export const metadata: Metadata = { title: "Coupons" };

export default function Page() {
  // Suspense: the view reads ?new=1&segmentId= (static export needs a boundary for useSearchParams).
  return (
    <Suspense fallback={null}>
      <AdminCouponsView />
    </Suspense>
  );
}
