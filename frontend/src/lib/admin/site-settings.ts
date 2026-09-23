import adminSettingsJson from "@/data/admin/settings.json";

import type { SiteConfig, SocialLink } from "@/types";
import type { StoreSettings } from "@/types/admin";

import { OVERLAY_KEYS, readDocument } from "./mock-store";

/**
 * Apply the store settings an administrator manages to the storefront config.
 *
 * `site-config.json` holds the parts of the storefront that are page
 * furniture — footer columns, trust points, the canonical URL. The commercial
 * numbers on top of it are not page furniture: the delivery threshold decides
 * what a customer is charged, and the returns window is a promise. Those live
 * in store settings, because that is where they are edited.
 *
 * Without this join the settings page would be a form that changes nothing,
 * which is worse than not having the form.
 */

const BASE_SETTINGS = adminSettingsJson as StoreSettings;

/**
 * Re-point the configured social links at the URLs in settings.
 *
 * Mapped over the base list rather than rebuilt from it, so each link keeps
 * its label and icon — settings hold addresses, not presentation. A field
 * cleared in the portal drops the link entirely.
 */
function socialLinks(settings: StoreSettings, base: SocialLink[]): SocialLink[] {
  const byLabel: Record<string, string | undefined> = {
    instagram: settings.social.instagram,
    facebook: settings.social.facebook,
    youtube: settings.social.youtube,
  };

  return base
    .map((link) => {
      const href = byLabel[link.label.toLowerCase()];
      return href === undefined ? link : { ...link, href: href.trim() };
    })
    .filter((link) => link.href.length > 0);
}

export function applyStoreSettings(base: SiteConfig): SiteConfig {
  const settings = readDocument(OVERLAY_KEYS.settings, BASE_SETTINGS);

  return {
    ...base,
    name: settings.general.storeName,
    tagline: settings.general.tagline,
    description: settings.general.description,
    locale: settings.currency.locale,
    support: {
      email: settings.contact.email,
      phone: settings.contact.phone,
      hours: settings.contact.supportHours,
    },
    freeDeliveryThreshold: settings.shipping.freeDeliveryThreshold,
    standardDeliveryFee: settings.shipping.standardFee,
    returnWindowDays: settings.returns.windowDays,
    social: socialLinks(settings, base.social),
  };
}
