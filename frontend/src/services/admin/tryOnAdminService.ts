/**
 * Virtual try-on, for the store (docs/virtual-try-on.md).
 *
 * The dashboard, request log, credentials (write-only secrets: a saved token
 * is never sent back, only its mask), providers and models, kinds of try-on
 * and the categories mapped to them, plan entitlements, customers' access
 * requests and allocations, and the feature's settings.
 */

import { apiDelete, apiGet, apiPost, apiPut, query } from "@/services/api/client";

const ADMIN = { auth: "admin" } as const;
const BASE = "/admin/try-on";

/* -------------------------------------------------------------------- types */

export interface Breakdown {
  key: string;
  label: string;
  requests: number;
  succeeded: number;
  failed: number;
  successRate: number;
  badge?: string;
  cost?: number;
}

export interface RequestBrief {
  id: string;
  customerId: string;
  productId: string | null;
  productName: string;
  capability: string;
  model: string;
  credentialLabel: string;
  status: string;
  badge: string;
  error: string;
  createdAt: string;
  durationMs: number | null;
}

export interface StorageStatus {
  configured: string;
  active: "s3" | "ephemeral" | "none";
  s3Ready: boolean;
  s3Problem: string;
  bucket: string;
  prefix: string;
  encryption: string;
  ephemeralTtlMinutes: number;
  permanentAvailable: boolean;
}

export interface CredentialCounts {
  total: number;
  hidden: number;
  deleted: number;
  active: number;
  disabled: number;
  invalid: number;
  rate_limited: number;
  unhealthy: number;
  healthy: number;
  unvalidated: number;
  check_failed: number;
  dedicated: number;
}

export interface Overview {
  totals: {
    requests: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    successRate: number;
    failureRate: number;
    inProgress: number;
    queued: number;
    averageSeconds: number | null;
    estimatedCost: number | null;
    costCurrency: string | null;
  };
  providers: {
    active: number;
    inactive: number;
    items: {
      id: string;
      name: string;
      kind: string;
      enabled: boolean;
      health: string;
      healthDetail: string;
      lastCheckedAt: string | null;
      models: number;
      enabledModels: number;
    }[];
  };
  credentials: CredentialCounts;
  storage: StorageStatus;
  pendingCleanup: number;
  byProvider: Breakdown[];
  byModel: Breakdown[];
  byCapability: Breakdown[];
  byCategory: Breakdown[];
  byPlan: Breakdown[];
  byCustomer: Breakdown[];
  byCredential: {
    key: string;
    label: string;
    provider: string;
    attempts: number;
    succeeded: number;
    failed: number;
    lastUsedAt: string | null;
  }[];
  byError: Breakdown[];
  trend: { granularity: "day" | "week" | "month"; points: { period: string; requests: number; succeeded: number; failed: number }[] };
  recentSucceeded: RequestBrief[];
  recentFailed: RequestBrief[];
}

export interface RequestFilters {
  from?: string;
  to?: string;
  providerId?: string;
  modelId?: string;
  credentialId?: string;
  customerId?: string;
  planId?: string;
  capability?: string;
  categoryId?: string;
  status?: string;
  errorCode?: string;
  q?: string;
}

export interface AdminTryOnRequest {
  id: string;
  customerId: string;
  productId: string | null;
  productName: string;
  color: string;
  size: string;
  capability: string;
  capabilityName: string;
  categoryId: string;
  providerId: string | null;
  providerName: string;
  modelId: string | null;
  modelName: string;
  credentialId: string | null;
  credentialLabel: string;
  allocationId: string | null;
  source: string;
  planId: string | null;
  planName: string;
  status: string;
  badge: string;
  error: { code: string; badge: string; explanation: string; customerMessage: string; retryable: boolean } | null;
  attempts: number;
  retriesUsed: number;
  storageMode: string;
  resultStorage: string;
  resultExpiresAt: string | null;
  resultDeletedAt: string | null;
  deletedByCustomer: boolean;
  feedbackRating: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  technicalDetail?: string;
  feedbackComment?: string;
  attemptLog?: {
    number: number;
    providerId: string;
    modelId: string;
    credentialId: string;
    credentialLabel: string;
    outcome: string;
    errorCode: string;
    badge: string;
    explanation: string;
    technicalDetail: string;
    latencyMs: number;
    startedAt: string;
  }[];
}

export interface Paged<T> {
  items: T[];
  counts?: Record<string, number>;
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface Credential {
  id: string;
  providerId: string;
  label: string;
  masked: string;
  status: string;
  /** deleted | disabled | invalid | rate_limited | unhealthy | check_failed | unvalidated | healthy */
  state: string;
  hidden: boolean;
  autoSelect: boolean;
  priority: number;
  scope: "shared" | "dedicated";
  dedicatedCustomerId: string | null;
  modelIds: string[];
  capabilityKeys: string[];
  categoryIds: string[];
  dailyLimit: number | null;
  monthlyLimit: number | null;
  validationStatus: string;
  lastValidatedAt: string | null;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastErrorCode: string;
  lastError: string;
  lastErrorAt: string | null;
  rateLimitInfo: Record<string, string> | null;
  successCount: number;
  failureCount: number;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  createdBy: string;
}

export interface EncryptionStatus {
  configured: boolean;
  usingFallback: boolean;
  available: boolean;
  previousKeySet: boolean;
}

export interface CredentialInput {
  providerId?: string;
  secret?: string;
  label?: string;
  hidden?: boolean;
  autoSelect?: boolean;
  priority?: number;
  scope?: "shared" | "dedicated";
  dedicatedCustomerId?: string | null;
  modelIds?: string[];
  capabilityKeys?: string[];
  categoryIds?: string[];
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  validateNow?: boolean;
}

export interface CredentialUsage {
  credential: Credential;
  customers: { customerId: string; name: string; requests: number; succeeded: number }[];
  plans: { source: string; plan: string; requests: number }[];
  healthChecks: { ok: boolean; code: string; detail: string; latencyMs: number; checkedAt: string }[];
}

export interface Capability {
  key: string;
  family: string;
  name: string;
  description: string;
  subjectKind: string;
  inputRules: { minWidth?: number; minHeight?: number; maxMegapixels?: number; portrait?: boolean };
  guidance: string[];
  status: "enabled" | "disabled" | "coming_soon";
  state: string;
  sortOrder: number;
}

export interface Mapping {
  id: number;
  categoryId: string;
  subcategory: string;
  capabilityKey: string;
  enabled: boolean;
}

export interface CategoryOption {
  id: string;
  name: string;
  slug: string;
  subcategories: { slug: string; name: string }[];
}

export interface Adapter {
  key: string;
  providerKind: string;
  label: string;
  description: string;
  maxCapabilities: string[];
  configFields: Record<string, string>;
  needsSecret: boolean;
}

export interface Provider {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  timeoutSeconds: number;
  maxRetries: number;
  cooldownSeconds: number;
  health: string;
  healthDetail: string;
  lastCheckedAt: string | null;
}

export interface Model {
  id: string;
  providerId: string;
  name: string;
  description: string;
  adapterKey: string;
  adapterLabel: string;
  adapterAvailable: boolean;
  config: Record<string, unknown>;
  capabilities: string[];
  qualityTier: string;
  enabled: boolean;
  verified: boolean;
  priority: number;
  avgSeconds: number;
  costPerCall: number | null;
  costCurrency: string;
  routable: boolean;
}

export interface TryOnRules {
  enabled: boolean;
  perPeriod: number | null;
  perDay: number | null;
  concurrent: number;
  capabilities: string[];
  qualityTiers: string[];
  maxUploadMb: number;
  retention: "temporary" | "permanent";
  retentionDays: number;
  storageQuota: number | null;
  download: boolean;
  history: boolean;
  retriesPerRequest: number;
  allocationRequests: boolean;
  modelChoice: boolean;
}

export interface PlanEntitlement {
  id: string;
  name: string;
  active: boolean;
  durationMonths: number;
  tryOn: TryOnRules | null;
}

export interface TryOnSettings {
  enabled: boolean;
  trial: { enabled: boolean; generations: number; capabilities: string[] };
  usageWarningPercent: number;
  retentionReminderDays: number;
  lapsedGraceDays: number;
  submitPerHour: number;
  uploadsPerHour: number;
  feedback: boolean;
  privacyNotice: string;
  storage?: StorageStatus;
  encryption?: EncryptionStatus;
}

export interface AccessRequest {
  id: string;
  customerId: string;
  kind: "more_usage" | "dedicated";
  reason: string;
  capabilities: string[];
  expectedUsage: number;
  requestedModelId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  message: string;
  status: string;
  decidedAt: string | null;
  decidedBy: string;
  decisionNote: string;
  allocationId: string | null;
  createdAt: string;
}

export interface Allocation {
  id: string;
  customerId: string;
  requestId: string | null;
  kind: "allowance" | "dedicated_credential";
  dedicated: boolean;
  credentialId: string | null;
  credentialLabel: string;
  generations: number | null;
  used: number;
  remaining: number | null;
  perDay: number | null;
  capabilities: string[];
  startsAt: string;
  endsAt: string | null;
  status: string;
  note: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AllocationInput {
  customerId?: string;
  kind?: "allowance" | "dedicated_credential";
  credentialId?: string | null;
  generations?: number | null;
  perDay?: number | null;
  capabilities?: string[];
  startsOn?: string | null;
  endsOn?: string | null;
  note?: string;
  status?: "active" | "disabled";
}

export interface CleanupTask {
  id: number;
  storage: string;
  reason: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string;
  createdAt: string;
}

/* ---------------------------------------------------------------- dashboard */

export function getOverview(filters: RequestFilters & { granularity?: string } = {}): Promise<Overview> {
  return apiGet<Overview>(`${BASE}/overview${query({ ...filters })}`, ADMIN);
}

export function listRequests(filters: RequestFilters & { page?: number; pageSize?: number } = {}): Promise<Paged<AdminTryOnRequest>> {
  return apiGet(`${BASE}/requests${query({ ...filters })}`, ADMIN);
}

export function getRequest(id: string): Promise<AdminTryOnRequest> {
  return apiGet(`${BASE}/requests/${encodeURIComponent(id)}`, ADMIN);
}

export function requeueRequest(id: string): Promise<AdminTryOnRequest> {
  return apiPost(`${BASE}/requests/${encodeURIComponent(id)}/requeue`, {}, ADMIN);
}

/* -------------------------------------------------------------- credentials */

export function listCredentials(
  params: { includeHidden?: boolean; includeDeleted?: boolean; providerId?: string; state?: string } = {},
): Promise<{ items: Credential[]; counts: CredentialCounts; encryption: EncryptionStatus }> {
  return apiGet(`${BASE}/credentials${query({
    includeHidden: params.includeHidden || undefined,
    includeDeleted: params.includeDeleted || undefined,
    providerId: params.providerId,
    state: params.state,
  })}`, ADMIN);
}

export function addCredential(input: CredentialInput): Promise<Credential> {
  return apiPost(`${BASE}/credentials`, input, ADMIN);
}

export function addCredentials(input: {
  providerId: string;
  secrets: string;
  labelPrefix?: string;
  modelIds?: string[];
  capabilityKeys?: string[];
  categoryIds?: string[];
  priority?: number;
  hidden?: boolean;
}): Promise<{ added: Credential[]; skipped: { line: number; reason: string }[] }> {
  return apiPost(`${BASE}/credentials/bulk`, input, ADMIN);
}

export function updateCredential(id: string, input: CredentialInput): Promise<Credential> {
  return apiPut(`${BASE}/credentials/${encodeURIComponent(id)}`, input, ADMIN);
}

export function rotateCredential(id: string, secret: string): Promise<Credential> {
  return apiPut(`${BASE}/credentials/${encodeURIComponent(id)}/secret`, { secret }, ADMIN);
}

export type CredentialAction = "enable" | "disable" | "hide" | "unhide" | "validate";

export function credentialAction(id: string, action: CredentialAction): Promise<Credential> {
  return apiPost(`${BASE}/credentials/${encodeURIComponent(id)}/${action}`, {}, ADMIN);
}

export function deleteCredential(id: string): Promise<Credential> {
  return apiDelete(`${BASE}/credentials/${encodeURIComponent(id)}`, ADMIN);
}

export function credentialUsage(id: string): Promise<CredentialUsage> {
  return apiGet(`${BASE}/credentials/${encodeURIComponent(id)}/usage`, ADMIN);
}

export function reencryptCredentials(): Promise<{ reencrypted: number; unreadable: number }> {
  return apiPost(`${BASE}/credentials/reencrypt`, {}, ADMIN);
}

/* -------------------------------------------------- capabilities & mappings */

export function listCapabilities(): Promise<Capability[]> {
  return apiGet(`${BASE}/capabilities`, ADMIN);
}

export function saveCapability(input: Partial<Capability>, key?: string): Promise<Capability> {
  return key
    ? apiPut(`${BASE}/capabilities/${encodeURIComponent(key)}`, input, ADMIN)
    : apiPost(`${BASE}/capabilities`, input, ADMIN);
}

export function listMappings(): Promise<{ items: Mapping[]; categories: CategoryOption[] }> {
  return apiGet(`${BASE}/mappings`, ADMIN);
}

export function saveMapping(input: Partial<Mapping>, id?: number): Promise<Mapping> {
  return id
    ? apiPut(`${BASE}/mappings/${id}`, input, ADMIN)
    : apiPost(`${BASE}/mappings`, input, ADMIN);
}

export function deleteMapping(id: number): Promise<void> {
  return apiDelete(`${BASE}/mappings/${id}`, ADMIN);
}

export interface ProductTryOnSetting {
  productId: string;
  capabilityKey: string | null;
  optOut: boolean;
  garmentImageUrl: string;
  effectiveCapability: string | null;
  decidedBy: string;
  state: string;
}

export function getProductSetting(productId: string): Promise<ProductTryOnSetting> {
  return apiGet(`${BASE}/products/${encodeURIComponent(productId)}/setting`, ADMIN);
}

export function saveProductSetting(
  productId: string,
  input: { capabilityKey?: string | null; optOut?: boolean; garmentImageUrl?: string },
): Promise<ProductTryOnSetting> {
  return apiPut(`${BASE}/products/${encodeURIComponent(productId)}/setting`, input, ADMIN);
}

/* -------------------------------------------------------- providers & models */

export function listAdapters(): Promise<{ adapters: Adapter[]; providerKinds: string[] }> {
  return apiGet(`${BASE}/adapters`, ADMIN);
}

export function listProviders(): Promise<Provider[]> {
  return apiGet(`${BASE}/providers`, ADMIN);
}

export function saveProvider(input: Partial<Provider>, id?: string): Promise<Provider> {
  return id
    ? apiPut(`${BASE}/providers/${encodeURIComponent(id)}`, input, ADMIN)
    : apiPost(`${BASE}/providers`, input, ADMIN);
}

export function checkProvider(id: string): Promise<Provider> {
  return apiPost(`${BASE}/providers/${encodeURIComponent(id)}/check`, {}, ADMIN);
}

export function listModels(): Promise<Model[]> {
  return apiGet(`${BASE}/models`, ADMIN);
}

export function saveModel(input: Partial<Model>, id?: string): Promise<Model> {
  return id
    ? apiPut(`${BASE}/models/${encodeURIComponent(id)}`, input, ADMIN)
    : apiPost(`${BASE}/models`, input, ADMIN);
}

export function deleteModel(id: string): Promise<{ outcome: "deleted" | "disabled" }> {
  return apiDelete(`${BASE}/models/${encodeURIComponent(id)}`, ADMIN);
}

export function testModel(
  id: string,
  input: { person: File; garment: File; capability: string; credentialId?: string },
): Promise<{ ok: boolean; image?: string; code?: string; explanation?: string; detail?: string; latencyMs: number }> {
  const form = new FormData();
  form.append("person", input.person);
  form.append("garment", input.garment);
  form.append("capability", input.capability);
  if (input.credentialId) form.append("credentialId", input.credentialId);
  return apiPost(`${BASE}/models/${encodeURIComponent(id)}/test`, form, { ...ADMIN, timeoutMs: 600_000 });
}

/* ---------------------------------------------------------------- plans */

export function listPlanEntitlements(): Promise<{
  plans: PlanEntitlement[];
  trial: TryOnSettings["trial"];
  defaults: TryOnRules;
}> {
  return apiGet(`${BASE}/plans`, ADMIN);
}

export function savePlanEntitlement(planId: string, tryOn: TryOnRules | null): Promise<PlanEntitlement> {
  return apiPut(`${BASE}/plans/${encodeURIComponent(planId)}`, { tryOn }, ADMIN);
}

/* ------------------------------------------------------------- settings */

export function getSettings(): Promise<TryOnSettings> {
  return apiGet(`${BASE}/settings`, ADMIN);
}

export function saveSettings(input: Partial<TryOnSettings>): Promise<TryOnSettings> {
  const { storage: _storage, encryption: _encryption, ...rest } = input;
  void _storage;
  void _encryption;
  return apiPut(`${BASE}/settings`, rest, ADMIN);
}

export function listCleanup(page = 1): Promise<Paged<CleanupTask>> {
  return apiGet(`${BASE}/cleanup${query({ page })}`, ADMIN);
}

export function runCleanup(): Promise<{ done: number; failed: number }> {
  return apiPost(`${BASE}/cleanup/run`, {}, ADMIN);
}

/* ------------------------------------------------------- access & allocations */

export function listAccessRequests(
  params: { status?: string; customerId?: string; page?: number; pageSize?: number } = {},
): Promise<Paged<AccessRequest>> {
  return apiGet(`${BASE}/access-requests${query({ ...params })}`, ADMIN);
}

export function decideAccessRequest(
  id: string,
  decision: "approve" | "reject",
  input: { note?: string; allocation?: AllocationInput } = {},
): Promise<AccessRequest> {
  return apiPost(`${BASE}/access-requests/${encodeURIComponent(id)}/${decision}`, { note: input.note ?? "", allocation: input.allocation ?? {} }, ADMIN);
}

export function listAllocations(
  params: { status?: string; customerId?: string; page?: number; pageSize?: number } = {},
): Promise<Paged<Allocation>> {
  return apiGet(`${BASE}/allocations${query({ ...params })}`, ADMIN);
}

export function getAllocation(id: string): Promise<Allocation & { requests: AdminTryOnRequest[] }> {
  return apiGet(`${BASE}/allocations/${encodeURIComponent(id)}`, ADMIN);
}

export function createAllocation(input: AllocationInput): Promise<Allocation> {
  return apiPost(`${BASE}/allocations`, input, ADMIN);
}

export function updateAllocation(id: string, input: AllocationInput): Promise<Allocation> {
  return apiPut(`${BASE}/allocations/${encodeURIComponent(id)}`, input, ADMIN);
}

export function revokeAllocation(id: string): Promise<Allocation> {
  return apiPost(`${BASE}/allocations/${encodeURIComponent(id)}/revoke`, {}, ADMIN);
}

/* ------------------------------------------------------------------ labels */

export const STATE_LABELS: Record<string, string> = {
  healthy: "Healthy",
  unvalidated: "Not checked yet",
  check_failed: "Couldn't check",
  unhealthy: "Failing",
  invalid: "Invalid",
  rate_limited: "Rate limited",
  disabled: "Disabled",
  deleted: "Deleted",
};

export const STATE_TONES: Record<string, "good" | "warning" | "serious" | "critical" | "neutral" | "info"> = {
  healthy: "good",
  unvalidated: "neutral",
  check_failed: "warning",
  unhealthy: "serious",
  invalid: "critical",
  rate_limited: "warning",
  disabled: "neutral",
  deleted: "neutral",
};

export const REQUEST_TONES: Record<string, "good" | "warning" | "serious" | "critical" | "neutral" | "info"> = {
  succeeded: "good",
  queued: "info",
  processing: "info",
  retrying: "warning",
  failed: "critical",
  cancelled: "neutral",
  expired: "neutral",
};
