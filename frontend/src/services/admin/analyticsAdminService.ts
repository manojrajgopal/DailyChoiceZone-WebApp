import type { AnalyticsRange, AnalyticsSnapshot, DashboardStats } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/** Analytics and dashboard KPIs. */

/**
 * The ranges the dashboard and reports offer.
 *
 * Module state rather than a constant: the list is configuration, and
 * `rangeLabel` has to answer while a chart renders. `siteService` fills it in.
 * Components read the same list through `useSiteContent`.
 */
let ranges: { value: string; label: string; shortLabel: string }[] = [];

export function setAnalyticsRanges(
  next: { value: string; label: string; shortLabel: string }[],
): void {
  ranges = next;
}

export function getAnalytics(range: AnalyticsRange): Promise<AnalyticsSnapshot> {
  return adminDataSource.getAnalytics(range);
}

export function getDashboard(): Promise<DashboardStats> {
  return adminDataSource.getDashboard();
}

export function rangeLabel(range: AnalyticsRange): string {
  return ranges.find((entry) => entry.value === range)?.label ?? range;
}
