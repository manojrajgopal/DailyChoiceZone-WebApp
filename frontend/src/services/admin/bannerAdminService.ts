import type { AdminBanner, AdminResult } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/** Promotional banner management — the strip above the storefront header. */

export function listBanners(): Promise<AdminBanner[]> {
  return adminDataSource.listBanners();
}

/** Whether a banner is actually showing right now, dates included. */
export function isLive(banner: AdminBanner, now = new Date()): boolean {
  if (!banner.active) return false;
  if (new Date(banner.startsAt) > now) return false;
  if (banner.endsAt && new Date(banner.endsAt) < now) return false;
  return true;
}

export async function saveBanner(banner: AdminBanner): Promise<AdminResult<AdminBanner>> {
  if (banner.title.trim().length < 4) {
    return { ok: false, reason: "Enter a banner message of at least four characters." };
  }
  if (banner.buttonText.trim() && !banner.buttonLink.trim()) {
    return { ok: false, reason: "A button needs a link." };
  }
  if (banner.buttonLink.trim() && !banner.buttonLink.startsWith("/")) {
    return { ok: false, reason: "Links must be internal and start with a slash." };
  }
  if (banner.endsAt && new Date(banner.endsAt) <= new Date(banner.startsAt)) {
    return { ok: false, reason: "The end date must be after the start date." };
  }

  return { ok: true, data: await adminDataSource.saveBanner(banner) };
}

export async function toggleBanner(id: string): Promise<AdminResult<AdminBanner>> {
  const banners = await adminDataSource.listBanners();
  const banner = banners.find((entry) => entry.id === id);
  if (!banner) return { ok: false, reason: "That banner no longer exists." };
  return { ok: true, data: await adminDataSource.saveBanner({ ...banner, active: !banner.active }) };
}

/** Swap two banners' display order, then persist both. */
export async function moveBanner(id: string, direction: "up" | "down"): Promise<AdminBanner[]> {
  const banners = await adminDataSource.listBanners();
  const index = banners.findIndex((banner) => banner.id === id);
  const target = direction === "up" ? index - 1 : index + 1;

  if (index === -1 || target < 0 || target >= banners.length) return banners;

  const a = banners[index]!;
  const b = banners[target]!;
  await adminDataSource.saveBanner({ ...a, displayOrder: b.displayOrder });
  await adminDataSource.saveBanner({ ...b, displayOrder: a.displayOrder });

  return adminDataSource.listBanners();
}

export async function deleteBanner(id: string): Promise<AdminResult<string>> {
  const banners = await adminDataSource.listBanners();
  const banner = banners.find((entry) => entry.id === id);
  if (!banner) return { ok: false, reason: "That banner no longer exists." };
  await adminDataSource.deleteBanner(id);
  return { ok: true, data: banner.title };
}

export function emptyBanner(order: number): AdminBanner {
  return {
    id: `banner_${Date.now()}`,
    title: "",
    subtitle: "",
    image: "",
    buttonText: "",
    buttonLink: "",
    startsAt: new Date().toISOString(),
    endsAt: null,
    active: true,
    displayOrder: order,
  };
}
