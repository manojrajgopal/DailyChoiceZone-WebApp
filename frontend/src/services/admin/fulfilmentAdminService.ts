import type { FulfilmentAction, OrderFulfilment } from "@/types/fulfilment";

import { apiGet, apiPost } from "@/services/api/client";
import { moveShipment } from "@/services/shippingService";

/**
 * An order's fulfilment: the lifecycle and next actions the server decided
 * (docs/order-fulfilment.md). Every call throws `ApiError` on failure, with
 * the server's business message ("Order cannot be packed because payment is
 * pending."). Nothing is assumed to have worked: each mutation answers with
 * fresh state, which the screen reloads.
 */

const ADMIN = { auth: "admin" } as const;
const enc = encodeURIComponent;

export function getOrderFulfilment(orderId: string): Promise<OrderFulfilment> {
  return apiGet(`/admin/orders/${enc(orderId)}/fulfilment`, ADMIN);
}

/** One of the order page's `order` actions: confirm, start-packing, begin-packing, repack, cancel, record-return. */
export function runOrderAction(
  orderId: string,
  action: string,
  input: { reason?: string; note?: string } = {},
): Promise<OrderFulfilment> {
  return apiPost(`/admin/orders/${enc(orderId)}/fulfilment/actions`, { action, ...input }, ADMIN);
}

/**
 * Take a server-offered action. `link` and `create-shipment` are handled by
 * the screen (navigation, the create dialog); this does the two that call
 * the API.
 */
export async function performAction(orderId: string, action: FulfilmentAction, reason = ""): Promise<void> {
  if (action.kind === "order") {
    await runOrderAction(orderId, action.key, { reason });
    return;
  }
  if (action.kind === "shipment" && action.shipmentId && action.target) {
    await moveShipment(action.shipmentId, { status: action.target, reason });
    return;
  }
  throw new Error(`The action "${action.key}" isn't performed through the API.`);
}
