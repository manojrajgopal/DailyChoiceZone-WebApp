/**
 * Client-side checks that mirror the server's (docs/shipping-and-suppliers.md §6).
 * The server is authoritative; these only save a round trip and point at the
 * field. Error keys are the API's field names (`billingAddress.pincode`,
 * `items.0.quantity`) so a server 422 `details.field` lands on the same field.
 */
import type {
  GoodsReceiptInput,
  PurchaseOrderInput,
  Supplier,
  SupplierAddress,
  SupplierInput,
  SupplierProductInput,
  SupplierProductStatus,
  TaxTreatment,
} from "@/types/suppliers";

export const CODE_PATTERN = /^[A-Z0-9-]{2,30}$/;
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^(\d{10}|\+[1-9]\d{6,14})$/;
const PINCODE_PATTERN = /^\d{6}$/;
const INTEGER = /^\d+$/;
const DECIMAL = /^\d+(\.\d{1,2})?$/;

export type Errors = Record<string, string>;

/* ---------------------------------------------------------------- supplier */

export interface SupplierDraft {
  code: string;
  name: string;
  legalName: string;
  contactPerson: string;
  phone: string;
  email: string;
  website: string;
  gstin: string;
  pan: string;
  businessType: string;
  taxTreatment: TaxTreatment;
  billingAddress: SupplierAddress;
  hasWarehouse: boolean;
  warehouseAddress: SupplierAddress;
  paymentTerms: string;
  creditDays: string;
  currency: string;
  notes: string;
}

export const emptyAddress = (): SupplierAddress => ({
  line1: "",
  line2: "",
  city: "",
  state: "",
  country: "India",
  pincode: "",
});

export function emptySupplierDraft(): SupplierDraft {
  return {
    code: "",
    name: "",
    legalName: "",
    contactPerson: "",
    phone: "",
    email: "",
    website: "",
    gstin: "",
    pan: "",
    businessType: "manufacturer",
    taxTreatment: "registered",
    billingAddress: emptyAddress(),
    hasWarehouse: false,
    warehouseAddress: emptyAddress(),
    paymentTerms: "",
    creditDays: "0",
    currency: "INR",
    notes: "",
  };
}

export function draftFromSupplier(supplier: Supplier): SupplierDraft {
  return {
    code: supplier.code ?? "",
    name: supplier.name ?? "",
    legalName: supplier.legalName ?? "",
    contactPerson: supplier.contactPerson ?? "",
    phone: supplier.phone ?? "",
    email: supplier.email ?? "",
    website: supplier.website ?? "",
    gstin: supplier.gstin ?? "",
    pan: supplier.pan ?? "",
    businessType: supplier.businessType ?? "",
    taxTreatment: supplier.taxTreatment ?? "registered",
    billingAddress: { ...emptyAddress(), ...(supplier.billingAddress ?? {}) },
    hasWarehouse: Boolean(supplier.warehouseAddress),
    warehouseAddress: { ...emptyAddress(), ...(supplier.warehouseAddress ?? {}) },
    paymentTerms: supplier.paymentTerms ?? "",
    creditDays: String(supplier.creditDays ?? 0),
    currency: supplier.currency || "INR",
    notes: supplier.notes ?? "",
  };
}

const compactPhone = (phone: string) => phone.replace(/[\s-]/g, "");
const isIndia = (country: string) => country.trim().toLowerCase() === "india";

function validateAddress(address: SupplierAddress, prefix: string, errors: Errors) {
  if (isIndia(address.country) && address.pincode.trim() && !PINCODE_PATTERN.test(address.pincode.trim())) {
    errors[`${prefix}.pincode`] = "A pincode in India is 6 digits.";
  }
}

export function validateSupplier(draft: SupplierDraft): Errors {
  const errors: Errors = {};
  const code = draft.code.trim();
  if (code && !CODE_PATTERN.test(code)) {
    errors.code = "Use 2–30 capital letters, digits or hyphens.";
  }
  if (!draft.name.trim()) errors.name = "Enter the supplier's name.";

  const gstin = draft.gstin.trim();
  if (gstin && !GSTIN_PATTERN.test(gstin)) {
    errors.gstin = "A GSTIN is 15 characters, like 29ABCDE1234F1Z5.";
  } else if (!gstin && draft.taxTreatment === "registered") {
    errors.gstin = "A registered supplier needs a GSTIN.";
  }

  const pan = draft.pan.trim();
  if (pan && !PAN_PATTERN.test(pan)) {
    errors.pan = "A PAN is 10 characters, like ABCDE1234F.";
  } else if (pan && gstin && GSTIN_PATTERN.test(gstin) && gstin.slice(2, 12) !== pan) {
    errors.pan = "The PAN doesn't match characters 3–12 of the GSTIN.";
  }

  if (draft.email.trim() && !EMAIL_PATTERN.test(draft.email.trim())) errors.email = "Enter a valid email address.";
  if (draft.phone.trim() && !PHONE_PATTERN.test(compactPhone(draft.phone.trim()))) {
    errors.phone = "Enter a 10-digit number, or + and the country code.";
  }

  const days = draft.creditDays.trim();
  if (days && (!INTEGER.test(days) || Number(days) > 365)) {
    errors.creditDays = "Credit days are a whole number from 0 to 365.";
  }

  validateAddress(draft.billingAddress, "billingAddress", errors);
  if (draft.hasWarehouse) validateAddress(draft.warehouseAddress, "warehouseAddress", errors);
  return errors;
}

const trimAddress = (address: SupplierAddress): SupplierAddress => ({
  line1: address.line1.trim(),
  line2: address.line2.trim(),
  city: address.city.trim(),
  state: address.state.trim(),
  country: address.country.trim(),
  pincode: address.pincode.trim(),
});

export function toSupplierInput(draft: SupplierDraft): SupplierInput {
  const code = draft.code.trim();
  return {
    ...(code ? { code } : {}),
    name: draft.name.trim(),
    legalName: draft.legalName.trim(),
    contactPerson: draft.contactPerson.trim(),
    phone: draft.phone.trim(),
    email: draft.email.trim(),
    website: draft.website.trim(),
    gstin: draft.gstin.trim() || null,
    pan: draft.pan.trim() || null,
    businessType: draft.businessType,
    taxTreatment: draft.taxTreatment,
    billingAddress: trimAddress(draft.billingAddress),
    warehouseAddress: draft.hasWarehouse ? trimAddress(draft.warehouseAddress) : null,
    paymentTerms: draft.paymentTerms.trim(),
    creditDays: Number(draft.creditDays.trim() || 0),
    currency: draft.currency,
    notes: draft.notes.trim(),
  };
}

/* -------------------------------------------------------- supplier–product */

export interface SupplierProductDraft {
  supplierSku: string;
  purchaseCost: string;
  moq: string;
  leadTimeDays: string;
  status: SupplierProductStatus;
  preferred: boolean;
  notes: string;
}

export function validateSupplierProduct(draft: SupplierProductDraft): Errors {
  const errors: Errors = {};
  const cost = draft.purchaseCost.trim();
  if (!cost || !DECIMAL.test(cost) || Number(cost) <= 0) {
    errors.purchaseCost = "Enter a cost above ₹0.";
  } else if (Number(cost) > 10_000_000) {
    errors.purchaseCost = "The cost can be at most ₹1,00,00,000.";
  }
  const moq = draft.moq.trim();
  if (!INTEGER.test(moq) || Number(moq) < 1) errors.moq = "The minimum order is a whole number, at least 1.";
  const lead = draft.leadTimeDays.trim();
  if (lead && (!INTEGER.test(lead) || Number(lead) > 365)) {
    errors.leadTimeDays = "Lead time is a whole number of days from 0 to 365, or blank.";
  }
  return errors;
}

export function toSupplierProductInput(draft: SupplierProductDraft): SupplierProductInput {
  const lead = draft.leadTimeDays.trim();
  return {
    supplierSku: draft.supplierSku.trim(),
    purchaseCost: Number(draft.purchaseCost.trim()),
    moq: Number(draft.moq.trim()),
    leadTimeDays: lead ? Number(lead) : null,
    status: draft.status,
    preferred: draft.preferred,
    notes: draft.notes.trim(),
  };
}

/* ---------------------------------------------------------- purchase order */

export interface PoLineDraft {
  productId: string;
  name: string;
  sku: string;
  supplierSku: string;
  quantity: string;
  unitCost: string;
  taxRate: string;
  /** The supplier's minimum order, when the product is linked to the supplier. */
  moq: number | null;
}

export interface PoDraft {
  supplierId: string;
  lines: PoLineDraft[];
  expectedAt: string;
  supplierReference: string;
  notes: string;
}

export const MAX_QUANTITY = 1_000_000;

export function validatePurchaseOrder(draft: PoDraft): Errors {
  const errors: Errors = {};
  if (!draft.supplierId) errors.supplierId = "Choose a supplier.";
  if (draft.lines.length === 0) errors.items = "Add at least one product.";

  const seen = new Set<string>();
  draft.lines.forEach((line, index) => {
    if (seen.has(line.productId)) errors.items = `${line.name} is on this order twice.`;
    seen.add(line.productId);

    const quantity = line.quantity.trim();
    if (!INTEGER.test(quantity) || Number(quantity) < 1 || Number(quantity) > MAX_QUANTITY) {
      errors[`items.${index}.quantity`] = "A whole number from 1 to 10,00,000.";
    }
    const cost = line.unitCost.trim();
    if (!cost) {
      // Blank is fine for a linked product: the server uses the supplier's purchase cost.
      if (line.moq === null) errors[`items.${index}.unitCost`] = "Enter the unit cost — this product isn't linked to the supplier.";
    } else if (!DECIMAL.test(cost) || Number(cost) <= 0) {
      errors[`items.${index}.unitCost`] = "Enter a cost above ₹0.";
    }
    const tax = line.taxRate.trim();
    if (tax && (!/^\d+(\.\d+)?$/.test(tax) || Number(tax) > 100)) {
      errors[`items.${index}.taxRate`] = "A percentage from 0 to 100, or blank for the product's rate.";
    }
  });
  return errors;
}

export function toPurchaseOrderInput(draft: PoDraft): PurchaseOrderInput {
  return {
    supplierId: draft.supplierId,
    items: draft.lines.map((line) => ({
      productId: line.productId,
      quantity: Number(line.quantity.trim()),
      ...(line.unitCost.trim() ? { unitCost: Number(line.unitCost.trim()) } : {}),
      ...(line.taxRate.trim() ? { taxRate: Number(line.taxRate.trim()) } : {}),
    })),
    ...(draft.expectedAt ? { expectedAt: draft.expectedAt } : {}),
    supplierReference: draft.supplierReference.trim(),
    notes: draft.notes.trim(),
  };
}

/** quantity × unit cost over the valid lines, before tax. A preview only. */
export function previewSubtotal(lines: PoLineDraft[]): number {
  return lines.reduce((sum, line) => {
    const quantity = Number(line.quantity);
    const cost = Number(line.unitCost);
    return Number.isFinite(quantity) && Number.isFinite(cost) && quantity > 0 && cost > 0
      ? sum + Math.round(quantity * cost * 100) / 100
      : sum;
  }, 0);
}

/* --------------------------------------------------------------- receiving */

export interface ReceiptLineDraft {
  poItemId: number;
  name: string;
  outstanding: number;
  received: string;
  damaged: string;
  rejected: string;
  note: string;
}

export interface ReceiptDraft {
  receivedAt: string;
  notes: string;
  lines: ReceiptLineDraft[];
  allowOverReceipt: boolean;
  overReceiptReason: string;
}

const count = (value: string) => (value.trim() === "" ? 0 : Number(value.trim()));

export function validateReceipt(draft: ReceiptDraft, today: string): Errors {
  const errors: Errors = {};
  if (draft.receivedAt && draft.receivedAt > today) errors.receivedAt = "The received date can't be in the future.";

  let anything = false;
  draft.lines.forEach((line, index) => {
    const fields = { receivedQty: line.received, damagedQty: line.damaged, rejectedQty: line.rejected } as const;
    let bad = false;
    for (const [key, value] of Object.entries(fields)) {
      if (value.trim() && !INTEGER.test(value.trim())) {
        errors[`items.${index}.${key}`] = "A whole number, 0 or more.";
        bad = true;
      }
    }
    if (bad) return;
    const received = count(line.received);
    const damaged = count(line.damaged);
    const rejected = count(line.rejected);
    if (received > 0) anything = true;
    if (damaged + rejected > received) {
      errors[`items.${index}.damagedQty`] = "Damaged and rejected can't be more than received.";
    }
    if (received > line.outstanding && !draft.allowOverReceipt) {
      errors[`items.${index}.receivedQty`] = `Only ${line.outstanding} outstanding. Tick “allow over-receipt” to accept more.`;
    }
  });
  if (!anything) errors.items = "Enter a received quantity for at least one line.";
  if (draft.allowOverReceipt && !draft.overReceiptReason.trim()) {
    errors.overReceiptReason = "Say why more than ordered is being accepted.";
  }
  return errors;
}

export function toReceiptInput(draft: ReceiptDraft, idempotencyKey: string): GoodsReceiptInput {
  return {
    ...(draft.receivedAt ? { receivedAt: draft.receivedAt } : {}),
    notes: draft.notes.trim(),
    idempotencyKey,
    items: draft.lines
      .filter((line) => count(line.received) > 0 || count(line.damaged) > 0 || count(line.rejected) > 0)
      .map((line) => ({
        poItemId: line.poItemId,
        receivedQty: count(line.received),
        damagedQty: count(line.damaged),
        rejectedQty: count(line.rejected),
        ...(line.note.trim() ? { note: line.note.trim() } : {}),
      })),
    allowOverReceipt: draft.allowOverReceipt,
    ...(draft.allowOverReceipt ? { overReceiptReason: draft.overReceiptReason.trim() } : {}),
  };
}

export function acceptedOf(line: ReceiptLineDraft): number {
  return Math.max(0, count(line.received) - count(line.damaged) - count(line.rejected));
}
