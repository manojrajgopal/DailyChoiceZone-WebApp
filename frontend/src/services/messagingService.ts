import { apiGet, apiPost, apiPut } from "@/services/api/client";

/**
 * Storefront calls for reorder, the customer's notification choices, the
 * unsubscribe link and campaign link tracking.
 */

const AUTH = { auth: "customer" } as const;

/* ------------------------------------------------------------------ reorder */

export type ReorderStatus = "available" | "limited" | "in_bag" | "out_of_stock" | "discontinued" | "unavailable"
  | "variant_unavailable" | "bundle_unavailable" | "rejected";

export interface ReorderLine {
  key: string;
  kind: "item" | "bundle";
  orderItemId?: number;
  productId?: string;
  bundleId?: number;
  name: string;
  image: string;
  slug?: string;
  size?: string | null;
  color?: string | null;
  orderedQuantity: number;
  orderedUnitPrice?: number;
  currentPrice: number | null;
  quantity: number;
  status: ReorderStatus;
  reason: string | null;
  components?: { name: string; size: string | null; color: string | null; quantity: number }[];
}

export interface Reorderable {
  orderId: string;
  orderNumber: string;
  placedAt: string;
  items: ReorderLine[];
  addable: number;
  unavailable: number;
}

export interface ReorderResult {
  added: ReorderLine[];
  skipped: ReorderLine[];
  message: string;
  units: number;
}

export const getReorderable = (orderId: string) => apiGet<Reorderable>(`/orders/${encodeURIComponent(orderId)}/reorder`, AUTH);
export const reorder = (orderId: string, keys?: string[]) =>
  apiPost<ReorderResult>(`/orders/${encodeURIComponent(orderId)}/reorder`, keys ? { keys } : {}, AUTH);

/* -------------------------------------------------------------- preferences */

export type MessageChannel = "email" | "sms" | "whatsapp" | "in_app";

export interface ChannelChoice {
  channel: MessageChannel;
  category: "transactional" | "marketing";
  enabled: boolean;
  available: boolean;
  updatedAt: string | null;
}

export interface ChannelPreferences {
  phone: string;
  phoneUsable: boolean;
  choices: ChannelChoice[];
}

export const getChannelPreferences = () => apiGet<ChannelPreferences>("/account/notification-preferences", AUTH);
export const saveChannelPreferences = (choices: Pick<ChannelChoice, "channel" | "category" | "enabled">[]) =>
  apiPut<ChannelPreferences>("/account/notification-preferences", choices, AUTH);

/* --------------------------------------------------------- links in messages */

export const unsubscribe = (token: string) =>
  apiPost<{ channel: MessageChannel; unsubscribed: boolean }>("/notifications/unsubscribe", { token });

export const followCampaignLink = (token: string, to: string, s: string) =>
  apiPost<{ url: string }>("/campaigns/click", { token, to, s });
