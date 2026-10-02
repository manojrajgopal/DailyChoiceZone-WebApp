/**
 * Suppliers, supplier–product links, purchase orders and goods receiving.
 *
 * Exactly the shapes in docs/shipping-and-suppliers.md §6 ("Admin: suppliers",
 * "Admin: purchase orders"). Money is in rupees on the wire, as product prices are.
 */

/* ---------------------------------------------------------------- suppliers */

export type SupplierStatus = "active" | "inactive" | "archived";

export type TaxTreatment = "registered" | "unregistered" | "composition" | "overseas";

export interface SupplierAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  country: string;
  pincode: string;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  legalName: string;
  contactPerson: string;
  phone: string;
  email: string;
  website: string;
  status: SupplierStatus;
  gstin: string | null;
  pan: string | null;
  businessType: string;
  taxTreatment: TaxTreatment;
  billingAddress: SupplierAddress;
  warehouseAddress: SupplierAddress | null;
  paymentTerms: string;
  creditDays: number;
  currency: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface SupplierStats {
  productCount: number;
  activeProductCount: number;
  poCount: number;
  openPoCount: number;
  receivedPoCount: number;
  totalPurchaseValue: number;
  outstandingQuantity: number;
  /** null until at least 3 fully received POs. */
  averageLeadTimeDays: number | null;
  /** null until at least 3 received POs with an expected date. */
  onTimeRate: number | null;
}

export interface SupplierHistoryEntry {
  at: string;
  action: string;
  summary: string;
  actor: string;
}

export interface SupplierDetail extends Supplier {
  stats: SupplierStats;
  /** The last 5 goods receipts. */
  recentDeliveries: GoodsReceipt[];
  /** The last 50 audit and PO events. */
  history: SupplierHistoryEntry[];
}

/** What the supplier form sends. `code` may be left out on create; the server generates one. */
export interface SupplierInput {
  code?: string;
  name: string;
  legalName: string;
  contactPerson: string;
  phone: string;
  email: string;
  website: string;
  gstin: string | null;
  pan: string | null;
  businessType: string;
  taxTreatment: TaxTreatment;
  billingAddress: SupplierAddress;
  warehouseAddress: SupplierAddress | null;
  paymentTerms: string;
  creditDays: number;
  currency: string;
  notes: string;
}

export interface Paged<T> {
  items: T[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface SupplierPage extends Paged<Supplier> {
  counts?: Record<string, number>;
}

export type SupplierSort = "name" | "code" | "createdAt";

/* --------------------------------------------------------- supplier–product */

export type SupplierProductStatus = "active" | "inactive";

export interface SupplierProduct {
  id: number;
  supplierId: string;
  supplierName: string;
  supplierStatus: SupplierStatus;
  productId: string;
  productName: string;
  productSku: string;
  productStatus: string;
  supplierSku: string;
  purchaseCost: number;
  moq: number;
  leadTimeDays: number | null;
  status: SupplierProductStatus;
  preferred: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierProductInput {
  supplierSku: string;
  purchaseCost: number;
  moq: number;
  leadTimeDays: number | null;
  status: SupplierProductStatus;
  preferred: boolean;
  notes: string;
}

/* ----------------------------------------------------------- purchase orders */

export type PurchaseOrderStatus =
  | "draft"
  | "submitted"
  | "sent"
  | "acknowledged"
  | "partially-received"
  | "received"
  | "cancelled";

export type TaxMode = "intra-state" | "inter-state";

export interface PurchaseOrderItem {
  id: number;
  productId: string;
  name: string;
  sku: string;
  supplierSku: string;
  quantity: number;
  unitCost: number;
  taxRate: number;
  lineSubtotal: number;
  lineTax: number;
  lineTotal: number;
  receivedQty: number;
  damagedQty: number;
  rejectedQty: number;
  acceptedQty: number;
  outstandingQty: number;
}

export interface PurchaseOrderEvent {
  status: string;
  note: string;
  actor: string;
  at: string;
}

export interface GoodsReceiptItem {
  poItemId: number;
  productId: string;
  name: string;
  receivedQty: number;
  damagedQty: number;
  rejectedQty: number;
  acceptedQty: number;
  note: string;
}

export interface GoodsReceipt {
  id: number;
  receiptNumber: string;
  receivedAt: string;
  notes: string;
  createdBy: string;
  items: GoodsReceiptItem[];
}

export interface PurchaseOrderActions {
  edit: boolean;
  submit: boolean;
  send: boolean;
  acknowledge: boolean;
  receive: boolean;
  cancel: boolean;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  statusLabel: string;
  supplier: { id: string; code: string; name: string; status: SupplierStatus; state: string };
  currency: string;
  taxMode: TaxMode;
  items: PurchaseOrderItem[];
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  total: number;
  expectedAt: string | null;
  supplierReference: string;
  notes: string;
  timeline: PurchaseOrderEvent[];
  receipts: GoodsReceipt[];
  actions: PurchaseOrderActions;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** Sent with a create/update answer, e.g. a quantity below the supplier's MOQ. */
  warnings?: string[];
}

export interface PurchaseOrderListItem {
  id: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  statusLabel: string;
  supplierId: string;
  supplierName: string;
  itemCount: number;
  total: number;
  expectedAt: string | null;
  createdAt: string;
}

export interface PurchaseOrderPage extends Paged<PurchaseOrderListItem> {
  counts?: Record<string, number>;
}

export interface PurchaseOrderInput {
  supplierId: string;
  items: { productId: string; quantity: number; unitCost?: number; taxRate?: number }[];
  expectedAt?: string;
  supplierReference?: string;
  notes?: string;
}

export type PurchaseOrderTransition = "submit" | "send" | "acknowledge";

export interface GoodsReceiptInput {
  receivedAt?: string;
  notes?: string;
  idempotencyKey: string;
  items: { poItemId: number; receivedQty: number; damagedQty: number; rejectedQty: number; note?: string }[];
  allowOverReceipt?: boolean;
  overReceiptReason?: string;
}
