/**
 * Fixtures for the supplier and purchase-order screens, shaped exactly as
 * docs/shipping-and-suppliers.md §6 describes the API's answers.
 */
import type {
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderListItem,
  Supplier,
  SupplierDetail,
  SupplierProduct,
} from "@/types/suppliers";

export function supplier(overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: "SUP001",
    code: "ANVI-TEX",
    name: "Anvi Textiles",
    legalName: "Anvi Textiles Pvt Ltd",
    contactPerson: "R. Kumar",
    phone: "9876543210",
    email: "sales@anvi.example",
    website: "https://anvi.example",
    status: "active",
    gstin: "29ABCDE1234F1Z5",
    pan: "ABCDE1234F",
    businessType: "manufacturer",
    taxTreatment: "registered",
    billingAddress: { line1: "12 Mill Road", line2: "", city: "Bengaluru", state: "Karnataka", country: "India", pincode: "560001" },
    warehouseAddress: null,
    paymentTerms: "Net 30",
    creditDays: 30,
    currency: "INR",
    notes: "",
    createdAt: "2026-09-01T10:00:00",
    updatedAt: "2026-09-01T10:00:00",
    createdBy: "ADM001",
    ...overrides,
  };
}

export function supplierDetail(overrides: Partial<SupplierDetail> = {}): SupplierDetail {
  return {
    ...supplier(),
    stats: {
      productCount: 4,
      activeProductCount: 3,
      poCount: 6,
      openPoCount: 2,
      receivedPoCount: 4,
      totalPurchaseValue: 125000,
      outstandingQuantity: 30,
      averageLeadTimeDays: 6.5,
      onTimeRate: 75,
    },
    recentDeliveries: [
      {
        id: 1,
        receiptNumber: "DCZ-GRN-2026-000001",
        receivedAt: "2026-09-20T09:00:00",
        notes: "",
        createdBy: "ADM001",
        items: [{ poItemId: 1, productId: "PRD001", name: "Cotton Kurta", receivedQty: 20, damagedQty: 1, rejectedQty: 0, acceptedQty: 19, note: "" }],
      },
    ],
    history: [{ at: "2026-09-02T10:00:00", action: "supplier.update", summary: "Payment terms changed to Net 30", actor: "ADM001" }],
    ...overrides,
  };
}

export function supplierProduct(overrides: Partial<SupplierProduct> = {}): SupplierProduct {
  return {
    id: 3,
    supplierId: "SUP001",
    supplierName: "Anvi Textiles",
    supplierStatus: "active",
    productId: "PRD001",
    productName: "Cotton Kurta",
    productSku: "DCZ-WO0001",
    productStatus: "active",
    supplierSku: "AT-K-01",
    purchaseCost: 450,
    moq: 10,
    leadTimeDays: 7,
    status: "active",
    preferred: true,
    notes: "",
    createdAt: "2026-09-01T10:00:00",
    updatedAt: "2026-09-01T10:00:00",
    ...overrides,
  };
}

export function poItem(overrides: Partial<PurchaseOrderItem> = {}): PurchaseOrderItem {
  return {
    id: 1,
    productId: "PRD001",
    name: "Cotton Kurta",
    sku: "DCZ-WO0001",
    supplierSku: "AT-K-01",
    quantity: 50,
    unitCost: 450,
    taxRate: 5,
    lineSubtotal: 22500,
    lineTax: 1125,
    lineTotal: 23625,
    receivedQty: 0,
    damagedQty: 0,
    rejectedQty: 0,
    acceptedQty: 0,
    outstandingQty: 50,
    ...overrides,
  };
}

export function purchaseOrder(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: "POR001",
    poNumber: "DCZ-PO-2026-000001",
    status: "draft",
    statusLabel: "Draft",
    supplier: { id: "SUP001", code: "ANVI-TEX", name: "Anvi Textiles", status: "active", state: "Karnataka" },
    currency: "INR",
    taxMode: "intra-state",
    items: [poItem()],
    subtotal: 22500,
    cgst: 562.5,
    sgst: 562.5,
    igst: 0,
    taxTotal: 1125,
    total: 23625,
    expectedAt: "2026-10-15",
    supplierReference: "",
    notes: "",
    timeline: [{ status: "draft", note: "", actor: "ADM001", at: "2026-10-01T10:00:00" }],
    receipts: [],
    actions: { edit: true, submit: true, send: false, acknowledge: false, receive: false, cancel: true },
    createdAt: "2026-10-01T10:00:00",
    updatedAt: "2026-10-01T10:00:00",
    createdBy: "ADM001",
    ...overrides,
  };
}

export function poListItem(overrides: Partial<PurchaseOrderListItem> = {}): PurchaseOrderListItem {
  return {
    id: "POR001",
    poNumber: "DCZ-PO-2026-000001",
    status: "draft",
    statusLabel: "Draft",
    supplierId: "SUP001",
    supplierName: "Anvi Textiles",
    itemCount: 1,
    total: 23625,
    expectedAt: "2026-10-15",
    createdAt: "2026-10-01T10:00:00",
    ...overrides,
  };
}

/** A list answer: `{ items, pagination, counts }` as the data of the envelope. */
export function page<T>(items: T[], extra: { total?: number; page?: number; totalPages?: number; counts?: Record<string, number> } = {}) {
  return {
    items,
    pagination: { page: extra.page ?? 1, page_size: 25, total: extra.total ?? items.length, total_pages: extra.totalPages ?? 1 },
    counts: extra.counts ?? {},
  };
}

/** A product as the admin product search returns it (for the product picker). */
export function pickable(overrides: Partial<{ id: string; name: string; sku: string; price: number; stock: number; reservedStock: number; status: string }> = {}) {
  return { id: "PRD002", name: "Linen Shirt", sku: "DCZ-ME0002", price: 1299, stock: 10, reservedStock: 0, status: "active", images: [], ...overrides };
}
