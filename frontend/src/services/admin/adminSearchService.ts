import type { AdminNotification } from "@/types/admin";

import { formatMoney } from "@/lib/money";
import { billingDataSource } from "@/services/billing/billing-data-source.instance";

import { adminDataSource } from "./admin-data-source.instance";

/**
 * Global admin search.
 *
 * One box across products, orders, customers and billing, because an
 * administrator arrives with an identifier — an order number from an email, a
 * transaction reference from a bank statement, an invoice number from an
 * accountant — and should not have to decide which list it lives in first.
 *
 * Billing references are exactly the case that makes a global search worth
 * having: nobody knows whether "TXN20260904…" is a payment or a refund until
 * they have found it.
 */

export type SearchResultKind =
  | "product"
  | "order"
  | "customer"
  | "invoice"
  | "payment"
  | "refund";

export interface AdminSearchResult {
  kind: SearchResultKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export interface AdminSearchResults {
  products: AdminSearchResult[];
  orders: AdminSearchResult[];
  customers: AdminSearchResult[];
  invoices: AdminSearchResult[];
  payments: AdminSearchResult[];
  refunds: AdminSearchResult[];
  total: number;
}

export const EMPTY_SEARCH_RESULTS: AdminSearchResults = {
  products: [],
  orders: [],
  customers: [],
  invoices: [],
  payments: [],
  refunds: [],
  total: 0,
};

const EMPTY = EMPTY_SEARCH_RESULTS;

/** Every term must appear somewhere in the record, so more words narrow. */
function matches(haystack: string, terms: string[]): boolean {
  const text = haystack.toLowerCase();
  return terms.every((term) => text.includes(term));
}

export async function search(term: string, perGroup = 5): Promise<AdminSearchResults> {
  const trimmed = term.trim();
  if (trimmed.length < 2) return EMPTY;

  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);

  const [products, orders, customers, invoices, payments, refunds] = await Promise.all([
    adminDataSource.listProducts(),
    adminDataSource.listOrders(),
    adminDataSource.listCustomers(),
    billingDataSource.listInvoices({ search: trimmed }),
    billingDataSource.listPayments({ search: trimmed }),
    billingDataSource.listRefunds({ search: trimmed }),
  ]);

  const productHits: AdminSearchResult[] = products
    .filter((product) =>
      matches([product.name, product.sku, product.brand, product.category, product.subcategory].join(" "), terms),
    )
    .slice(0, perGroup)
    .map((product) => ({
      kind: "product" as const,
      id: product.id,
      title: product.name,
      subtitle: `${product.sku} · ${product.brand}`,
      href: `/admin/products/edit?id=${product.id}`,
    }));

  const orderHits: AdminSearchResult[] = orders
    .filter((order) =>
      matches([order.orderNumber, order.customerName, order.customerEmail, order.status].join(" "), terms),
    )
    .slice(0, perGroup)
    .map((order) => ({
      kind: "order" as const,
      id: order.id,
      title: order.orderNumber,
      subtitle: `${order.customerName} · ${order.status}`,
      href: `/admin/orders/detail?id=${order.id}`,
    }));

  const customerHits: AdminSearchResult[] = customers
    .filter((customer) =>
      matches([customer.firstName, customer.lastName, customer.email, customer.phone].join(" "), terms),
    )
    .slice(0, perGroup)
    .map((customer) => ({
      kind: "customer" as const,
      id: customer.id,
      title: `${customer.firstName} ${customer.lastName}`,
      subtitle: customer.email,
      href: `/admin/customers/detail?id=${customer.id}`,
    }));

  // The billing adapter has already filtered these by the same term, so they
  // only need capping and shaping.
  const invoiceHits: AdminSearchResult[] = invoices.slice(0, perGroup).map((invoice) => ({
    kind: "invoice" as const,
    id: invoice.id,
    title: invoice.invoiceNumber,
    subtitle: `${invoice.customerName} · ${formatMoney(invoice.breakdown.grandTotal)}`,
    href: `/admin/billing/invoices/detail?id=${invoice.id}`,
  }));

  const paymentHits: AdminSearchResult[] = payments.slice(0, perGroup).map((payment) => ({
    kind: "payment" as const,
    id: payment.id,
    title: payment.transactionId,
    subtitle: `${payment.customerName} · ${formatMoney(payment.amount)}`,
    href: `/admin/billing/payments/detail?id=${payment.id}`,
  }));

  const refundHits: AdminSearchResult[] = refunds.slice(0, perGroup).map((refund) => ({
    kind: "refund" as const,
    id: refund.id,
    title: refund.refundNumber,
    subtitle: `${refund.customerName} · ${formatMoney(refund.amount)}`,
    href: "/admin/billing/refunds",
  }));

  return {
    products: productHits,
    orders: orderHits,
    customers: customerHits,
    invoices: invoiceHits,
    payments: paymentHits,
    refunds: refundHits,
    total:
      productHits.length +
      orderHits.length +
      customerHits.length +
      invoiceHits.length +
      paymentHits.length +
      refundHits.length,
  };
}

/* ------------------------------------------------------------ notifications */

export function listNotifications(): Promise<AdminNotification[]> {
  return adminDataSource.listNotifications();
}

export function markNotificationRead(id: string): Promise<void> {
  return adminDataSource.markNotificationRead(id);
}

export function markAllNotificationsRead(): Promise<void> {
  return adminDataSource.markAllNotificationsRead();
}
