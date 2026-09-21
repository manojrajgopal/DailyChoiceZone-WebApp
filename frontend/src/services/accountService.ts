import type { Address } from "@/types";

import { STORAGE_KEYS, readJson, writeJson } from "@/lib/storage/local-storage";

/**
 * Saved addresses.
 *
 * Local storage today; `GET/POST/PUT/DELETE /addresses` later. Only one
 * address can be the default, which is enforced here rather than trusted to
 * the caller.
 */

function read(): Address[] {
  return readJson<Address[]>(STORAGE_KEYS.addresses, []);
}

function write(addresses: Address[]): Address[] {
  writeJson(STORAGE_KEYS.addresses, addresses);
  return addresses;
}

/** Guarantee exactly one default, preferring `preferredId` when given. */
function normaliseDefaults(addresses: Address[], preferredId?: string): Address[] {
  if (addresses.length === 0) return addresses;
  const defaultId =
    preferredId ?? addresses.find((address) => address.isDefault)?.id ?? addresses[0]!.id;
  return addresses.map((address) => ({ ...address, isDefault: address.id === defaultId }));
}

export async function getAddresses(): Promise<Address[]> {
  return read();
}

export async function getDefaultAddress(): Promise<Address | null> {
  const addresses = read();
  return addresses.find((address) => address.isDefault) ?? addresses[0] ?? null;
}

export async function saveAddress(input: Omit<Address, "id"> & { id?: string }): Promise<Address> {
  const addresses = read();
  const id = input.id ?? `addr_${Date.now()}`;
  const address: Address = { ...input, id };

  const existingIndex = addresses.findIndex((entry) => entry.id === id);
  const next =
    existingIndex >= 0
      ? addresses.map((entry) => (entry.id === id ? address : entry))
      : [...addresses, address];

  write(normaliseDefaults(next, address.isDefault ? id : undefined));
  return address;
}

export async function deleteAddress(id: string): Promise<void> {
  const remaining = read().filter((address) => address.id !== id);
  write(normaliseDefaults(remaining));
}

export async function setDefaultAddress(id: string): Promise<void> {
  write(normaliseDefaults(read(), id));
}
