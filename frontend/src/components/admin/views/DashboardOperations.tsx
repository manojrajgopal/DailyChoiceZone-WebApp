"use client";

import Link from "next/link";

import { AdminCard } from "@/components/admin/ui/AdminChrome";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatMoney } from "@/lib/money";
import { getAuthMethods } from "@/services/admin/authMethodsAdminService";
import { getPackingSummary } from "@/services/admin/packingAdminService";
import { getRefundSummary } from "@/services/admin/refundsAdminService";
import { getSearchAnalytics } from "@/services/admin/searchAdminService";
import { getSegmentationSummary } from "@/services/segmentsService";

type Row = { label: string; value: string; href: string; alert?: boolean };

/**
 * Today's operational numbers from the newer modules — packing and labels,
 * refunds, segments, search and sign-ins — each read from its own summary
 * endpoint. Each module is checked by its own permission on the server; a
 * module the viewer's role can't see simply isn't shown.
 */
export function DashboardOperations() {
  const packing = useAdminResource(() => getPackingSummary(), []);
  const refunds = useAdminResource(() => getRefundSummary(), []);
  const segments = useAdminResource(() => getSegmentationSummary(), []);
  const search = useAdminResource(() => getSearchAnalytics("7d"), []);
  const auth = useAdminResource(() => getAuthMethods(), []);

  const groups: { title: string; rows: Row[] }[] = [];
  if (packing.data) {
    const p = packing.data;
    groups.push({ title: "Packing & labels", rows: [
      { label: "Waiting to pick", value: String(p.waitingToPick), href: "/admin/packing?status=pending" },
      { label: "Waiting to pack", value: String(p.waitingToPack), href: "/admin/packing?status=picked" },
      { label: "Overdue", value: String(p.overdue), href: "/admin/packing?overdue=1", alert: p.overdue > 0 },
      { label: "Labels to print", value: String(p.labelsPending), href: "/admin/shipments" },
      { label: "Label failures", value: String(p.labelFailures), href: "/admin/shipments", alert: p.labelFailures > 0 },
    ] });
  }
  if (refunds.data) {
    const r = refunds.data;
    groups.push({ title: "Refunds", rows: [
      { label: "Need approval", value: String(r.awaitingApproval), href: "/admin/billing/refunds?awaiting=1",
        alert: r.awaitingApproval > 0 },
      { label: "Failed", value: String(r.failed), href: "/admin/billing/refunds?status=failed", alert: r.failed > 0 },
      { label: "Refunded today", value: formatMoney(r.refundedToday), href: "/admin/billing/refunds?status=completed" },
    ] });
  }
  if (segments.data) {
    const s = segments.data;
    groups.push({ title: "Customers", rows: [
      { label: "New in 30 days", value: s.newCustomers30d.toLocaleString("en-IN"), href: "/admin/customers/segments" },
      { label: "VIP", value: s.vip.toLocaleString("en-IN"), href: "/admin/customers/segments" },
      { label: "At risk", value: s.atRisk.toLocaleString("en-IN"), href: "/admin/customers/segments" },
    ] });
  }
  if (search.data) {
    const t = search.data.totals;
    groups.push({ title: "Search (7 days)", rows: [
      { label: "Searches", value: t.searches.toLocaleString("en-IN"), href: "/admin/search" },
      { label: "No results", value: `${t.zeroResultRate}%`, href: "/admin/search", alert: t.zeroResultRate >= 20 },
      { label: "Click-through", value: `${t.ctr}%`, href: "/admin/search" },
    ] });
  }
  if (auth.data?.summary) {
    const a = auth.data.summary;
    groups.push({ title: "Sign-ins today", rows: [
      { label: "Sign-ins", value: String(a.signInsToday), href: "/admin/settings/authentication" },
      { label: "Codes sent", value: String(a.otpSentToday), href: "/admin/settings/authentication" },
      { label: "Failures", value: String(a.otpSendFailuresToday + a.oauthFailuresToday),
        href: "/admin/settings/authentication", alert: a.otpSendFailuresToday + a.oauthFailuresToday > 0 },
    ] });
  }

  if (groups.length === 0) return null;

  return (
    <AdminCard title="Fulfilment & customers" description="Live from packing, refunds, segments, search and sign-in.">
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-5">
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3 className="mb-1.5 text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">{group.title}</h3>
            <dl className="flex flex-col gap-1">
              {group.rows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3 text-xs">
                  <dt className="text-admin-muted">{row.label}</dt>
                  <dd>
                    <Link href={row.href}
                      className={row.alert ? "font-medium tabular-nums text-[#a12b2b] hover:underline"
                        : "tabular-nums text-admin-ink hover:text-copper-700"}>
                      {row.value}
                    </Link>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </AdminCard>
  );
}
