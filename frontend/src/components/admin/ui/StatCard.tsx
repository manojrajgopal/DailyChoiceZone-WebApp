import Link from "next/link";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  IndianRupee,
  Package,
  ShoppingCart,
  Users,
} from "lucide-react";

import type { DashboardStat } from "@/types/admin";

import { cn } from "@/lib/utils/cn";
import { formatCompactINR } from "@/lib/utils/format";

const ICONS = {
  sales: IndianRupee,
  orders: ShoppingCart,
  customers: Users,
  products: Package,
  alert: AlertTriangle,
} as const;

/**
 * A KPI tile.
 *
 * A hero number, not a chart — one value has no shape to plot, and a sparkline
 * beside it would imply a trend the tile does not actually carry.
 *
 * The delta is the only place colour appears, and it always ships with an arrow
 * and a sign, so the direction never depends on distinguishing green from red.
 */
export function StatCard({ stat }: { stat: DashboardStat }) {
  const Icon = ICONS[stat.icon];
  const isAlert = stat.icon === "alert" && stat.value > 0;

  const value =
    stat.format === "currency"
      ? formatCompactINR(stat.value)
      : stat.value.toLocaleString("en-IN");

  const rising = (stat.delta ?? 0) >= 0;
  const DeltaIcon = rising ? ArrowUpRight : ArrowDownRight;

  return (
    <Link
      href={stat.href}
      className={cn(
        "group flex flex-col rounded-[3px] border bg-admin-surface p-4 transition-colors",
        isAlert
          ? "border-[#fab219]/40 hover:border-[#fab219]"
          : "border-admin-border hover:border-admin-border-strong",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
          {stat.label}
        </span>
        <Icon
          className={cn("h-3.5 w-3.5 shrink-0", isAlert ? "text-[#b07500]" : "text-admin-faint")}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </span>

      <span className="mt-2.5 text-xl font-semibold tracking-tight text-admin-ink tabular-nums">
        {value}
      </span>

      {stat.delta !== null ? (
        <span className="mt-1.5 flex items-center gap-1 text-[0.6875rem] tabular-nums">
          <DeltaIcon
            className={cn("h-3 w-3", rising ? "text-[#0a6b0a]" : "text-[#a32424]")}
            strokeWidth={2.25}
            aria-hidden="true"
          />
          <span className={rising ? "text-[#0a6b0a]" : "text-[#a32424]"}>
            {rising ? "+" : ""}
            {stat.delta}%
          </span>
          <span className="text-admin-faint">vs previous period</span>
        </span>
      ) : (
        <span className="mt-1.5 text-[0.6875rem] text-admin-faint">
          {isAlert ? "Needs restocking" : "Current total"}
        </span>
      )}
    </Link>
  );
}
