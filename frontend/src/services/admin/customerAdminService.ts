import type { AdminCustomer, AdminOrder, AdminResult } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/** Customer management. Read-mostly — the only mutation is blocking someone. */

/** Every customer, or — given a Customer ID — exactly that one. Names and emails are not IDs. */
export function listCustomers(customerId?: string): Promise<AdminCustomer[]> {
  return adminDataSource.listCustomers(customerId || undefined);
}

export function getCustomer(id: string): Promise<AdminCustomer | null> {
  return adminDataSource.getCustomer(id);
}

/** A customer's orders, newest first. Joined by id rather than duplicated. */
export function getCustomerOrders(customerId: string): Promise<AdminOrder[]> {
  return adminDataSource.listOrders(customerId);
}

export async function setCustomerStatus(
  id: string,
  status: AdminCustomer["status"],
): Promise<AdminResult<AdminCustomer>> {
  const customer = await adminDataSource.getCustomer(id);
  if (!customer) return { ok: false, reason: "That customer no longer exists." };
  return { ok: true, data: await adminDataSource.setCustomerStatus(id, status) };
}
