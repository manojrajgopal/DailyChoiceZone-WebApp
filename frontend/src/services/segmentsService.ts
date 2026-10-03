/**
 * Customer segments, the rule builder's field registry, RFM settings and the
 * metrics refresh (permission `segments`; the CSV export needs `segments-export`).
 * Contract: docs/customer-segmentation.md §6.
 *
 * Calls throw `ApiError`; the views turn its `code`, `message` and `details`
 * into a field error, a toast, or the "your role doesn't include segments" state.
 */
import type {
  MetricsRefreshResult,
  SegmentDetail,
  SegmentFieldRegistry,
  SegmentInput,
  SegmentMatch,
  SegmentMemberPage,
  SegmentPage,
  SegmentPreview,
  SegmentRule,
  SegmentationSettings,
  SegmentationSettingsResponse,
  SegmentationSummary,
} from "@/types/segments";

import { apiDownload, apiGet, apiPost, apiPut, query } from "@/services/api/client";

const ADMIN = { auth: "admin" } as const;

export interface SegmentFilters {
  q?: string;
  /** The server's default is `active`. */
  status?: "active" | "archived" | "all" | "";
  kind?: "default" | "custom" | "";
  page?: number;
  pageSize?: number;
}

export function listSegments(filters: SegmentFilters = {}): Promise<SegmentPage> {
  return apiGet(`/admin/segments${query({ ...filters })}`, ADMIN);
}

/** The field registry: the single source of truth for the builder. */
export function getSegmentFields(): Promise<SegmentFieldRegistry> {
  return apiGet(`/admin/segments/fields`, ADMIN);
}

/** Count and first page of the customers unsaved rules match. Nothing is written. */
export function previewSegment(
  rules: { match: SegmentMatch; rules: SegmentRule[] },
  paging: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<SegmentPreview> {
  return apiPost(`/admin/segments/preview`, { ...rules, ...paging }, { ...ADMIN, signal });
}

export function createSegment(input: Required<Pick<SegmentInput, "name" | "match" | "rules">> & SegmentInput): Promise<SegmentDetail> {
  return apiPost(`/admin/segments`, input, ADMIN);
}

export function getSegment(segmentId: number): Promise<SegmentDetail> {
  return apiGet(`/admin/segments/${segmentId}`, ADMIN);
}

export function updateSegment(segmentId: number, input: SegmentInput): Promise<SegmentDetail> {
  return apiPut(`/admin/segments/${segmentId}`, input, ADMIN);
}

export function recalculateSegment(segmentId: number): Promise<SegmentDetail> {
  return apiPost(`/admin/segments/${segmentId}/recalculate`, {}, ADMIN);
}

export function archiveSegment(segmentId: number): Promise<SegmentDetail> {
  return apiPost(`/admin/segments/${segmentId}/archive`, {}, ADMIN);
}

export function restoreSegment(segmentId: number): Promise<SegmentDetail> {
  return apiPost(`/admin/segments/${segmentId}/restore`, {}, ADMIN);
}

export function listSegmentMembers(
  segmentId: number,
  filters: { q?: string; page?: number; pageSize?: number } = {},
): Promise<SegmentMemberPage> {
  return apiGet(`/admin/segments/${segmentId}/members${query({ ...filters })}`, ADMIN);
}

/** Every member as CSV (unmasked), downloaded with the admin token. The server names the file. */
export function exportSegment(segmentId: number, slug = String(segmentId)): Promise<void> {
  return apiDownload(`/admin/segments/${segmentId}/export`, "admin", `segment-${slug}.csv`);
}

export function getSegmentationSettings(): Promise<SegmentationSettingsResponse> {
  return apiGet(`/admin/segments/settings`, ADMIN);
}

export function saveSegmentationSettings(settings: SegmentationSettings): Promise<SegmentationSettingsResponse> {
  return apiPut(`/admin/segments/settings`, settings, ADMIN);
}

/** A full metrics refresh now, then every active segment recalculated. */
export function refreshSegmentMetrics(): Promise<MetricsRefreshResult> {
  return apiPost(`/admin/segments/metrics/refresh`, {}, { ...ADMIN, timeoutMs: 120_000 });
}

export function getSegmentationSummary(): Promise<SegmentationSummary> {
  return apiGet(`/admin/segments/summary`, ADMIN);
}
