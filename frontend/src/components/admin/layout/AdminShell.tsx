"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Drawer } from "@/components/ui/Dialog";
import { useAdminSession } from "@/hooks/useAdminSession";
import { adminDataSource } from "@/services/admin/admin-data-source.instance";
import { countLowStock } from "@/services/admin/inventoryAdminService";
import { countOpenOrders } from "@/services/admin/orderAdminService";
import { countPendingReviews } from "@/services/admin/reviewAdminService";

import { AdminHeader } from "./AdminHeader";
import { AdminSidebar, type NavBadges } from "./AdminSidebar";

const NO_BADGES: NavBadges = { lowStock: 0, openOrders: 0, pendingReviews: 0 };

/**
 * The frame every admin page renders inside.
 *
 * It owns three things so no page has to: the sidebar and header, the badge
 * counts they display, and the route guard.
 *
 * ## About the guard
 *
 * It waits for the session store to rehydrate before deciding — redirecting on
 * a session that has not loaded yet would bounce a signed-in admin to the login
 * screen on every refresh.
 *
 * It is **not** a security boundary, and does not need to be. The admin bundle
 * is already downloaded by the time this runs and anyone can bypass it — but
 * it contains no data. Every figure on every screen comes from an API call
 * that validates an administrator's token, so bypassing the guard reaches a
 * portal with nothing in it.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isSignedIn, isLoading } = useAdminSession();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [badges, setBadges] = useState<NavBadges>(NO_BADGES);

  const groups = adminDataSource.getNavigation();

  useEffect(() => {
    if (isLoading) return;
    if (!isSignedIn) router.replace("/admin/login");
  }, [isLoading, isSignedIn, router]);

  // Badge counts are re-read on navigation, so acting on a low-stock item or
  // approving a review updates the sidebar without a manual refresh.
  useEffect(() => {
    if (!isSignedIn) return;

    let active = true;
    Promise.all([countLowStock(), countOpenOrders(), countPendingReviews()])
      .then(([lowStock, openOrders, pendingReviews]) => {
        if (active) setBadges({ lowStock, openOrders, pendingReviews });
      })
      .catch(() => {
        if (active) setBadges(NO_BADGES);
      });

    return () => {
      active = false;
    };
  }, [isSignedIn, pathname]);

  if (isLoading || !isSignedIn) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-admin-plane">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh bg-admin-plane">
      {/* Fixed rail on desktop; a drawer below lg. */}
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="fixed inset-y-0 left-0 w-60">
          <AdminSidebar groups={groups} badges={badges} />
        </div>
      </aside>

      <Drawer
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        title="Admin navigation"
        side="left"
        bare
        className="w-60 bg-admin-ink"
      >
        <AdminSidebar groups={groups} badges={badges} onNavigate={() => setSidebarOpen(false)} />
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <AdminHeader onOpenSidebar={() => setSidebarOpen(true)} />
        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
