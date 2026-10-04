import type { Collection } from "@/types";
import type { AdminResult } from "@/types/admin";

import { slugify } from "@/lib/utils/format";

import { adminDataSource } from "./admin-data-source.instance";

/** Collection management. Membership is curated, not computed. */

export function listCollections(): Promise<Collection[]> {
  return adminDataSource.listCollections();
}

export async function getCollection(id: string): Promise<Collection | null> {
  const collections = await adminDataSource.listCollections();
  return collections.find((collection) => collection.id === id) ?? null;
}

export async function saveCollection(collection: Collection): Promise<AdminResult<Collection>> {
  if (collection.name.trim().length < 2) {
    return { ok: false, reason: "Enter a collection name." };
  }
  if (collection.productIds.length === 0) {
    return { ok: false, reason: "Add at least one product to the collection." };
  }

  const slug = collection.slug.trim() || slugify(collection.name);
  const existing = await adminDataSource.listCollections();
  const clash = existing.find((c) => c.slug === slug && c.id !== collection.id);
  if (clash) return { ok: false, reason: `That web address is already used by ${clash.name}. Please choose another.` };

  // Products are chosen by ID; the server drops any ID that no longer resolves,
  // so a collection page can never 404 a tile — no catalogue download needed.
  return { ok: true, data: await adminDataSource.saveCollection({ ...collection, slug }) };
}

export async function deleteCollection(id: string): Promise<AdminResult<string>> {
  const collection = await getCollection(id);
  if (!collection) return { ok: false, reason: "That collection no longer exists." };
  await adminDataSource.deleteCollection(id);
  return { ok: true, data: collection.name };
}
