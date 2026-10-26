/**
 * Virtual try-on, for shoppers (docs/virtual-try-on.md).
 *
 * Which products can be tried on, the customer's allowance, uploading a
 * photo, starting a try-on and following it, and the history of results.
 * Every limit is enforced by the server; what this module reports is for
 * showing, not for deciding. Every call throws `ApiError`; its `message` is
 * written for people.
 */

import type { Product } from "@/types";

import { apiBlobUrl, apiDelete, apiGet, apiPost, apiPut, query } from "@/services/api/client";

const CUSTOMER = { auth: "customer" } as const;

/* -------------------------------------------------------------------- types */

/**
 * What a kind of try-on can do right now:
 * available — try it; unavailable — switched on but nothing can run it at the
 * moment; coming_soon — announced; unsupported — not offered.
 */
export type TryOnState = "available" | "unavailable" | "coming_soon" | "unsupported" | "off";

export interface TryOnCapability {
  key: string;
  name: string;
  family: string;
  description: string;
  subjectKind: string;
  state: TryOnState;
}

export interface TryOnCatalogue {
  enabled: boolean;
  storage: string;
  capabilities: TryOnCapability[];
  mappings: { category: string; subcategory: string; capability: string }[];
  /** Product id → its own capability (null: opted out). */
  productOverrides: Record<string, string | null>;
}

export interface TryOnAllocationSummary {
  id: string;
  kind: string;
  dedicated: boolean;
  generations: number | null;
  used: number;
  remaining: number | null;
  perDay: number | null;
  capabilities: string[];
  endsAt: string | null;
}

export interface TryOnEligibility {
  eligible: boolean;
  /** Why not: plan_ineligible | programme_off | signed_out. */
  reason: string;
  source: "plan" | "trial" | "allocation" | "none";
  planId: string | null;
  planName: string;
  perPeriod: number | null;
  usedThisPeriod: number;
  /** Null: unlimited. */
  remaining: number | null;
  perDay: number | null;
  usedToday: number;
  resetsAt: string | null;
  concurrent: number;
  inProgress: number;
  capabilities: string[];
  maxUploadMb: number;
  /** permanent | temporary | ephemeral (not saved at all). */
  retention: "permanent" | "temporary" | "ephemeral";
  retentionDays: number;
  ephemeralMinutes: number;
  storageQuota: number | null;
  storedResults: number;
  download: boolean;
  history: boolean;
  retriesPerRequest: number;
  allocationRequests: boolean;
  modelChoice: boolean;
  allocations: TryOnAllocationSummary[];
  trial: { limit: number; used: number } | null;
  enabled?: boolean;
  privacyNotice?: string;
  feedback?: boolean;
}

export interface TryOnOffer {
  productId: string;
  productName: string;
  state: TryOnState;
  reason: string;
  capability: {
    key: string;
    name: string;
    subjectKind: string;
    guidance: string[];
    inputRules: { minWidth?: number; minHeight?: number; maxMegapixels?: number };
  } | null;
  eligibility: TryOnEligibility | null;
  models: { id: string; name: string; qualityTier: string; avgSeconds: number }[];
  avgSeconds: number | null;
  privacyNotice: string;
  storage: { mode: string; ephemeralMinutes: number };
  feedback: boolean;
}

export interface TryOnPhoto {
  id: string;
  width: number;
  height: number;
  saved: boolean;
  storage: string;
  expiresAt: string | null;
  createdAt: string;
}

export type TryOnStatus = "queued" | "processing" | "retrying" | "succeeded" | "failed" | "cancelled" | "expired";

export interface TryOnRequest {
  id: string;
  status: TryOnStatus;
  product: { id: string | null; name: string; image: string | null };
  color: string;
  size: string;
  capability: { key: string; name: string };
  model: { name: string; qualityTier: string } | null;
  queuePosition: number | null;
  etaSeconds: number | null;
  error: { code: string; message: string; retryable: boolean } | null;
  canRetry: boolean;
  canCancel: boolean;
  result: {
    available: boolean;
    mode: "permanent" | "temporary" | "ephemeral";
    expiresAt: string | null;
    downloadable: boolean;
    deleted: boolean;
  };
  original: { available: boolean };
  favourite: boolean;
  feedback: { rating: number; comment: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface TryOnPage {
  items: TryOnRequest[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export type AccessRequestStatus = "pending" | "approved" | "rejected" | "withdrawn";

export interface TryOnAccessRequest {
  id: string;
  kind: "more_usage" | "dedicated";
  reason: string;
  capabilities: string[];
  expectedUsage: number;
  requestedModelId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  message: string;
  status: AccessRequestStatus;
  decidedAt: string | null;
  decisionNote: string;
  allocationId: string | null;
  createdAt: string;
}

export interface TryOnAllocation extends TryOnAllocationSummary {
  startsAt: string;
  status: "active" | "disabled" | "revoked" | "expired";
  createdAt: string;
}

export interface TryOnProductCard {
  id: string;
  slug: string;
  name: string;
  brand: string;
  price: number;
  originalPrice: number;
  image: string | null;
  category: string;
  subcategory: string;
  capability: string | null;
}

export const ACTIVE_STATUSES: TryOnStatus[] = ["queued", "processing", "retrying"];

/* ---------------------------------------------------------------- catalogue */

let catalogueRequest: Promise<TryOnCatalogue> | null = null;
let catalogueAt = 0;
const CATALOGUE_TTL_MS = 60_000;

/** What can be tried on — one small, shared request for every badge and button on a page. */
export function getTryOnCatalogue(): Promise<TryOnCatalogue> {
  if (!catalogueRequest || Date.now() - catalogueAt > CATALOGUE_TTL_MS) {
    catalogueAt = Date.now();
    catalogueRequest = apiGet<TryOnCatalogue>("/try-on/catalogue").catch((error) => {
      catalogueRequest = null;
      throw error;
    });
  }
  return catalogueRequest;
}

/** For tests: forget the cached catalogue. */
export function resetTryOnCatalogue(): void {
  catalogueRequest = null;
  catalogueAt = 0;
}

/** A product's capability and its state, worked out from the catalogue the same way the server does. */
export function tryOnFor(
  product: Pick<Product, "id" | "category" | "subcategory">,
  catalogue: TryOnCatalogue | null,
): { capability: TryOnCapability | null; state: TryOnState } {
  if (!catalogue || !catalogue.enabled) return { capability: null, state: "off" };
  let key: string | null | undefined;
  if (product.id in catalogue.productOverrides) key = catalogue.productOverrides[product.id];
  if (key === undefined) {
    const exact = catalogue.mappings.find(
      (m) => m.category === product.category && m.subcategory && m.subcategory === product.subcategory,
    );
    const whole = catalogue.mappings.find((m) => m.category === product.category && !m.subcategory);
    key = (exact ?? whole)?.capability ?? null;
  }
  if (!key) return { capability: null, state: "unsupported" };
  const capability = catalogue.capabilities.find((c) => c.key === key) ?? null;
  return { capability, state: capability?.state ?? "unsupported" };
}

export function listTryOnProducts(
  params: { capability?: string; category?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: TryOnProductCard[]; pagination: TryOnPage["pagination"] }> {
  return apiGet(`/try-on/products${query(params)}`);
}

export function getTryOnOffer(productId: string): Promise<TryOnOffer> {
  return apiGet<TryOnOffer>(`/try-on/products/${encodeURIComponent(productId)}`, CUSTOMER);
}

/* ---------------------------------------------------------------- allowance */

export function getTryOnEligibility(): Promise<TryOnEligibility> {
  return apiGet<TryOnEligibility>("/try-on/eligibility", CUSTOMER);
}

/* ------------------------------------------------------------------- photos */

export function uploadTryOnPhoto(file: File | Blob, options: { save?: boolean; capability?: string } = {}): Promise<TryOnPhoto> {
  const form = new FormData();
  form.append("file", file, file instanceof File ? file.name : "photo.jpg");
  form.append("save", options.save ? "true" : "false");
  if (options.capability) form.append("capability", options.capability);
  return apiPost<TryOnPhoto>("/try-on/photos", form, CUSTOMER);
}

export function listTryOnPhotos(): Promise<TryOnPhoto[]> {
  return apiGet<TryOnPhoto[]>("/try-on/photos", CUSTOMER);
}

export function deleteTryOnPhoto(id: string): Promise<{ deleted: boolean; pending: boolean }> {
  return apiDelete(`/try-on/photos/${encodeURIComponent(id)}`, CUSTOMER);
}

/* ----------------------------------------------------------------- requests */

/** A fresh key per press of "Try it on": repeating it never starts (or charges) a second try-on. */
export function newRequestKey(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `tryon-${random}`.slice(0, 64);
}

export function startTryOn(
  input: { productId: string; photoId: string; color?: string | null; size?: string | null; modelId?: string | null },
  key: string,
): Promise<TryOnRequest> {
  return apiPost<TryOnRequest>(
    "/try-on/requests",
    {
      productId: input.productId,
      photoId: input.photoId,
      color: input.color ?? "",
      size: input.size ?? "",
      modelId: input.modelId ?? null,
    },
    { ...CUSTOMER, headers: { "Idempotency-Key": key } },
  );
}

export function getTryOn(id: string): Promise<TryOnRequest> {
  return apiGet<TryOnRequest>(`/try-on/requests/${encodeURIComponent(id)}`, CUSTOMER);
}

export function listTryOns(
  params: { status?: string; productId?: string; from?: string; to?: string; favourites?: boolean; page?: number; pageSize?: number } = {},
): Promise<TryOnPage> {
  return apiGet<TryOnPage>(`/try-on/requests${query({ ...params, favourites: params.favourites || undefined })}`, CUSTOMER);
}

export function retryTryOn(id: string): Promise<TryOnRequest> {
  return apiPost<TryOnRequest>(`/try-on/requests/${encodeURIComponent(id)}/retry`, {}, CUSTOMER);
}

export function cancelTryOn(id: string): Promise<TryOnRequest> {
  return apiPost<TryOnRequest>(`/try-on/requests/${encodeURIComponent(id)}/cancel`, {}, CUSTOMER);
}

export function deleteTryOn(id: string): Promise<{ deleted: boolean; pending: boolean }> {
  return apiDelete(`/try-on/requests/${encodeURIComponent(id)}`, CUSTOMER);
}

/** The result (or the original photo) as an object URL; revoke it when done. */
export function tryOnImage(id: string, which: "result" | "original" = "result", signal?: AbortSignal): Promise<string> {
  return apiBlobUrl(`/try-on/requests/${encodeURIComponent(id)}/image?which=${which}`, "customer", signal);
}

/** A short-lived signed download link when the result is in cloud storage; null when it must be fetched. */
export async function tryOnDownloadLink(id: string): Promise<string | null> {
  const data = await apiGet<{ url: string | null }>(`/try-on/requests/${encodeURIComponent(id)}/download`, CUSTOMER);
  return data.url;
}

export function setTryOnFavourite(id: string, favourite: boolean): Promise<{ id: string; favourite: boolean }> {
  return apiPut(`/try-on/requests/${encodeURIComponent(id)}/favourite`, { favourite }, CUSTOMER);
}

export function rateTryOn(id: string, rating: number, comment = ""): Promise<{ id: string; rating: number }> {
  return apiPut(`/try-on/requests/${encodeURIComponent(id)}/feedback`, { rating, comment }, CUSTOMER);
}

/* ------------------------------------------------------------ extra access */

export function listAccessRequests(): Promise<TryOnAccessRequest[]> {
  return apiGet<TryOnAccessRequest[]>("/try-on/access-requests", CUSTOMER);
}

export function requestTryOnAccess(input: {
  kind: "more_usage" | "dedicated";
  reason: string;
  capabilities?: string[];
  expectedUsage?: number;
  startsOn?: string | null;
  endsOn?: string | null;
  message?: string;
}): Promise<TryOnAccessRequest> {
  return apiPost<TryOnAccessRequest>("/try-on/access-requests", input, CUSTOMER);
}

export function withdrawAccessRequest(id: string): Promise<TryOnAccessRequest> {
  return apiPost<TryOnAccessRequest>(`/try-on/access-requests/${encodeURIComponent(id)}/withdraw`, {}, CUSTOMER);
}

export function listMyAllocations(): Promise<TryOnAllocation[]> {
  return apiGet<TryOnAllocation[]>("/try-on/allocations", CUSTOMER);
}

/* ------------------------------------------------------------------ wording */

export function retentionText(e: Pick<TryOnEligibility, "retention" | "retentionDays" | "ephemeralMinutes">): string {
  if (e.retention === "ephemeral") {
    return `Results aren't saved: each is available for about ${e.ephemeralMinutes} minutes, then deleted. Download it to keep it.`;
  }
  if (e.retention === "permanent") return "Results are kept privately until you delete them.";
  return `Results are kept privately for ${e.retentionDays} day${e.retentionDays === 1 ? "" : "s"}, then deleted.`;
}

export function statusText(request: Pick<TryOnRequest, "status" | "queuePosition">): string {
  switch (request.status) {
    case "queued":
      return request.queuePosition && request.queuePosition > 1
        ? `In the queue — ${request.queuePosition - 1} ahead of you`
        : "Starting…";
    case "processing":
      return "Creating your try-on…";
    case "retrying":
      return "Taking a little longer — trying again…";
    case "succeeded":
      return "Ready";
    case "failed":
      return "Couldn't be created";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
  }
}
