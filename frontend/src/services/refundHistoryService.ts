import { apiGet } from "@/services/api/client";
import type { CustomerRefund } from "@/types/refunds";

const AUTH = { auth: "customer" } as const;

/** The signed-in customer's refunds, newest first. */
export async function listMyRefunds(): Promise<CustomerRefund[]> {
  return (await apiGet<{ items: CustomerRefund[] }>("/account/refunds", AUTH)).items;
}

/** One of their orders' refunds (404 when the order isn't theirs). */
export async function listOrderRefunds(identifier: string): Promise<CustomerRefund[]> {
  return (await apiGet<{ items: CustomerRefund[] }>(`/account/orders/${encodeURIComponent(identifier)}/refunds`, AUTH))
    .items;
}
