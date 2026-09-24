import type { Address } from "@/types";

import { apiDelete, apiGet, apiPost, apiPut } from "@/services/api/client";

/**
 * Saved addresses.
 *
 * Owned by the customer's account on the server, so they follow them between
 * devices — which is the whole reason to save one.
 *
 * "Exactly one default" is enforced by the API, not here: two tabs could each
 * think they had made the right one default, and only the writer can settle
 * it. The signatures are unchanged from the local-storage version this
 * replaced.
 */

const AUTH = { auth: "customer" } as const;

export async function getAddresses(): Promise<Address[]> {
  try {
    return await apiGet<Address[]>("/account/addresses", AUTH);
  } catch {
    // A signed-out visitor has no addresses, which is an empty list rather
    // than a failure — the checkout renders a blank form either way.
    return [];
  }
}

export async function getDefaultAddress(): Promise<Address | null> {
  const addresses = await getAddresses();
  return addresses.find((address) => address.isDefault) ?? addresses[0] ?? null;
}

export async function saveAddress(
  input: Omit<Address, "id"> & { id?: string },
): Promise<Address> {
  const payload = {
    fullName: input.fullName,
    phone: input.phone,
    line1: input.line1,
    line2: input.line2,
    city: input.city,
    state: input.state,
    pincode: input.pincode,
    country: "India",
    type: input.type,
    isDefault: input.isDefault,
  };

  return input.id
    ? apiPut<Address>(`/account/addresses/${encodeURIComponent(input.id)}`, payload, AUTH)
    : apiPost<Address>("/account/addresses", payload, AUTH);
}

export async function deleteAddress(id: string): Promise<void> {
  await apiDelete(`/account/addresses/${encodeURIComponent(id)}`, AUTH);
}

export async function setDefaultAddress(id: string): Promise<void> {
  const addresses = await getAddresses();
  const address = addresses.find((entry) => entry.id === id);
  if (!address) return;

  await saveAddress({ ...address, isDefault: true });
}
