import type { AdminNotification } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/**
 * Global admin search.
 *
 * One box across products, orders and customers, because an administrator
 * arrives with an identifier — an order number from an email, a product name
 * from a support call — and should not have to decide which list it lives in
 * first.
 */

export type SearchResultKind = "product" | "order" | "customer";

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
  total: number;
}

const EMPTY: AdminSearchResults = { products: [], orders: [], customers: [], total: 0 };

/** Every term must appear somewhere in the record, so more words narrow. */
function matches(haystack: string, terms: string[]): boolean {
  const text = haystack.toLowerCase();
  return terms.every((term) => text.includes(term));
}

export async function search(term: string, perGroup = 5): Promise<AdminSearchResults> {
  const trimmed = term.trim();
  if (trimmed.length < 2) return EMPTY;

  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);

  const [products, orders, customers] = await Promise.all([
    adminDataSource.listProducts(),
    adminDataSource.listOrders(),
    adminDataSource.listCustomers(),
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

  return {
    products: productHits,
    orders: orderHits,
    customers: customerHits,
    total: productHits.length + orderHits.length + customerHits.length,
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
