import { apiDelete, apiDownload, apiGet, apiPost, apiPut, query } from "@/services/api/client";

import type { Paged } from "./operationsAdminService";

/**
 * Portal calls for referrals, flash sales, bundles, analytics, the audit log
 * and system health. Every permission is checked by the server; every amount
 * is worked out by it. Money is in rupees.
 */

const ADMIN = { auth: "admin" } as const;

type Person = { id: string; name: string; email: string } | null;

/* --------------------------------------------------------------- referrals */

export type ReferralStatus = "pending" | "review" | "rewarded" | "rejected" | "reversed" | "expired";

export interface AdminReferral {
  id: number;
  code: string;
  status: ReferralStatus;
  flags: string[];
  flagLabels: string[];
  referrer: Person;
  referee: Person;
  order: { id: string; orderNumber: string; total: number; status: string; paymentStatus: string } | null;
  rewardType: "store_credit" | "points";
  referrerReward: number;
  refereeReward: number;
  reversalShortfall: number;
  note: string;
  createdAt: string;
  qualifiedAt: string | null;
  rewardedAt: string | null;
  reversedAt: string | null;
  expiresAt: string | null;
}

export interface ReferralSettings {
  enabled: boolean;
  rewardType: "store_credit" | "points";
  referrerReward: number;
  refereeReward: number;
  minOrderAmount: number;
  rewardOn: "paid" | "delivered";
  windowDays: number;
  maxRewardsPerMonth: number;
  holdSuspicious: boolean;
}

export interface ReferralMetrics {
  days: number;
  signups: number;
  rewarded: number;
  conversion: number | null;
  creditPaid: number;
  pointsPaid: number;
  qualifyingRevenue: number;
  inReview: number;
  topReferrers: { id: string; name: string; rewarded: number }[];
}

export function listReferrals(filters: { status?: string; q?: string; page?: number; pageSize?: number }) {
  return apiGet<Paged<AdminReferral> & { counts: Record<ReferralStatus, number> }>(`/admin/referrals${query(filters)}`, ADMIN);
}

export const getReferralMetrics = (days = 30) => apiGet<ReferralMetrics>(`/admin/referrals/metrics${query({ days })}`, ADMIN);
export const getReferralSettings = () => apiGet<ReferralSettings>("/admin/referrals/settings", ADMIN);
export const saveReferralSettings = (settings: ReferralSettings) =>
  apiPut<ReferralSettings>("/admin/referrals/settings", settings, ADMIN);
export const decideReferral = (id: number, action: "approve" | "reject", note: string) =>
  apiPost<AdminReferral>(`/admin/referrals/${id}/${action}`, { note }, ADMIN);
export const setReferralCode = (customerId: string, action: "disable" | "enable") =>
  apiPost<{ code: string; disabled: boolean }>(`/admin/referrals/codes/${encodeURIComponent(customerId)}/${action}`, {}, ADMIN);

/* ------------------------------------------------------------- flash sales */

export type FlashPhase = "draft" | "scheduled" | "live" | "ended" | "cancelled";

export interface AdminFlashItem {
  id: number;
  productId: string;
  salePrice: number;
  regularPrice: number;
  stockLimit: number | null;
  perCustomerLimit: number | null;
  remaining: number | null;
  soldOut: boolean;
  product: { id: string; name: string; sku: string; slug: string; price: number; stock: number; available: number; status: string; image: string };
  reserved: number;
  sold: number;
  released: number;
  revenue: number;
  savings: number;
  soldOutAt: string | null;
}

export interface AdminFlashSale {
  id: number;
  name: string;
  description: string;
  status: "draft" | "published" | "cancelled";
  phase: FlashPhase;
  startsAt: string;
  endsAt: string;
  allowCoupons: boolean;
  items: AdminFlashItem[];
  itemCount?: number;
  createdAt: string;
  updatedAt: string;
  announcedAt: string | null;
  totals: { sold: number; reserved: number; revenue: number; savings: number };
}

export interface FlashSaleInput {
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  allowCoupons: boolean;
  publish?: boolean;
  items: { productId: string; salePrice: number; stockLimit: number | null; perCustomerLimit: number | null }[];
}

export function listFlashSales(filters: { phase?: string; q?: string; page?: number; pageSize?: number }) {
  return apiGet<Paged<AdminFlashSale> & { counts: Record<FlashPhase, number> }>(`/admin/flash-sales${query(filters)}`, ADMIN);
}
export const getFlashSale = (id: number) => apiGet<AdminFlashSale>(`/admin/flash-sales/${id}`, ADMIN);
export const createFlashSale = (input: FlashSaleInput) => apiPost<AdminFlashSale>("/admin/flash-sales", input, ADMIN);
export const updateFlashSale = (id: number, input: FlashSaleInput) => apiPut<AdminFlashSale>(`/admin/flash-sales/${id}`, input, ADMIN);
export const flashSaleAction = (id: number, action: "publish" | "unpublish" | "cancel" | "end") =>
  apiPost<AdminFlashSale>(`/admin/flash-sales/${id}/${action}`, {}, ADMIN);
export const deleteFlashSale = (id: number) => apiDelete<void>(`/admin/flash-sales/${id}`, ADMIN);

/* ----------------------------------------------------------------- bundles */

export interface AdminBundle {
  id: number;
  slug: string;
  name: string;
  description: string;
  image: string;
  ownImage: string;
  price: number;
  regularPrice: number;
  saving: number;
  savingPercent: number;
  available: number;
  purchasable: boolean;
  reason: string | null;
  maxPerOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  status: "draft" | "active" | "archived";
  pricing: "fixed" | "percent";
  fixedPrice: number | null;
  discountPercent: number | null;
  createdAt: string;
  updatedAt: string;
  components: {
    productId: string;
    quantity: number;
    unitPrice: number;
    regularPrice: number;
    available: number;
    product: { id: string; name: string; sku: string; slug: string; status: string; stock: number; image: string };
  }[];
  sales: { orders: number; units: number; revenue: number };
}

export interface BundleInput {
  name: string;
  description: string;
  image: string;
  status: "draft" | "active" | "archived";
  pricing: "fixed" | "percent";
  fixedPrice: number | null;
  discountPercent: number | null;
  maxPerOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  items: { productId: string; quantity: number }[];
}

export function listBundles(filters: { status?: string; q?: string; page?: number; pageSize?: number }) {
  return apiGet<Paged<AdminBundle> & { counts: Record<string, number> }>(`/admin/bundles${query(filters)}`, ADMIN);
}
export const getBundle = (id: number) => apiGet<AdminBundle>(`/admin/bundles/${id}`, ADMIN);
export const createBundle = (input: BundleInput) => apiPost<AdminBundle>("/admin/bundles", input, ADMIN);
export const updateBundle = (id: number, input: BundleInput) => apiPut<AdminBundle>(`/admin/bundles/${id}`, input, ADMIN);
export const deleteBundle = (id: number) => apiDelete<void>(`/admin/bundles/${id}`, ADMIN);

/** A product for the pickers, built from its Product ID's lookup preview. */
export interface PickableProduct {
  id: string;
  name: string;
  sku: string;
  price: number;
  stock: number;
  reservedStock: number;
  status: string;
  images: string[];
}

/* --------------------------------------------------------------- analytics */

export type AnalyticsSection = "sales" | "customers" | "products" | "marketing" | "funnel";

export interface AnalyticsParams {
  range: string;
  start?: string;
  end?: string;
  compare: "previous" | "year" | "none";
  unit: "auto" | "day" | "week" | "month";
}

export interface Metric {
  value: number;
  previous: number | null;
  delta: number | null;
  isNew: boolean;
  format: "currency" | "number" | "percent" | "decimal";
}

export interface PeriodView {
  start: string;
  end: string;
  label: string;
  startDate: string;
  endDate: string;
}

export interface Breakdown {
  label: string;
  key: string;
  revenue?: number;
  orders?: number;
  units?: number;
  share?: number;
}

interface ReportBase {
  section: AnalyticsSection;
  period: PeriodView;
  comparison: PeriodView | null;
  granularity: "day" | "week" | "month";
  generatedAt: string;
}

export interface SalesReport extends ReportBase {
  metrics: Record<"revenue" | "netRevenue" | "orders" | "averageOrderValue" | "units" | "buyers" | "refunds" | "discounts" | "tax" | "shipping" | "cancelled", Metric>;
  series: { label: string; revenue: number; orders: number; units: number }[];
  previousSeries: { label: string; revenue: number; orders: number; units: number }[] | null;
  breakdowns: Record<"category" | "paymentMethod" | "state" | "deliveryMethod" | "status", Breakdown[]>;
}

export interface CustomersReport extends ReportBase {
  metrics: Record<"signups" | "buyers" | "newBuyers" | "returningBuyers" | "repeatRate" | "ordersPerBuyer", Metric>;
  lifetimeValue: number;
  signupSeries: { label: string; value: number }[];
  topCustomers: { id: string; name: string; email: string; revenue: number; orders: number }[];
}

export interface ProductRow {
  productId: string;
  name: string;
  units: number;
  revenue: number;
  buyers: number;
  views: number;
  addedToBag: number;
  conversion: number | null;
  returned: number;
  returnRate: number;
  stock: number | null;
}

export interface ProductsReport extends ReportBase {
  topByRevenue: ProductRow[];
  topByUnits: ProductRow[];
  mostViewed: { productId: string; name: string; views: number; buyers: number }[];
  viewedNotBought: { productId: string; name: string; views: number; addedToBag: number }[];
  highestReturns: ProductRow[];
  productsSold: number;
  productsWithoutSales: number;
  lowStock: { productId: string; name: string; available: number; threshold: number }[];
}

export interface MarketingReport extends ReportBase {
  coupons: { code: string; orders: number; discount: number; revenue: number }[];
  flashSales: { id: number; name: string; units: number; revenue: number; savings: number }[];
  bundles: { id: number; name: string; orders: number; units: number; revenue: number }[];
  referrals: { signups: number; rewarded: number; creditCost: number };
  giftCards: { sold: number; value: number };
  tenders: { giftCards: number; storeCredit: number; points: number };
  abandonedCarts: { abandoned: number; recovered: number; recoveredValue: number };
  trafficSources: { label: string; visits: number }[];
  devices: { label: string; visits: number }[];
}

export interface FunnelReport extends ReportBase {
  stages: { key: string; label: string; count: number; fromPrevious: number | null; fromTop: number | null; previous?: number; delta?: number | null }[];
  conversionRate: number | null;
  note: string;
}

export interface ReportOf {
  sales: SalesReport;
  customers: CustomersReport;
  products: ProductsReport;
  marketing: MarketingReport;
  funnel: FunnelReport;
}

export function getAnalytics<S extends AnalyticsSection>(section: S, params: AnalyticsParams) {
  return apiGet<ReportOf[S]>(`/admin/analytics/${section}${query({ ...params })}`, ADMIN);
}

export function exportAnalytics(kind: string, params: AnalyticsParams) {
  return apiDownload(`/admin/analytics/export/${kind}${query({ ...params })}`, "admin", `${kind}.csv`);
}

/* --------------------------------------------------------------- audit log */

export interface AuditEntry {
  id: number;
  occurredAt: string;
  action: string;
  resourceType: string;
  resourceId: string;
  summary: string;
  outcome: "success" | "failure" | "denied";
  statusCode: number | null;
  errorCode: string;
  actor: { type: string; id: string | null; name: string; email: string; role: string };
  ipAddress: string;
  hasChanges: boolean;
  changes?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  userAgent?: string;
  requestId?: string;
}

export interface AuditFilters {
  /** A record's exact ID (PRD001, DCZ10241) or an action code (products.update) — never a name or email. */
  q?: string;
  action?: string;
  resourceType?: string;
  /** Who did it: their Admin user ID (ADM001), exactly. */
  actor?: string;
  outcome?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function listAuditLog(filters: AuditFilters) {
  return apiGet<Paged<AuditEntry> & { counts: Record<string, number> }>(`/admin/audit-logs${query({ ...filters })}`, ADMIN);
}
export const getAuditEntry = (id: number) => apiGet<AuditEntry>(`/admin/audit-logs/${id}`, ADMIN);
export const getAuditFacets = () =>
  apiGet<{ resourceTypes: string[]; actors: { id: string; name: string }[] }>("/admin/audit-logs/facets", ADMIN);
export function exportAuditLog(filters: AuditFilters) {
  const { page: _page, pageSize: _size, ...rest } = filters;
  void _page;
  void _size;
  return apiDownload(`/admin/audit-logs/export${query({ ...rest })}`, "admin", "audit-log.csv");
}

/* ------------------------------------------------------------------ health */

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface HealthCheck {
  status: HealthStatus;
  message: string;
  label: string;
  latencyMs?: number;
  facts?: Record<string, unknown>;
  jobs?: {
    name: string;
    label: string;
    status: HealthStatus;
    message: string;
    intervalSeconds: number | null;
    lastSuccessAt: string | null;
    lastStartedAt: string | null;
    lastDurationMs: number | null;
    runs: number;
    failures: number;
    lastError: string | null;
    lastErrorAt: string | null;
  }[];
}

export interface HealthReport {
  status: HealthStatus;
  checkedAt: string;
  deep: boolean;
  durationMs: number;
  checks: Record<string, HealthCheck>;
  history: { checkedAt: string; status: HealthStatus; durationMs: number; problems: Record<string, HealthStatus> }[];
  uptime7d: number | null;
}

export const getHealth = (hours = 24) => apiGet<HealthReport>(`/admin/health${query({ hours })}`, ADMIN);
export const runHealth = () => apiPost<HealthReport>("/admin/health/run", {}, ADMIN);
