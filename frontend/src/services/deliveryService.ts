import { apiGet } from "@/services/api/client";

/**
 * Can the store deliver to a pincode, and on what terms.
 *
 * The answer is the server's: the list of pincodes is the store's own, set up
 * in the portal. The browser only asks and shows; checkout enforces it again
 * when the order is placed.
 */
export interface PincodeCheck {
  pincode: string;
  valid: boolean;
  serviceable: boolean;
  /** Whether the store lists this pincode (rather than the default for unlisted ones). */
  listed: boolean;
  reason: string;
  codAvailable: boolean;
  expressAvailable: boolean;
  minDays: number | null;
  maxDays: number | null;
  /** e.g. "Thu, 8 Oct". */
  estimate: string | null;
  /** Standard delivery, in rupees, before the free-delivery threshold. */
  deliveryFee: number | null;
  freeDeliveryThreshold: number | null;
  city: string;
  district: string;
  state: string;
}

export const PINCODE_PATTERN = /^[1-9]\d{5}$/;

export function checkPincode(pincode: string): Promise<PincodeCheck> {
  return apiGet(`/delivery/pincodes/${encodeURIComponent(pincode)}`);
}
