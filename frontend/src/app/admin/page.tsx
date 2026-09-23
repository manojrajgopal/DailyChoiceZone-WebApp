"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";

/**
 * `/admin` sends you to the dashboard.
 *
 * A client-side redirect rather than `redirect()` from a server component,
 * because this app is exported as static HTML and there is no server to issue
 * one.
 */
export default function AdminIndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/dashboard");
  }, [router]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-admin-plane">
      <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading admin" />
    </div>
  );
}
