import adminBannersJson from "@/data/admin/banners.json";

import type { AdminBanner } from "@/types/admin";
import type { PromoBanner } from "@/types";

import { OVERLAY_KEYS, resolve } from "./mock-store";

/**
 * The promotional strip, resolved from the banners an administrator manages.
 *
 * There is one banner record. The portal edits the whole thing — message,
 * link, schedule, whether it runs at all — and the storefront reads back only
 * the part it renders. Keeping a second `banners.json` for the customer side
 * would mean an administrator scheduling a banner that never appeared.
 *
 * A banner is live when it is switched on and inside its dates; the schedule
 * is evaluated at read time, so a banner starts and stops on its own without
 * anyone touching it.
 */
export function livePromoBanners(now: Date = new Date()): PromoBanner[] {
  const banners = resolve(adminBannersJson as AdminBanner[], OVERLAY_KEYS.banners);

  return banners
    .filter((banner) => {
      if (!banner.active) return false;
      if (new Date(banner.startsAt) > now) return false;
      if (banner.endsAt && new Date(banner.endsAt) < now) return false;
      return true;
    })
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((banner) => ({
      id: banner.id,
      message: banner.title,
      href: banner.buttonLink || undefined,
    }));
}
