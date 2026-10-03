import type { Metadata } from "next";

import { RecentlyViewedList } from "@/components/products/RecentlyViewedList";
import { Breadcrumb } from "@/components/ui/Breadcrumb";

export const metadata: Metadata = {
  title: "Recently viewed",
  description: "The products you have looked at recently.",
  robots: { index: false, follow: false },
};

/**
 * Recently viewed, for anyone — a guest's list lives in their browser. Signed
 * in, the account page (`/account/recently-viewed`) shows the same list.
 */
export default function RecentlyViewedPage() {
  return (
    <div className="page-shell py-8 sm:py-10">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Recently viewed" }]} />
      <h1 className="mt-4 mb-8 font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">Recently viewed</h1>
      <RecentlyViewedList />
    </div>
  );
}
