import type { AdminCustomer, AdminOrder, AdminResult } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/** Customer management. Read-mostly — the only mutation is blocking someone. */

export function listCustomers(): Promise<AdminCustomer[]> {
  return adminDataSource.listCustomers();
}

export function getCustomer(id: string): Promise<AdminCustomer | null> {
  return adminDataSource.getCustomer(id);
}

/** A customer's orders, newest first. Joined by id rather than duplicated. */
export async function getCustomerOrders(customerId: string): Promise<AdminOrder[]> {
  const orders = await adminDataSource.listOrders();
  return orders.filter((order) => order.customerId === customerId);
}

export async function setCustomerStatus(
  id: string,
  status: AdminCustomer["status"],
): Promise<AdminResult<AdminCustomer>> {
  const customer = await adminDataSource.getCustomer(id);
  if (!customer) return { ok: false, reason: "That customer no longer exists." };
  return { ok: true, data: await adminDataSource.setCustomerStatus(id, status) };
}
