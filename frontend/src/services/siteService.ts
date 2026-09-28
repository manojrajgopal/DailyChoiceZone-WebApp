import type {
  HomepageConfig,
  HomeSectionLayout,
  NavItem,
  PromoBanner,
  SiteConfig,
  SiteContent,
} from "@/types";

import { setAnalyticsRanges } from "@/services/admin/analyticsAdminService";
import { setSectionKinds } from "@/services/admin/homepageAdminService";
import { apiGet } from "@/services/api/client";
import { setPaymentMethodLabels } from "@/services/billing/paymentService";

import { dataSource } from "./data-source.instance";
import { setDeliveryMethods, setPaymentMethods } from "./orderService";

/**
 * Site chrome and page composition.
 *
 * All of it comes from the API, including the menus. They used to be JSON in
 * the bundle, on the argument that a menu entry names a route that has to
 * exist — but that made the one thing a merchandiser most wants to reorder the
 * one thing that needed a deployment.
 */

export function getNavigation(): Promise<NavItem[]> {
  return apiGet<NavItem[]>("/site/navigation");
}

export function getSiteConfig(): Promise<SiteConfig> {
  return dataSource.getSiteConfig();
}

export function getHomepageConfig(): Promise<HomepageConfig> {
  return dataSource.getHomepageConfig();
}

/** Which homepage sections are live, in the order an administrator set. */
export function getHomeSectionLayout(): Promise<HomeSectionLayout[]> {
  return dataSource.getHomeSectionLayout();
}

export function getBanners(): Promise<PromoBanner[]> {
  return dataSource.listBanners();
}

/* ------------------------------------------------------------------ content */

/**
 * Read once per page load.
 *
 * Every form that needs a list of states, every dropdown in the portal and the
 * FAQ all read this, so a page can ask for it several times; the promise is
 * shared so they cost one request between them.
 *
 * Module state, which means it is per-request on the server and per-page in
 * the browser — never stale for longer than the page somebody is looking at.
 */
let cached: Promise<SiteContent> | null = null;

export function getSiteContent(): Promise<SiteContent> {
  cached ??= apiGet<SiteContent>("/site/content").then(adopt);
  return cached;
}

/**
 * Hand the parts that have to answer synchronously to the code that needs them.
 *
 * An invoice labels a payment method while rendering and `toOrder` resolves a
 * delivery method inside a pure mapper — neither can await. They hold the
 * answer as module state and this is what fills it in, so one fetch serves
 * both instead of each keeping its own copy.
 */
function adopt(content: SiteContent): SiteContent {
  setDeliveryMethods(content.deliveryMethods ?? []);
  setPaymentMethods(content.paymentMethods ?? []);
  setPaymentMethodLabels(
    Object.fromEntries((content.paymentMethods ?? []).map((m) => [m.id, m.label])),
  );
  setAnalyticsRanges(content.analyticsRanges ?? []);
  setSectionKinds(content.homeSectionKinds ?? []);
  return content;
}

/** Drop the cache, so the next read sees a change the portal just saved. */
export function refreshSiteContent(): void {
  cached = null;
}
