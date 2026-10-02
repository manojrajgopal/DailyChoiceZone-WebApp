/**
 * Admin fixtures for slice G1 (admin views).
 *
 *   signInAdminUser({ role: "editor" })   // token + store session + /admin/auth/me answered
 *   siteContent({ adminRoles: [...] })    // a complete /site/content payload
 */
import type { SiteContent } from "@/types";
import type { AdminSession, AdminUser } from "@/types/admin";

import { refreshSiteContent } from "@/services/siteService";
import { useAdminAuthStore } from "@/store/adminAuthStore";

import { api } from "./api";
import { signIn } from "./render";

export function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "ADM1",
    name: "Asha Rao",
    email: "asha@example.com",
    role: "super-admin",
    status: "active",
    permissions: ["products", "orders", "customers", "coupons", "content", "settings", "admins"],
    lastLoginAt: "2026-09-30T10:00:00.000Z",
    createdAt: "2025-01-15T10:00:00.000Z",
    avatarInitials: "AR",
    ...overrides,
  };
}

/**
 * Sign an admin in the way the portal would find them: the token in local
 * storage, the session in the store, and `/admin/auth/me` confirming it (the
 * session hook re-checks once per module load and drops the session if the
 * check fails).
 */
export function signInAdminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  const user = adminUser(overrides);
  signIn("admin", "admin-token");
  const session: AdminSession = { user, token: "admin-token", issuedAt: "2026-10-01T00:00:00.000Z" };
  useAdminAuthStore.setState({ session });
  api.get("/admin/auth/me", user);
  return user;
}

export function siteContent(overrides: Partial<SiteContent> = {}): SiteContent {
  return {
    states: ["Karnataka", "Kerala"],
    contactTopics: [],
    popularSearches: [],
    sortOptions: [],
    ratingFilters: [],
    discountFilters: [],
    deliveryMethods: [],
    paymentMethods: [],
    enabledPaymentMethods: [],
    faqs: [],
    sizeGuide: { intro: "", charts: [] },
    accountNavigation: [],
    adminRoles: [
      { value: "super-admin", label: "Super admin", description: "Everything" },
      { value: "admin", label: "Admin", description: "Most things" },
      { value: "manager", label: "Manager", description: "Orders" },
      { value: "editor", label: "Editor", description: "Catalogue" },
    ],
    stockAdjustmentReasons: [
      { value: "restock", label: "Restock" },
      { value: "correction", label: "Correction" },
      { value: "damage", label: "Damage" },
    ],
    analyticsRanges: [],
    homeSectionKinds: [],
    homeSectionSources: [],
    ...overrides,
  };
}

/** Answer `/site/content` and drop the page cache so this test's answer is the one read. */
export function serveSiteContent(overrides: Partial<SiteContent> = {}): SiteContent {
  const content = siteContent(overrides);
  refreshSiteContent();
  api.get("/site/content", content);
  return content;
}
