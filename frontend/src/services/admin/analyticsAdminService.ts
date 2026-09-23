import type { AnalyticsRange, AnalyticsSnapshot, DashboardStats } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/** Analytics and dashboard KPIs. */

export const RANGES: { value: AnalyticsRange; label: string; shortLabel: string }[] = [
  { value: "today", label: "Today", shortLabel: "Today" },
  { value: "7d", label: "Last 7 days", shortLabel: "7D" },
  { value: "30d", label: "Last 30 days", shortLabel: "30D" },
  { value: "3m", label: "Last 3 months", shortLabel: "3M" },
  { value: "1y", label: "Last year", shortLabel: "1Y" },
];

export function getAnalytics(range: AnalyticsRange): Promise<AnalyticsSnapshot> {
  return adminDataSource.getAnalytics(range);
}

export function getDashboard(): Promise<DashboardStats> {
  return adminDataSource.getDashboard();
}

export function rangeLabel(range: AnalyticsRange): string {
  return RANGES.find((entry) => entry.value === range)?.label ?? "Last 30 days";
}
