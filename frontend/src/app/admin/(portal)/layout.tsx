"use client";

import { AdminShell } from "@/components/admin/layout/AdminShell";

/**
 * The portal layout.
 *
 * Sits in a route group so `/admin/login` can stay outside it — the login page
 * must not render the sidebar, and must not be behind the guard that would
 * redirect it to itself.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
