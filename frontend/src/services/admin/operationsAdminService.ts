import { apiDelete, apiGet, apiPost, apiPut, query } from "@/services/api/client";

/**
 * Portal calls for delivery pincodes, abandoned carts, payment webhooks,
 * payment reconciliation and account-security settings.
 *
 * Every permission is checked by the server; the portal only shows what it
 * was allowed to read. Money arrives in rupees unless a field says otherwise.
 */

const ADMIN = { auth: "admin" } as const;

export interface Paged<T> {
  items: T[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

/* ---------------------------------------------------------------- pincodes */

export interface PincodeRow {
  id: number;
  pincode: string;
  city: string;
  district: string;
  state: string;
  serviceable: boolean;
  codAvailable: boolean;
  expressAvailable: boolean;
  minDays: number | null;
  maxDays: number | null;
  deliveryFee: number | null;
  courier: string;
  notes: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PincodeInput = Omit<PincodeRow, "id" | "createdAt" | "updatedAt">;

export interface PincodePage extends Paged<PincodeRow> {
  states: string[];
  counts: { active: number; inactive: number };
  settings: { restrictToListed: boolean };
}

export function listPincodes(filters: {
  q?: string;
  state?: string;
  active?: string;
  serviceable?: string;
  cod?: string;
  page?: number;
  pageSize?: number;
}): Promise<PincodePage> {
  return apiGet(`/admin/delivery/pincodes${query(filters)}`, ADMIN);
}

export function createPincode(input: PincodeInput): Promise<PincodeRow> {
  return apiPost("/admin/delivery/pincodes", input, ADMIN);
}

export function updatePincode(id: number, input: PincodeInput): Promise<PincodeRow> {
  return apiPut(`/admin/delivery/pincodes/${id}`, input, ADMIN);
}

export function deletePincode(id: number): Promise<void> {
  return apiDelete(`/admin/delivery/pincodes/${id}`, ADMIN);
}

export interface PincodeImportResult {
  created: number;
  updated: number;
  errorCount: number;
  errors: { line: number; pincode: string; error: string }[];
}

export function importPincodes(content: string): Promise<PincodeImportResult> {
  return apiPost("/admin/delivery/pincodes/import", { content }, ADMIN);
}

export function exportPincodes(): Promise<{ items: Record<string, unknown>[]; columns: string[] }> {
  return apiGet("/admin/delivery/pincodes/export", ADMIN);
}

export function saveDeliverySettings(settings: { restrictToListed: boolean }): Promise<{ restrictToListed: boolean }> {
  return apiPut("/admin/delivery/settings", settings, ADMIN);
}

/* ---------------------------------------------------------- abandoned carts */

export interface AbandonedCartLine {
  productId: string;
  name: string;
  slug: string;
  size: string;
  color: string;
  quantity: number;
  /** Paise, at the time of the snapshot. */
  unitPrice: number;
  image: string;
}

export interface AbandonedCart {
  id: number;
  status: "active" | "abandoned" | "recovered" | "converted" | "emptied" | "expired";
  customer: { id: string; name: string; email: string } | null;
  itemCount: number;
  cartValue: number;
  items: AbandonedCartLine[];
  startedAt: string;
  lastActivityAt: string;
  abandonedAt: string | null;
  remindersSent: number;
  lastReminderAt: string | null;
  clickedAt: string | null;
  recoveredAt: string | null;
  recoveredOrderId: string | null;
  recoveredValue: number | null;
}

export interface AbandonedCartMetrics {
  abandoned: number;
  openNow: number;
  recovered: number;
  reminded: number;
  recoveryRate: number | null;
  potentialRevenue: number;
  recoveredRevenue: number;
  byStatus: Record<string, number>;
}

export interface AbandonedCartSettings {
  enabled: boolean;
  abandonAfterMinutes: number;
  reminders: { afterMinutes: number }[];
  expireAfterDays: number;
}

export function listAbandonedCarts(filters: {
  status?: string;
  q?: string;
  days?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paged<AbandonedCart>> {
  return apiGet(`/admin/carts/abandoned${query(filters)}`, ADMIN);
}

export function abandonedCartMetrics(days: string): Promise<AbandonedCartMetrics> {
  return apiGet(`/admin/carts/abandoned/metrics${query({ days })}`, ADMIN);
}

export function getAbandonedCartSettings(): Promise<AbandonedCartSettings> {
  return apiGet("/admin/carts/settings", ADMIN);
}

export function saveAbandonedCartSettings(settings: AbandonedCartSettings): Promise<AbandonedCartSettings> {
  return apiPut("/admin/carts/settings", settings, ADMIN);
}

/* ---------------------------------------------------------------- webhooks */

export type WebhookStatus = "processing" | "retrying" | "processed" | "ignored" | "failed";

export interface WebhookEventRow {
  eventId: string;
  event: string;
  status: WebhookStatus;
  result: string;
  error: string;
  receivedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  attempts: number;
  duplicates: number;
  lastDuplicateAt: string | null;
  orderId: string | null;
  paymentId: string | null;
  gatewayPaymentId: string | null;
  refundId: string | null;
  replayable: boolean;
  durationMs: number | null;
}

export interface WebhookEventDetail extends WebhookEventRow {
  payload: Record<string, unknown> | null;
  orderNumber: string | null;
  attemptLog: {
    number: number;
    trigger: "delivery" | "redelivery" | "replay";
    adminId: string | null;
    startedAt: string;
    finishedAt: string | null;
    outcome: string;
    result: string;
    error: string;
  }[];
}

export interface WebhookMetrics {
  total: number;
  processed: number;
  ignored: number;
  failed: number;
  inProgress: number;
  duplicates: number;
  retried: number;
  failingNow: number;
  lastReceivedAt: string | null;
  successRate: number | null;
}

export function listWebhookEvents(filters: {
  status?: string;
  event?: string;
  q?: string;
  days?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paged<WebhookEventRow> & { events: string[] }> {
  return apiGet(`/admin/payments/webhooks${query(filters)}`, ADMIN);
}

export function webhookMetrics(days: string): Promise<WebhookMetrics> {
  return apiGet(`/admin/payments/webhooks/metrics${query({ days })}`, ADMIN);
}

export function getWebhookEvent(eventId: string): Promise<WebhookEventDetail> {
  return apiGet(`/admin/payments/webhooks/${encodeURIComponent(eventId)}`, ADMIN);
}

export function replayWebhookEvent(
  eventId: string,
): Promise<{ outcome: { failed?: boolean; error?: string }; event: WebhookEventDetail }> {
  return apiPost(`/admin/payments/webhooks/${encodeURIComponent(eventId)}/replay`, {}, ADMIN);
}

/* ---------------------------------------------------------- reconciliation */

export type ReconciliationStatus =
  | "matched"
  | "mismatch"
  | "missing-locally"
  | "missing-externally"
  | "requires-review";

export interface ReconciliationRow {
  id: number;
  paymentId: string | null;
  gatewayPaymentId: string | null;
  orderId: string | null;
  orderNumber: string;
  status: ReconciliationStatus;
  issues: { code: string; label: string }[];
  summary: string;
  amount: number | null;
  currency: string;
  paidAt: string | null;
  checkedAt: string;
  checkCount: number;
  checkError: string;
  resolution: "open" | "resolved";
  resolvedAt: string | null;
  resolutionNote: string;
}

export interface ReconciliationDetail extends ReconciliationRow {
  local: Record<string, unknown> | null;
  gateway: Record<string, unknown> | null;
  events: { action: string; from: string; to: string; note: string; adminName: string; at: string }[];
}

export interface ReconciliationPage extends Paged<ReconciliationRow> {
  open: Record<string, number>;
  lastCheckedAt: string | null;
}

export interface ReconciliationRun {
  checked: number;
  gatewayPayments: number;
  counts: Record<ReconciliationStatus, number>;
}

export function listReconciliation(filters: {
  status?: string;
  resolution?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}): Promise<ReconciliationPage> {
  return apiGet(`/admin/payments/reconciliation${query(filters)}`, ADMIN);
}

export function runReconciliation(from: string, to: string): Promise<ReconciliationRun> {
  return apiPost("/admin/payments/reconciliation/run", { from, to }, ADMIN);
}

export function getReconciliation(id: number): Promise<ReconciliationDetail> {
  return apiGet(`/admin/payments/reconciliation/${id}`, ADMIN);
}

export function recheckReconciliation(id: number): Promise<ReconciliationDetail> {
  return apiPost(`/admin/payments/reconciliation/${id}/recheck`, {}, ADMIN);
}

export function resolveReconciliation(id: number, note: string): Promise<ReconciliationDetail> {
  return apiPost(`/admin/payments/reconciliation/${id}/resolve`, { note }, ADMIN);
}

export function reopenReconciliation(id: number, note: string): Promise<ReconciliationDetail> {
  return apiPost(`/admin/payments/reconciliation/${id}/reopen`, { note }, ADMIN);
}

/* -------------------------------------------------------- account security */

export interface AccountSecuritySettings {
  verificationHours: number;
  resetMinutes: number;
  requireVerifiedEmailToOrder: boolean;
}

export function getAccountSecuritySettings(): Promise<AccountSecuritySettings> {
  return apiGet("/admin/auth/accounts/settings", ADMIN);
}

export function saveAccountSecuritySettings(settings: AccountSecuritySettings): Promise<AccountSecuritySettings> {
  return apiPut("/admin/auth/accounts/settings", settings, ADMIN);
}
