/**
 * Fixtures for the customer-segmentation screens, shaped exactly as
 * docs/customer-segmentation.md §4–§6 describes the API's answers.
 */
import type {
  SegmentDetail,
  SegmentField,
  SegmentFieldRegistry,
  SegmentMember,
  SegmentSummary,
  SegmentationSettingsResponse,
} from "@/types/segments";

const NUMBER_OPS = ["equals", "not-equals", "gt", "lt", "gte", "lte", "between"];

function field(overrides: Partial<SegmentField> & Pick<SegmentField, "key" | "label" | "group" | "type" | "operators">): SegmentField {
  return { options: [], unit: null, description: null, min: null, max: null, ...overrides };
}

export function registry(): SegmentFieldRegistry {
  return {
    groups: [
      { key: "profile", label: "Profile" },
      { key: "shopping", label: "Shopping" },
      { key: "products", label: "Products" },
    ],
    fields: [
      field({ key: "totalOrders", label: "Total orders", group: "shopping", type: "number", operators: NUMBER_OPS, min: 0, max: 100000 }),
      field({
        key: "totalSpend",
        label: "Total spend",
        group: "shopping",
        type: "money",
        operators: NUMBER_OPS,
        unit: "₹",
        description: "Net of refunds; cancelled and returned orders excluded",
        min: 0,
        max: 10000000,
      }),
      field({
        key: "lastOrderAt",
        label: "Last order",
        group: "shopping",
        type: "date",
        operators: ["equals", "before", "after", "between", "within-last-days", "not-within-last-days"],
      }),
      field({
        key: "city",
        label: "City",
        group: "profile",
        type: "string",
        operators: ["equals", "not-equals", "contains", "not-contains", "starts-with", "ends-with", "in", "not-in"],
      }),
      field({
        key: "rfmLabel",
        label: "RFM label",
        group: "shopping",
        type: "enum",
        operators: ["equals", "not-equals", "in", "not-in"],
        options: [
          { value: "champions", label: "Champions" },
          { value: "at-risk", label: "At risk" },
          { value: "lost", label: "Lost" },
        ],
      }),
      field({ key: "hasAbandonedCart", label: "Has an abandoned bag", group: "shopping", type: "boolean", operators: ["equals"] }),
      field({
        key: "purchasedCategories",
        label: "Bought from categories",
        group: "products",
        type: "list",
        operators: ["contains", "not-contains", "in", "not-in"],
        options: [
          { value: "CAT1", label: "Kurtas" },
          { value: "CAT2", label: "Sarees" },
        ],
      }),
      field({ key: "purchasedProducts", label: "Bought products", group: "products", type: "list", operators: ["contains", "not-contains", "in", "not-in"] }),
    ],
    operators: [
      { key: "equals", label: "is", value: "single" },
      { key: "not-equals", label: "is not", value: "single" },
      { key: "gt", label: "is more than", value: "single" },
      { key: "lt", label: "is less than", value: "single" },
      { key: "gte", label: "is at least", value: "single" },
      { key: "lte", label: "is at most", value: "single" },
      { key: "between", label: "is between", value: "range" },
      { key: "before", label: "is before", value: "single" },
      { key: "after", label: "is after", value: "single" },
      { key: "within-last-days", label: "is within the last", value: "days" },
      { key: "not-within-last-days", label: "is not within the last", value: "days" },
      { key: "contains", label: "contains", value: "single" },
      { key: "not-contains", label: "does not contain", value: "single" },
      { key: "starts-with", label: "starts with", value: "single" },
      { key: "ends-with", label: "ends with", value: "single" },
      { key: "in", label: "is any of", value: "list" },
      { key: "not-in", label: "is none of", value: "list" },
    ],
    limits: { maxConditions: 30, maxListItems: 100 },
  };
}

export function segment(overrides: Partial<SegmentSummary> = {}): SegmentSummary {
  return {
    id: 3,
    name: "VIP",
    slug: "vip",
    description: "Big spenders who ordered lately",
    kind: "default",
    status: "active",
    match: "all",
    conditionCount: 3,
    memberCount: 42,
    lastCalculatedAt: "2026-10-08T06:00:00",
    createdBy: "system",
    updatedBy: "ADM001",
    createdAt: "2026-10-01T06:00:00",
    updatedAt: "2026-10-08T06:00:00",
    ...overrides,
  };
}

export function segmentDetail(overrides: Partial<SegmentDetail> = {}): SegmentDetail {
  return {
    ...segment(),
    rules: [
      { field: "totalSpend", operator: "gte", value: 25000 },
      { field: "totalOrders", operator: "gte", value: 5 },
      {
        match: "any",
        rules: [
          { field: "city", operator: "in", value: ["Bengaluru", "Mysuru"] },
          { field: "lastOrderAt", operator: "within-last-days", value: 180 },
        ],
      },
    ],
    rfm: {
      labels: [
        { key: "champions", label: "Champions", count: 30 },
        { key: "loyal", label: "Loyal", count: 12 },
        { key: "lost", label: "Lost", count: 0 },
      ],
      recency: [
        { score: 5, count: 30 },
        { score: 4, count: 12 },
      ],
      frequency: [{ score: 5, count: 42 }],
      monetary: [
        { score: 5, count: 40 },
        { score: 3, count: 2 },
      ],
    },
    history: [
      { id: 2, action: "recalculated", label: "Recalculated", actor: "ADM001", actorName: "Manoj", details: { before: 40, after: 42 }, at: "2026-10-08T06:00:00" },
      { id: 1, action: "created", label: "Created", actor: "system", actorName: "", details: null, at: "2026-10-01T06:00:00" },
    ],
    actions: { edit: true, archive: true, restore: false, recalculate: true, export: true },
    ...overrides,
  };
}

export function member(overrides: Partial<SegmentMember> = {}): SegmentMember {
  return {
    customerId: "CUS001",
    name: "Asha Rao",
    email: "a••••@example.com",
    phone: "987•••00001",
    city: "Bengaluru",
    state: "Karnataka",
    totalOrders: 4,
    totalSpend: 5400,
    averageOrderValue: 1350,
    lastOrderAt: "2026-09-30T10:00:00",
    joinedAt: "2026-01-01T10:00:00",
    rfmLabel: "loyal",
    rfmScore: "343",
    pointsBalance: 120,
    addedAt: "2026-10-01T06:00:00",
    ...overrides,
  };
}

export function paged<T>(items: T[], extra: { total?: number; page?: number; totalPages?: number } = {}) {
  return {
    items,
    pagination: { page: extra.page ?? 1, page_size: 25, total: extra.total ?? items.length, total_pages: extra.totalPages ?? 1 },
  };
}

export function settingsResponse(): SegmentationSettingsResponse {
  return {
    settings: {
      recencyDays: [30, 60, 90, 180],
      frequencyOrders: [2, 3, 5, 8],
      monetaryRupees: [1000, 3000, 7500, 15000],
      refreshHours: 6,
      labels: [
        { key: "champions", label: "Champions", r: [4, 5], f: [4, 5], m: [4, 5] },
        { key: "loyal", label: "Loyal", r: [3, 5], f: [3, 5], m: [1, 5] },
        { key: "lost", label: "Lost", r: [1, 1], f: [1, 2], m: [1, 5] },
      ],
    },
    status: { customers: 1200, metrics: 1180, dirty: 20, oldestRefreshAt: "2026-10-08T00:00:00", newestRefreshAt: "2026-10-08T06:00:00" },
  };
}
