/**
 * Everything that can be looked up by ID, as the screens see it
 * (docs/id-lookup.md).
 *
 * The backend registry (`app/services/lookup/registry.py`) decides which
 * identifiers match and who may ask; this file decides how each entity is
 * named in the interface and where its full record opens. Keep the keys in
 * step with the backend's.
 */

export type LookupScope = "admin" | "account";

export type LookupEntity =
  | "product"
  | "category"
  | "collection"
  | "size_guide"
  | "review"
  | "question"
  | "stock_adjustment"
  | "customer"
  | "address"
  | "admin_user"
  | "order"
  | "invoice"
  | "payment"
  | "refund"
  | "credit_note"
  | "return"
  | "coupon"
  | "gift_card"
  | "webhook_event"
  | "reconciliation"
  | "shipment"
  | "packing_job"
  | "package"
  | "courier"
  | "pincode"
  | "supplier"
  | "purchase_order"
  | "goods_receipt"
  | "ticket"
  | "support_agent"
  | "banner"
  | "membership_plan"
  | "membership"
  | "referral_code"
  | "segment"
  | "campaign"
  | "flash_sale"
  | "bundle"
  | "backup";

export interface LookupEntityConfig {
  /** "Product" — the ID is called "Product ID". */
  label: string;
  /** An ID in this entity's real format, for placeholders and hints. */
  example: string;
  /**
   * Where the record's own screen is, from its `key` (what that screen's
   * `?id=` takes) and its readable `id`. Missing: the record has no screen of
   * its own; the preview card is the detail.
   */
  adminHref?: (key: string, id: string) => string;
  /** The customer's own page for it, when there is one. */
  accountHref?: (key: string, id: string) => string;
  /**
   * Stock, status and money change by the minute: never served from cache.
   * The rest (a category, a supplier) may be reused briefly.
   */
  volatile: boolean;
}

const q = (path: string) => (_key: string, id: string) => `${path}?q=${encodeURIComponent(id)}`;
const byKey = (path: string) => (key: string) => `${path}?id=${encodeURIComponent(key)}`;
const page = (path: string) => () => path;

export const LOOKUP_ENTITIES: Record<LookupEntity, LookupEntityConfig> = {
  product: { label: "Product", example: "PRD001", adminHref: byKey("/admin/products/edit"), volatile: true },
  category: { label: "Category", example: "CAT001", adminHref: page("/admin/categories"), volatile: false },
  collection: { label: "Collection", example: "COL001", adminHref: page("/admin/collections"), volatile: false },
  size_guide: { label: "Size guide", example: "SZG001", adminHref: page("/admin/size-guides"), volatile: false },
  review: { label: "Review", example: "REV001", adminHref: page("/admin/reviews"), volatile: true },
  question: { label: "Question", example: "12", adminHref: q("/admin/questions"), volatile: true },
  stock_adjustment: { label: "Stock adjustment", example: "41", volatile: false },
  customer: { label: "Customer", example: "CUS001", adminHref: byKey("/admin/customers/detail"), volatile: true },
  address: { label: "Address", example: "ADR001", accountHref: page("/account/addresses"), volatile: false },
  admin_user: { label: "Admin user", example: "ADM001", adminHref: page("/admin/admin-users"), volatile: false },
  order: {
    label: "Order",
    example: "DCZ10001",
    adminHref: byKey("/admin/orders/detail"),
    accountHref: (_key, id) => `/account/order?number=${encodeURIComponent(id)}`,
    volatile: true,
  },
  invoice: {
    label: "Invoice",
    example: "DCZ-INV-2026-000001",
    adminHref: byKey("/admin/billing/invoices/detail"),
    accountHref: byKey("/account/invoice"),
    volatile: true,
  },
  payment: { label: "Payment", example: "PAY001", adminHref: byKey("/admin/billing/payments/detail"), volatile: true },
  refund: { label: "Refund", example: "DCZ-RF-2026-00001", adminHref: q("/admin/billing/refunds"), volatile: true },
  credit_note: { label: "Credit note", example: "DCZ-CN-2026-00001", adminHref: page("/admin/billing/credit-notes"), volatile: true },
  return: { label: "Return", example: "RET001", adminHref: byKey("/admin/returns/detail"), volatile: true },
  coupon: { label: "Coupon", example: "CPN001", adminHref: page("/admin/coupons"), volatile: true },
  gift_card: { label: "Gift card", example: "GC12", adminHref: q("/admin/gift-cards"), volatile: true },
  webhook_event: { label: "Webhook event", example: "evt_…", adminHref: q("/admin/payments/webhooks"), volatile: true },
  reconciliation: {
    label: "Reconciliation",
    example: "15",
    adminHref: q("/admin/payments/reconciliation"),
    volatile: true,
  },
  shipment: { label: "Shipment", example: "DCZ-SH-2026-000001", adminHref: byKey("/admin/shipments/detail"), volatile: true },
  packing_job: { label: "Packing job", example: "8", adminHref: byKey("/admin/packing/job"), volatile: true },
  package: { label: "Package", example: "DCZ-PKG-2026-000001", adminHref: byKey("/admin/packing/job"), volatile: true },
  courier: { label: "Courier", example: "shiprocket", adminHref: page("/admin/settings/couriers"), volatile: false },
  pincode: { label: "Pincode", example: "560001", adminHref: q("/admin/delivery"), volatile: false },
  supplier: { label: "Supplier", example: "SUP001", adminHref: byKey("/admin/suppliers/detail"), volatile: false },
  purchase_order: {
    label: "Purchase order",
    example: "DCZ-PO-2026-000001",
    adminHref: byKey("/admin/purchase-orders/detail"),
    volatile: true,
  },
  goods_receipt: { label: "Goods receipt", example: "DCZ-GRN-2026-000001", volatile: true },
  ticket: {
    label: "Support ticket",
    example: "DCZ-2026-000001",
    adminHref: byKey("/admin/support/ticket"),
    accountHref: (_key, id) => `/account/ticket?number=${encodeURIComponent(id)}`,
    volatile: true,
  },
  support_agent: { label: "Support agent", example: "5", adminHref: page("/admin/support/settings"), volatile: false },
  referral_code: { label: "Referral code", example: "ASHA2026", adminHref: q("/admin/referrals"), volatile: true },
  banner: { label: "Banner", example: "BNR001", adminHref: page("/admin/banners"), volatile: false },
  membership_plan: { label: "Membership plan", example: "MBP001", adminHref: page("/admin/membership"), volatile: false },
  membership: { label: "Membership", example: "MEM001", adminHref: q("/admin/membership/members"), volatile: true },
  segment: { label: "Segment", example: "3", adminHref: byKey("/admin/customers/segments/detail"), volatile: true },
  campaign: { label: "Campaign", example: "7", adminHref: byKey("/admin/marketing/campaigns/detail"), volatile: true },
  flash_sale: { label: "Flash sale", example: "4", adminHref: byKey("/admin/flash-sales/detail"), volatile: true },
  bundle: { label: "Bundle", example: "2", adminHref: byKey("/admin/bundles/detail"), volatile: true },
  backup: { label: "Backup", example: "BKP-20261003-020000-AB12", adminHref: page("/admin/settings/backups"), volatile: true },
};

/** "Product ID" — what the field asks for. */
export function idLabel(entity: LookupEntity): string {
  return `${LOOKUP_ENTITIES[entity].label} ID`;
}

/** "Search Product ID…" — never a bare "Search…": the field says which ID it wants. */
export function idPlaceholder(entity: LookupEntity): string {
  return `Search ${idLabel(entity)}…`;
}

/** The record's full screen for this audience, if it has one. */
export function entityHref(scope: LookupScope, entity: LookupEntity, key: string, id: string): string | undefined {
  const config = LOOKUP_ENTITIES[entity];
  const build = scope === "admin" ? config.adminHref : config.accountHref;
  return build ? build(key, id) : undefined;
}

/** The portal's own ID lookup page, which opens any ID's preview. Used to link IDs everywhere. */
export function adminLookupHref(entity: LookupEntity, id: string): string {
  return `/admin/lookup?entity=${encodeURIComponent(entity)}&id=${encodeURIComponent(id)}`;
}

export function isLookupEntity(value: string | null | undefined): value is LookupEntity {
  return !!value && Object.prototype.hasOwnProperty.call(LOOKUP_ENTITIES, value);
}
