import navigationJson from "@/data/navigation.json";

import type { HomepageConfig, NavItem, PromoBanner, SiteConfig } from "@/types";

import { dataSource } from "./data-source.instance";

/**
 * Site chrome and page composition.
 *
 * Navigation is read directly here rather than through the data source: menu
 * structure is frontend configuration, not business data, and it is needed
 * synchronously to render the header on the server. If it ever becomes
 * CMS-managed, add a `listNavigation()` method to `DataSource` and route it
 * through the adapter like everything else.
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

export function getBanners(): Promise<PromoBanner[]> {
  return dataSource.listBanners();
}
