import type { AdminResult, AdminUser, StoreSettings } from "@/types/admin";

import { countLocalChanges, resetAll } from "@/lib/admin/mock-store";

import { adminDataSource } from "./admin-data-source.instance";

/** Store settings and admin user management. */

export function getSettings(): Promise<StoreSettings> {
  return adminDataSource.getSettings();
}

export async function saveSettings(settings: StoreSettings): Promise<AdminResult<StoreSettings>> {
  if (settings.general.storeName.trim().length < 2) {
    return { ok: false, reason: "Enter a store name." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(settings.contact.email)) {
    return { ok: false, reason: "Enter a valid support email address." };
  }
  if (settings.shipping.freeDeliveryThreshold < 0 || settings.shipping.standardFee < 0) {
    return { ok: false, reason: "Delivery charges cannot be negative." };
  }
  if (settings.tax.enabled && (settings.tax.ratePercent < 0 || settings.tax.ratePercent > 28)) {
    return { ok: false, reason: "Enter a tax rate between 0 and 28 percent." };
  }

  return { ok: true, data: await adminDataSource.saveSettings(settings) };
}

/* ----------------------------------------------------------- admin users */

export const ROLES: { value: AdminUser["role"]; label: string; description: string }[] = [
  { value: "super-admin", label: "Super admin", description: "Full access, including admin users and settings." },
  { value: "admin", label: "Admin", description: "Everything except admin user management." },
  { value: "manager", label: "Manager", description: "Orders, inventory, customers and reviews." },
  { value: "editor", label: "Editor", description: "Catalogue and storefront content only." },
];

export function listAdminUsers(): Promise<AdminUser[]> {
  return adminDataSource.listAdminUsers();
}

export async function saveAdminUser(user: AdminUser): Promise<AdminResult<AdminUser>> {
  if (user.name.trim().length < 2) return { ok: false, reason: "Enter a name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(user.email)) {
    return { ok: false, reason: "Enter a valid email address." };
  }

  const existing = await adminDataSource.listAdminUsers();
  const clash = existing.find(
    (entry) => entry.email.toLowerCase() === user.email.toLowerCase() && entry.id !== user.id,
  );
  if (clash) return { ok: false, reason: `${user.email} already has an account.` };

  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return { ok: true, data: await adminDataSource.saveAdminUser({ ...user, avatarInitials: initials }) };
}

/**
 * Disabling is offered instead of deleting for the last super admin.
 *
 * Removing the only account that can manage accounts would lock everyone out of
 * that capability, which no amount of confirmation dialog makes acceptable.
 */
export async function deleteAdminUser(id: string): Promise<AdminResult<string>> {
  const users = await adminDataSource.listAdminUsers();
  const user = users.find((entry) => entry.id === id);
  if (!user) return { ok: false, reason: "That admin user no longer exists." };

  const superAdmins = users.filter(
    (entry) => entry.role === "super-admin" && entry.status === "active",
  );
  if (user.role === "super-admin" && superAdmins.length <= 1) {
    return { ok: false, reason: "This is the only active super admin. Add another one first." };
  }

  await adminDataSource.deleteAdminUser(id);
  return { ok: true, data: user.name };
}

export async function setAdminUserStatus(
  id: string,
  status: AdminUser["status"],
): Promise<AdminResult<AdminUser>> {
  const users = await adminDataSource.listAdminUsers();
  const user = users.find((entry) => entry.id === id);
  if (!user) return { ok: false, reason: "That admin user no longer exists." };

  if (status === "disabled" && user.role === "super-admin") {
    const active = users.filter(
      (entry) => entry.role === "super-admin" && entry.status === "active",
    );
    if (active.length <= 1) {
      return { ok: false, reason: "This is the only active super admin." };
    }
  }

  return { ok: true, data: await adminDataSource.saveAdminUser({ ...user, status }) };
}

export function emptyAdminUser(): AdminUser {
  return {
    id: `adm_${Date.now()}`,
    name: "",
    email: "",
    role: "editor",
    status: "active",
    lastLoginAt: null,
    createdAt: new Date().toISOString(),
    avatarInitials: "",
  };
}

/* -------------------------------------------------------------- demo data */

/** How many unsaved local changes exist, for the settings page indicator. */
export function localChangeCount(): number {
  return countLocalChanges();
}

/** Throw away every local change and return to the committed demo data. */
export function resetDemoData(): void {
  resetAll();
}
