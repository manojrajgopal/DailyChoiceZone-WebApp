import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generate the billing records.
 *
 * Run *after* `data:generate` and `data:admin`, because everything here hangs
 * off an existing order: an invoice exists because something was bought, a
 * payment exists because an invoice was raised, a refund exists because a
 * payment was taken. Nothing is invented independently, which is what makes the
 * portal behave like a relational system instead of four unrelated tables that
 * happen to look plausible.
 *
 *   customer → order → invoice → payment → refund → credit note
 *                  ↘ order lines → products
 *
 * The script also writes `invoiceId` and `paymentId` back onto each order, so
 * the relationship is navigable from either end — that is the column a real
 * schema would have.
 *
 * Money is in **paise**, as integers, matching `lib/money.ts`. The tax maths
 * mirrors `services/billing/taxService.ts`; `npm run data:check` re-derives the
 * totals from the stored components and fails if the two ever drift.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "src", "data");

const read = (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
const write = (file, value) => {
  const target = path.join(DATA, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};

const orders = read("admin/orders.json");
const customers = read("admin/customers.json");
const products = read("products.json");
const taxConfig = read("billing/tax-config.json");
const billingConfig = read("billing/billing-config.json");

const PRODUCT = new Map(products.map((p) => [p.id, p]));
const CUSTOMER = new Map(customers.map((c) => [c.id, c]));

/** Fixed "now", so regenerating produces no diff churn. */
const NOW = new Date("2026-09-23T10:30:00.000Z");
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString();
const clampToNow = (ms) => Math.min(ms, NOW.getTime());

/* ------------------------------------------------------------------- helpers */

function hash(seed) {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** mulberry32 — deterministic per seed, same generator the catalogue uses. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (list, r) => list[Math.floor(r() * list.length)];
const toMinor = (rupees) => Math.round(rupees * 100);

/** Largest-remainder split, so the parts sum exactly to the whole. */
function allocate(amount, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (amount * w) / total);
  const floors = exact.map(Math.floor);
  let remainder = amount - floors.reduce((s, v) => s + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] += 1;
    remainder -= 1;
  }
  return out;
}

const normalise = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function ratesFor(category) {
  return taxConfig.categoryRates?.[category] ?? taxConfig.rates;
}

/** Mirrors `taxService.calculateTax`. */
function calculateTax(amount, placeOfSupply, category) {
  if (!taxConfig.enabled || taxConfig.taxType === "NONE" || amount <= 0) {
    return { mode: "none", taxableAmount: Math.max(0, amount), cgst: 0, sgst: 0, igst: 0, totalTax: 0, ratePercent: 0 };
  }

  const intra = normalise(placeOfSupply) === normalise(taxConfig.originState);
  const rates = ratesFor(category);
  const ratePercent = intra ? rates.cgst + rates.sgst : rates.igst;

  let taxableAmount;
  let totalTax;
  if (taxConfig.pricesIncludeTax) {
    taxableAmount = Math.round((amount * 100) / (100 + ratePercent));
    totalTax = amount - taxableAmount;
  } else {
    taxableAmount = amount;
    totalTax = Math.round((amount * ratePercent) / 100);
  }

  if (!intra) {
    return { mode: "inter-state", taxableAmount, cgst: 0, sgst: 0, igst: totalTax, totalTax, ratePercent };
  }
  const cgst = Math.round(totalTax / 2);
  return { mode: "intra-state", taxableAmount, cgst, sgst: totalTax - cgst, igst: 0, totalTax, ratePercent };
}

const HSN = {
  women: "6204", men: "6203", kids: "6209", footwear: "6403", bags: "4202",
  jewellery: "7117", accessories: "6217", beauty: "3304", home: "6304",
  electronics: "8517", lifestyle: "9503",
};

/** Map the generated order's payment-method label onto a billing method key. */
const METHOD_KEY = {
  "UPI": "upi",
  "Credit card": "card",
  "Net banking": "netbanking",
  "Cash on delivery": "cod",
};

function billingAddressFrom(address, customer) {
  return {
    fullName: address.fullName,
    phone: address.phone,
    email: customer?.email ?? "",
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.pincode,
    country: "India",
  };
}

/* ------------------------------------------------------------------ invoices */

const invoices = [];
const payments = [];
const refunds = [];
const creditNotes = [];

/**
 * Invoices are numbered in the order the sales happened, not the order the
 * records were generated — a sequence with gaps or reversals is the first thing
 * an auditor queries. Oldest first.
 */
const billable = orders
  .filter((order) => order.status !== "cancelled")
  .slice()
  .sort((a, b) => a.placedAt.localeCompare(b.placedAt));

let invoiceSeq = billingConfig.invoice.startNumber;
let creditNoteSeq = billingConfig.creditNote.startNumber;

const invoiceIdByOrder = new Map();
const paymentIdByOrder = new Map();

for (const order of billable) {
  const r = rng(hash(`inv:${order.id}`));
  const customer = CUSTOMER.get(order.customerId);
  const placedAt = new Date(order.placedAt);
  const year = placedAt.getUTCFullYear();

  const invoiceNumber = `${billingConfig.invoice.prefix}-${year}-${String(invoiceSeq).padStart(billingConfig.invoice.padding, "0")}`;
  const invoiceId = `inv_${String(invoiceSeq).padStart(4, "0")}`;
  invoiceSeq += 1;

  const shipping = billingAddressFrom(order.shippingAddress, customer);
  // Most people bill where they ship. A minority bill elsewhere — a work
  // address, a parent's house — which is exactly the case the separate
  // billing-address option exists for, so the data has to contain some.
  const billsElsewhere = r() < 0.18 && (customer?.addresses?.length ?? 0) > 1;
  const billing = billsElsewhere
    ? billingAddressFrom(customer.addresses[1], customer)
    : shipping;

  const placeOfSupply = billing.state;

  const subtotal = toMinor(order.totals.subtotal);
  const couponDiscount = toMinor(order.totals.couponDiscount);
  const shippingFee = toMinor(order.totals.deliveryFee);

  const lineValues = order.lines.map((line) => toMinor(line.lineTotal));
  const lineDiscounts = allocate(couponDiscount, lineValues);

  let taxTotals = { taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0, ratePercent: 0, mode: "none" };

  const lines = order.lines.map((line, index) => {
    const product = PRODUCT.get(line.productId);
    const category = product?.category ?? null;
    const lineSubtotal = toMinor(line.unitPrice) * line.quantity;
    const discount = lineDiscounts[index] ?? 0;
    const chargeable = Math.max(0, lineSubtotal - discount);
    const tax = calculateTax(chargeable, placeOfSupply, category);

    taxTotals = {
      mode: tax.totalTax > 0 ? tax.mode : taxTotals.mode,
      taxableAmount: taxTotals.taxableAmount + tax.taxableAmount,
      cgst: taxTotals.cgst + tax.cgst,
      sgst: taxTotals.sgst + tax.sgst,
      igst: taxTotals.igst + tax.igst,
      totalTax: taxTotals.totalTax + tax.totalTax,
      ratePercent: Math.max(taxTotals.ratePercent, tax.ratePercent),
    };

    const rates = ratesFor(category);
    return {
      productId: line.productId,
      name: line.name,
      sku: line.sku,
      hsn: HSN[category] ?? "9999",
      size: line.size ?? null,
      color: line.color ?? null,
      quantity: line.quantity,
      unitPrice: toMinor(line.unitPrice),
      lineSubtotal,
      discount,
      taxableAmount: tax.taxableAmount,
      taxRatePercent: tax.mode === "intra-state" ? rates.cgst + rates.sgst : rates.igst,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
      tax: tax.totalTax,
      lineTotal: taxConfig.pricesIncludeTax ? chargeable : chargeable + tax.totalTax,
    };
  });

  const productDiscount = order.lines.reduce((total, line) => {
    const product = PRODUCT.get(line.productId);
    if (!product) return total;
    return total + Math.max(0, toMinor(product.originalPrice) - toMinor(line.unitPrice)) * line.quantity;
  }, 0);

  const goods = Math.max(0, subtotal - couponDiscount);
  const grandTotal = goods + shippingFee + (taxConfig.pricesIncludeTax ? 0 : taxTotals.totalTax);

  const methodKey = METHOD_KEY[order.paymentMethod] ?? "card";
  const isCod = methodKey === "cod";
  const settled = order.paymentStatus === "paid";

  /* ------------------------------------------------------------- payment */

  const paymentId = `pay_${String(invoices.length + 1).padStart(4, "0")}`;
  const transactionId = `TXN${order.placedAt.slice(0, 10).replace(/-/g, "")}${String(hash(order.id) % 100000).padStart(5, "0")}`;

  const paymentStatus =
    order.paymentStatus === "refunded"
      ? "refunded"
      : order.paymentStatus === "failed"
        ? "failed"
        : order.paymentStatus === "cod-pending"
          ? "pending"
          : "paid";

  // Cash on delivery settles when the courier hands it over, which is why a
  // delivered COD order is paid and an in-transit one is not.
  const capturedAt = settled
    ? iso(clampToNow(placedAt.getTime() + (isCod ? 4 * DAY : 60000)))
    : null;

  const timeline = [
    { status: "initiated", at: iso(placedAt), note: "Payment initiated at checkout." },
  ];
  if (paymentStatus === "failed") {
    timeline.push({
      status: "failed",
      at: iso(clampToNow(placedAt.getTime() + 90000)),
      note: "Declined by the issuing bank.",
    });
  } else {
    timeline.push({
      status: "processing",
      at: iso(clampToNow(placedAt.getTime() + 20000)),
      note: isCod ? "Awaiting collection on delivery." : "Sent to the payment provider.",
    });
    if (settled) {
      timeline.push({
        status: "succeeded",
        at: capturedAt,
        note: isCod ? "Collected by the courier." : "Authorised and captured.",
      });
    }
  }

  const instrumentHint = {
    upi: `•••••@${pick(["okhdfc", "okaxis", "ybl", "paytm"], r)}`,
    card: `•••• ${pick(["4242", "1881", "9006", "3310", "7712"], r)}`,
    netbanking: pick(["HDFC Bank", "ICICI Bank", "State Bank of India", "Axis Bank"], r),
    cod: "Collect on delivery",
  }[methodKey] ?? "";

  /* ------------------------------------------------------------- invoice */

  const invoiceStatus =
    paymentStatus === "paid"
      ? "paid"
      : paymentStatus === "refunded"
        ? "paid"
        : paymentStatus === "failed"
          ? "cancelled"
          : NOW.getTime() - placedAt.getTime() > billingConfig.invoice.dueDays * DAY
            ? "overdue"
            : "issued";

  invoices.push({
    id: invoiceId,
    invoiceNumber,
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    status: invoiceStatus,
    issuedAt: iso(placedAt),
    dueAt: iso(placedAt.getTime() + billingConfig.invoice.dueDays * DAY),
    billingAddress: billing,
    shippingAddress: shipping,
    placeOfSupply,
    lines,
    breakdown: {
      currency: billingConfig.currency.code,
      itemCount: order.totals.itemCount,
      subtotal,
      productDiscount,
      couponDiscount,
      couponCode: order.totals.appliedCoupon?.code ?? null,
      shipping: shippingFee,
      otherCharges: 0,
      taxableAmount: taxTotals.taxableAmount,
      tax: {
        mode: taxTotals.mode,
        taxableAmount: taxTotals.taxableAmount,
        cgst: taxTotals.cgst,
        sgst: taxTotals.sgst,
        igst: taxTotals.igst,
        totalTax: taxTotals.totalTax,
        ratePercent: taxTotals.ratePercent,
      },
      grandTotal,
      pricesIncludeTax: taxConfig.pricesIncludeTax,
    },
    paymentId,
    paymentMethod: methodKey,
    paymentStatus,
    amountPaid: settled ? grandTotal : 0,
    amountRefunded: 0,
    notes: billingConfig.invoice.notes,
    terms: billingConfig.invoice.paymentTerms,
  });

  payments.push({
    id: paymentId,
    transactionId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    invoiceId,
    invoiceNumber,
    customerId: order.customerId,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    amount: grandTotal,
    refundedAmount: 0,
    method: methodKey,
    status: paymentStatus,
    provider: "mock",
    createdAt: iso(placedAt),
    capturedAt,
    timeline,
    instrumentHint,
  });

  invoiceIdByOrder.set(order.id, invoiceId);
  paymentIdByOrder.set(order.id, paymentId);
}

/* ------------------------------------------------------------------- refunds */

/**
 * Refunds follow returns.
 *
 * Every returned order gets one, which is what makes the refund list reconcile
 * with the orders list. A few delivered orders get a *partial* refund for a
 * single item — the case the data model has to be able to represent, and the
 * one most likely to be got wrong if it is never exercised.
 */
const invoiceByOrder = new Map(invoices.map((invoice) => [invoice.orderId, invoice]));
const paymentByOrder = new Map(payments.map((payment) => [payment.orderId, payment]));

const REASONS = billingConfig.refund.reasons;

let refundSeq = 1;

function addRefund(order, { partial }) {
  const invoice = invoiceByOrder.get(order.id);
  const payment = paymentByOrder.get(order.id);
  if (!invoice || !payment || payment.status === "failed") return null;

  const r = rng(hash(`refund:${order.id}`));
  const placedAt = new Date(order.placedAt);
  const requestedAt = clampToNow(placedAt.getTime() + 6 * DAY);

  let amount;
  let lines = [];

  if (partial) {
    // One line, in full. Quantity-level partials are representable but this
    // keeps the generated data legible.
    const line = invoice.lines[Math.floor(r() * invoice.lines.length)];
    amount = line.lineTotal;
    lines = [{ productId: line.productId, name: line.name, quantity: line.quantity, amount }];
  } else {
    amount = invoice.breakdown.grandTotal
      - (billingConfig.refund.refundShipping ? 0 : invoice.breakdown.shipping);
  }

  if (amount <= 0) return null;

  const status = partial
    ? pick(["completed", "processing", "requested"], r)
    : pick(["completed", "completed", "completed", "processing"], r);

  const refundId = `ref_${String(refundSeq).padStart(4, "0")}`;
  refundSeq += 1;

  const processedAt = status === "completed" ? iso(clampToNow(requestedAt + 2 * DAY)) : null;

  refunds.push({
    id: refundId,
    refundNumber: `DCZ-RF-${placedAt.getUTCFullYear()}-${String(refundSeq - 1).padStart(5, "0")}`,
    orderId: order.id,
    orderNumber: order.orderNumber,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    paymentId: payment.id,
    customerId: order.customerId,
    customerName: order.customerName,
    amount,
    reason: pick(REASONS, r),
    status,
    requestedAt: iso(requestedAt),
    processedAt,
    lines,
    creditNoteId: null,
    initiatedBy: r() < 0.6 ? "customer" : "adm_002",
  });

  // Only a completed refund has actually moved money.
  if (status === "completed") {
    payment.refundedAmount += amount;
    payment.status = payment.refundedAmount >= payment.amount ? "refunded" : "partially-refunded";
    payment.timeline.push({
      status: "refunded",
      at: processedAt,
      note: partial ? "Partial refund issued." : "Full refund issued.",
    });
    invoice.amountRefunded += amount;
    invoice.paymentStatus = payment.status;
  }

  return refunds[refunds.length - 1];
}

for (const order of billable) {
  if (order.status === "returned") addRefund(order, { partial: false });
}

// A handful of partial refunds on delivered multi-line orders.
const partialCandidates = billable.filter(
  (order) => order.status === "delivered" && order.lines.length > 1 && order.paymentStatus === "paid",
);
for (const order of partialCandidates.slice(0, 16)) addRefund(order, { partial: true });

/* -------------------------------------------------------------- credit notes */

/**
 * A credit note documents the tax adjustment a refund implies.
 *
 * Issued against completed refunds, because there is nothing to credit until
 * the money has actually gone back. Its tax is recomputed from the refunded
 * amount rather than copied, so it reconciles with the invoice it offsets.
 */
for (const refund of refunds.filter((entry) => entry.status === "completed")) {
  const invoice = invoices.find((entry) => entry.id === refund.invoiceId);
  if (!invoice) continue;

  const tax = calculateTax(refund.amount, invoice.placeOfSupply, null);
  const issuedAt = refund.processedAt ?? refund.requestedAt;
  const year = new Date(issuedAt).getUTCFullYear();

  const note = {
    id: `cn_${String(creditNoteSeq).padStart(4, "0")}`,
    creditNoteNumber: `${billingConfig.creditNote.prefix}-${year}-${String(creditNoteSeq).padStart(billingConfig.creditNote.padding, "0")}`,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    orderId: invoice.orderId,
    orderNumber: invoice.orderNumber,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    refundId: refund.id,
    reason: refund.reason,
    amount: tax.taxableAmount,
    tax: tax.totalTax,
    total: refund.amount,
    issuedAt,
    status: "issued",
  };
  creditNoteSeq += 1;

  creditNotes.push(note);
  refund.creditNoteId = note.id;
}

/* ------------------------------------------------ write back the relationships */

const patchedOrders = orders.map((order) => ({
  ...order,
  invoiceId: invoiceIdByOrder.get(order.id) ?? null,
  paymentId: paymentIdByOrder.get(order.id) ?? null,
}));

write("admin/orders.json", patchedOrders);
write("billing/invoices.json", invoices);
write("billing/payments.json", payments);
write("billing/refunds.json", refunds);
write("billing/credit-notes.json", creditNotes);

/* ------------------------------------------------------------------- summary */

const money = (minor) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const totalBilled = invoices.reduce((s, i) => s + i.breakdown.grandTotal, 0);
const totalPaid = invoices.reduce((s, i) => s + i.amountPaid, 0);
const totalTax = invoices.reduce((s, i) => s + i.breakdown.tax.totalTax, 0);
const totalRefunded = refunds.filter((r) => r.status === "completed").reduce((s, r) => s + r.amount, 0);

console.log(`invoices.json      ${invoices.length}`);
console.log(`payments.json      ${payments.length}`);
console.log(`refunds.json       ${refunds.length} (${refunds.filter((r) => r.lines.length > 0).length} partial)`);
console.log(`credit-notes.json  ${creditNotes.length}`);
console.log(`orders patched     ${invoiceIdByOrder.size} of ${orders.length} carry an invoiceId`);
console.log(`billed             ${money(totalBilled)}`);
console.log(`paid               ${money(totalPaid)}`);
console.log(`tax                ${money(totalTax)}`);
console.log(`refunded           ${money(totalRefunded)}`);
