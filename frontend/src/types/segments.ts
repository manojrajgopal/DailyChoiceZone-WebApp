/**
 * Customer segmentation, exactly as docs/customer-segmentation.md §4–§6
 * describes the API's answers (camelCase on the wire).
 *
 * Money (`totalSpend`, rule values on `money` fields, the monetary bands) is in
 * rupees as the server sends it; the frontend only displays it.
 */

export type SegmentKind = "default" | "custom";
export type SegmentStatus = "active" | "archived";
export type SegmentMatch = "all" | "any";

export type SegmentFieldType = "number" | "money" | "date" | "string" | "enum" | "list" | "boolean";

/** How an operator takes its value: one, a `[low, high]` pair, a list, a number of days, or nothing. */
export type OperatorValueKind = "single" | "range" | "list" | "days" | "none";

export type RuleValue = string | number | boolean | (string | number | null)[] | null;

export interface SegmentCondition {
  field: string;
  operator: string;
  value: RuleValue;
}

/** One level of nesting only: a group holds conditions, never another group. */
export interface SegmentGroup {
  match: SegmentMatch;
  rules: SegmentCondition[];
}

export type SegmentRule = SegmentCondition | SegmentGroup;

export interface SegmentRules {
  match: SegmentMatch;
  rules: SegmentRule[];
}

/* ------------------------------------------------------------------ registry */

export interface SegmentFieldOption {
  value: string;
  label: string;
}

export interface SegmentField {
  key: string;
  label: string;
  group: string;
  type: SegmentFieldType;
  operators: string[];
  /** Enum choices, or list choices (categories, plans). Empty when free-form. */
  options: SegmentFieldOption[];
  unit?: string | null;
  description?: string | null;
  min?: number | null;
  max?: number | null;
}

export interface SegmentOperator {
  key: string;
  label: string;
  value: OperatorValueKind;
}

export interface SegmentFieldRegistry {
  groups: { key: string; label: string }[];
  fields: SegmentField[];
  operators: SegmentOperator[];
  limits: { maxConditions: number; maxListItems: number };
}

/* ------------------------------------------------------------------ segments */

export interface SegmentSummary {
  id: number;
  name: string;
  slug: string;
  description: string;
  kind: SegmentKind;
  status: SegmentStatus;
  match: SegmentMatch;
  conditionCount: number;
  memberCount: number;
  lastCalculatedAt: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RfmLabelCount {
  key: string;
  label: string;
  count: number;
}

export interface RfmScoreCount {
  score: number;
  count: number;
}

export interface SegmentRfm {
  labels: RfmLabelCount[];
  recency: RfmScoreCount[];
  frequency: RfmScoreCount[];
  monetary: RfmScoreCount[];
}

export interface SegmentHistoryEntry {
  id: number;
  action: string;
  label: string;
  actor: string;
  actorName: string;
  details: Record<string, unknown> | null;
  at: string;
}

export interface SegmentActions {
  edit: boolean;
  archive: boolean;
  restore: boolean;
  recalculate: boolean;
  export: boolean;
}

export interface SegmentDetail extends SegmentSummary {
  rules: SegmentRule[];
  rfm: SegmentRfm;
  history: SegmentHistoryEntry[];
  actions: SegmentActions;
}

export interface SegmentInput {
  name?: string;
  description?: string;
  match?: SegmentMatch;
  rules?: SegmentRule[];
}

export interface SegmentMember {
  customerId: string;
  name: string;
  email: string;
  phone: string;
  city: string | null;
  state: string | null;
  totalOrders: number;
  totalSpend: number;
  averageOrderValue: number;
  lastOrderAt: string | null;
  joinedAt: string | null;
  rfmLabel: string;
  rfmScore: string;
  pointsBalance: number;
  addedAt?: string | null;
}

export interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface SegmentPage {
  items: SegmentSummary[];
  pagination: Pagination;
  counts: { active: number; archived: number };
}

export interface SegmentMemberPage {
  items: SegmentMember[];
  pagination: Pagination;
  masked: boolean;
}

export interface SegmentPreview {
  count: number;
  items: SegmentMember[];
  page: number;
  pageSize: number;
  masked: boolean;
}

/* ------------------------------------------------------------------ settings */

export type RfmRange = [number, number];

export interface RfmLabelRule {
  key: string;
  label: string;
  r: RfmRange;
  f: RfmRange;
  m: RfmRange;
}

export interface SegmentationSettings {
  recencyDays: number[];
  frequencyOrders: number[];
  monetaryRupees: number[];
  refreshHours: number;
  labels: RfmLabelRule[];
}

export interface MetricsStatus {
  customers: number;
  metrics: number;
  dirty: number;
  oldestRefreshAt: string | null;
  newestRefreshAt: string | null;
}

export interface SegmentationSettingsResponse {
  settings: SegmentationSettings;
  status: MetricsStatus;
}

export interface MetricsRefreshResult {
  refreshed: number;
  segments: number;
}

export interface SegmentationSummary {
  totalCustomers: number;
  newCustomers30d: number;
  returningCustomers: number;
  vip: number;
  atRisk: number;
  activeSegments: number;
  oldestRefreshAt: string | null;
}
