import { ApiError, apiDownload, apiGet, apiPost, apiPut, apiDelete, apiUrl, getToken, query } from "@/services/api/client";
import type {
  BulkLabelResult,
  FulfilmentSettings,
  LabelOverview,
  OrderPackingCard,
  PackageInput,
  PackingJob,
  PackingPriority,
  PackingQueue,
  PackingQueueFilters,
  PackingSummary,
  PickException,
  StaffRef,
} from "@/types/packing";

/**
 * Portal calls for packing (permission `packing`) and shipping labels
 * (`shipments`). Every permission is checked by the server; the portal only
 * shows what it was allowed to read. See docs/packing-and-labels.md.
 */

const ADMIN = { auth: "admin" } as const;
const enc = encodeURIComponent;

/* ------------------------------------------------------------------ packing */

export function listPackingQueue(filters: PackingQueueFilters = {}): Promise<PackingQueue> {
  return apiGet(`/admin/packing${query({ ...filters, overdue: filters.overdue ? true : undefined })}`, ADMIN);
}

export function getPackingSummary(): Promise<PackingSummary> {
  return apiGet("/admin/packing/summary", ADMIN);
}

export function listPackingStaff(): Promise<StaffRef[]> {
  return apiGet("/admin/packing/staff", ADMIN);
}

export function getPackingJob(id: number): Promise<PackingJob> {
  return apiGet(`/admin/packing/${id}`, ADMIN);
}

export function getOrderPacking(orderId: string): Promise<OrderPackingCard> {
  return apiGet(`/admin/orders/${enc(orderId)}/packing`, ADMIN);
}

export function assignPacking(id: number, adminId: string | null): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/assign`, { adminId }, ADMIN);
}

export function setPackingPriority(id: number, priority: PackingPriority): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/priority`, { priority }, ADMIN);
}

export function startPicking(id: number): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/start-picking`, undefined, ADMIN);
}

export function pickLine(id: number, lineId: number, quantity: number): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/lines/${lineId}/pick`, { quantity }, ADMIN);
}

export function pickAll(id: number): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/pick-all`, undefined, ADMIN);
}

export function recordException(
  id: number,
  lineId: number,
  input: { type: PickException; quantity: number; note: string },
): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/lines/${lineId}/exception`, input, ADMIN);
}

export function clearException(id: number, lineId: number): Promise<PackingJob> {
  return apiDelete(`/admin/packing/${id}/lines/${lineId}/exception`, ADMIN);
}

export function recordDamaged(id: number, lineId: number, input: { quantity: number; note: string }):
  Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/lines/${lineId}/damaged-stock`, input, ADMIN);
}

export function completePicking(id: number, overrideReason?: string): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/complete-picking`, overrideReason ? { overrideReason } : undefined, ADMIN);
}

export function startPacking(id: number): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/start-packing`, undefined, ADMIN);
}

export function addPackage(id: number, input: PackageInput): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/packages`, input, ADMIN);
}

export function updatePackage(id: number, packageId: number, input: PackageInput): Promise<PackingJob> {
  return apiPut(`/admin/packing/${id}/packages/${packageId}`, input, ADMIN);
}

export function removePackage(id: number, packageId: number): Promise<PackingJob> {
  return apiDelete(`/admin/packing/${id}/packages/${packageId}`, ADMIN);
}

export function markPacked(id: number, input: { confirm?: boolean; overrideReason?: string } = {}):
  Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/packed`, input, ADMIN);
}

export function reopenPacking(id: number, target: "picking" | "packing", reason: string): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/reopen`, { target, reason }, ADMIN);
}

/**
 * Hand the packages to the order's shipment, creating it with the default
 * courier when there is none. A Manual courier answers SHIPMENT_DETAILS_REQUIRED
 * until the courier name and AWB are given. One `idempotencyKey` per click.
 */
export function markReady(
  id: number,
  input: { idempotencyKey: string; providerCode?: string; courierName?: string; awb?: string },
): Promise<PackingJob> {
  return apiPost(`/admin/packing/${id}/ready`, input, ADMIN);
}

/* ------------------------------------------------------------------- labels */

export function getShipmentLabels(shipmentId: number): Promise<LabelOverview> {
  return apiGet(`/admin/shipments/${shipmentId}/labels`, ADMIN);
}

export function generateShipmentLabel(shipmentId: number, format?: string): Promise<LabelOverview> {
  return apiPost(`/admin/shipments/${shipmentId}/labels`, format ? { format } : undefined, ADMIN);
}

export function regenerateShipmentLabel(shipmentId: number, reason: string, format?: string): Promise<LabelOverview> {
  return apiPost(`/admin/shipments/${shipmentId}/labels/regenerate`, { reason, ...(format ? { format } : {}) }, ADMIN);
}

export function cancelShipmentLabel(shipmentId: number, reason: string): Promise<LabelOverview> {
  return apiPost(`/admin/shipments/${shipmentId}/labels/cancel`, { reason }, ADMIN);
}

export function bulkGenerateLabels(shipmentIds: number[], format?: string): Promise<BulkLabelResult> {
  return apiPost("/admin/shipping-labels/bulk", { shipmentIds, ...(format ? { format } : {}) }, ADMIN);
}

/* ----------------------------------------------------------------- settings */

export function getFulfilmentSettings(): Promise<FulfilmentSettings> {
  return apiGet("/admin/fulfilment/settings", ADMIN);
}

export function saveFulfilmentSettings(input: Partial<FulfilmentSettings>): Promise<FulfilmentSettings> {
  // The formats and package types are read-only lists; only the settings are sent.
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "formats" && key !== "packageTypes"));
  return apiPut("/admin/fulfilment/settings", body, ADMIN);
}

/* -------------------------------------------------------------------- files */

/**
 * A PDF (or ZIP) the API builds, fetched with the admin token. A plain link
 * can't carry the Authorization header, so files are fetched and handed to
 * the browser as an object URL.
 */
async function fetchFile(path: string): Promise<{ blob: Blob; name: string; skipped: string }> {
  const headers: Record<string, string> = {};
  const token = getToken("admin");
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(apiUrl(path), { headers, cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    let message = "The file couldn't be made. Please try again.";
    let code = "FILE_FAILED";
    try {
      const body = (await response.json()) as { message?: string; error_code?: string };
      message = body.message ?? message;
      code = body.error_code ?? code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, response.status, code);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  return {
    blob: await response.blob(),
    name: /filename="([^"]+)"/.exec(disposition)?.[1] ?? "document.pdf",
    skipped: response.headers.get("x-labels-skipped") ?? "",
  };
}

/** Open a PDF in a new tab. The tab is opened first, so the browser treats it as the click's own popup. */
export async function openPdf(path: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const { blob } = await fetchFile(path);
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** Print a PDF without leaving the page: loaded into a hidden frame and printed from there. */
export async function printPdf(path: string): Promise<{ skipped: string }> {
  const { blob, skipped } = await fetchFile(path);
  const url = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.setAttribute("aria-hidden", "true");
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    }
  };
  document.body.appendChild(frame);
  return { skipped };
}

export const labelPreviewPath = (labelId: number) => `/admin/shipping-labels/${labelId}/preview`;
export const packingSlipPath = (jobId: number, prices?: boolean) =>
  `/admin/packing/${jobId}/slip${query({ prices })}`;
export const bulkLabelPath = (shipmentIds: number[], mode: "zip" | "merged") =>
  `/admin/shipping-labels/bulk-download${query({ ids: shipmentIds.join(","), mode })}`;

export function downloadLabel(labelId: number): Promise<void> {
  return apiDownload(`/admin/shipping-labels/${labelId}/download`, "admin", `label-${labelId}.pdf`);
}

export function downloadPackingSlip(jobId: number, prices?: boolean): Promise<void> {
  return apiDownload(`/admin/packing/${jobId}/slip${query({ prices, download: true })}`, "admin",
    `packing-slip-${jobId}.pdf`);
}

export function downloadLabelsZip(shipmentIds: number[]): Promise<void> {
  return apiDownload(bulkLabelPath(shipmentIds, "zip"), "admin", "labels.zip");
}
