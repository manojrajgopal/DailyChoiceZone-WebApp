"use client";

import { AccountShell } from "@/components/account/AccountShell";
import { RecentlyViewedList } from "@/components/products/RecentlyViewedList";

/** Recently viewed, inside the account area: the account's own history, on every device. */
export function AccountRecentlyViewedView() {
  return (
    <AccountShell
      title="Recently viewed"
      description="The products you've looked at, newest first."
      breadcrumb={[{ label: "Recently viewed" }]}
    >
      <RecentlyViewedList />
    </AccountShell>
  );
}
