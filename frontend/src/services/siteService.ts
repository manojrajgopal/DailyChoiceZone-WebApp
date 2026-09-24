import navigationJson from "@/config/navigation/storefront.json";

import type {
  HomepageConfig,
  HomeSectionLayout,
  NavItem,
  PromoBanner,
  SiteConfig,
} from "@/types";

import { dataSource } from "./data-source.instance";

/**
 * Site chrome and page composition.
 *
 * Navigation is read from `src/config` rather than through the data source,
 * and that is the one exception on purpose: every entry names a route that has
 * to exist in `src/app`, and the header renders on the first paint before any
 * request has been made. See `src/config/README.md`. Everything else on this
 * page — the site config, the homepage layout, the banners — is business data
 * and comes from the API.
 */
export function getNavigation(): NavItem[] {
  return navigationJson as NavItem[];
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
