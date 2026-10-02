/**
 * Fixtures for the account-area tests (sliceD / acct1).
 *
 * Several account modules keep page-lifetime state at module scope — the
 * "session already confirmed" flag in `useSession`, the wishlist sync in
 * `useWishlist`, the site-content cache. `fresh()` drops the module registry so
 * each test starts as a fresh page load; app modules must then be imported
 * dynamically (after it), while test helpers stay statically imported.
 */
import { vi } from "vitest";

import type { Address, AuthSession, Product, User } from "@/types";

import { api } from "./api";

export const USER: User = {
  id: "C1",
  firstName: "Asha",
  lastName: "Rao",
  email: "asha@example.com",
  phone: "9876543210",
  memberSince: "2025-01-15",
  emailVerified: true,
};

/** What `/auth/me`, `/auth/login` and `/auth/register` send for a customer. */
export function apiCustomer(user: Partial<User> = {}) {
  const merged = { ...USER, ...user };
  return {
    id: merged.id,
    email: merged.email,
    firstName: merged.firstName,
    lastName: merged.lastName,
    name: `${merged.firstName} ${merged.lastName}`,
    phone: merged.phone,
    status: "active",
    joinedAt: merged.memberSince,
    emailVerified: merged.emailVerified,
  };
}

export function authPayload(user: Partial<User> = {}, token = "new-token") {
  return { token: { accessToken: token, tokenType: "bearer", expiresIn: 3600 }, customer: apiCustomer(user) };
}

export function session(user: Partial<User> = {}): AuthSession {
  return { user: { ...USER, ...user }, token: "test-token" };
}

/**
 * Store a signed-in customer the way the app does (token + persisted session),
 * so a store created afterwards hydrates with it. Also answers `/auth/me`
 * with the same customer, unless `me` is false.
 */
export function storeSession(user: Partial<User> = {}, { me = true } = {}) {
  window.localStorage.setItem("dcz:auth-token", "test-token");
  window.localStorage.setItem("dcz:session", JSON.stringify({ state: { session: session(user) }, version: 1 }));
  if (me) api.get("/auth/me", apiCustomer(user));
}

/** A new module registry: the next dynamic import behaves like a fresh page load. */
export function fresh() {
  vi.resetModules();
}

export async function stores() {
  const [{ useSessionStore }, { useToastStore }] = await Promise.all([
    import("@/store/sessionStore"),
    import("@/store/toastStore"),
  ]);
  return { useSessionStore, useToastStore };
}

/** The messages of every toast shown so far, from the store this module graph uses. */
export async function toastMessages() {
  const { useToastStore } = await import("@/store/toastStore");
  return useToastStore.getState().toasts.map((t) => `${t.tone}: ${t.message}`);
}

export function address(overrides: Partial<Address> = {}): Address {
  return {
    id: "A1",
    fullName: "Asha Rao",
    phone: "9876543210",
    line1: "12 MG Road",
    line2: "Near Metro",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560001",
    type: "home",
    isDefault: true,
    ...overrides,
  };
}

export function product(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    slug: `product-${id}`,
    name: `Product ${id}`,
    brand: "DCZ",
    category: "women",
    subcategory: "shirts",
    price: 999,
    originalPrice: 1299,
    discount: 23,
    currency: "INR",
    rating: 4.2,
    reviewCount: 10,
    images: [`/img/${id}.jpg`],
    colors: [],
    sizes: [],
    description: "",
    ...overrides,
  } as unknown as Product;
}

/** Site content with only what the account screens read. */
export function siteContent(overrides: Record<string, unknown> = {}) {
  return {
    states: ["Karnataka", "Kerala", "Tamil Nadu"],
    accountNavigation: [
      { href: "/account", label: "Profile", icon: "user" },
      { href: "/account/orders", label: "Orders", icon: "package" },
      { href: "/account/addresses", label: "Addresses", icon: "map-pin" },
      { href: "/wishlist", label: "Wishlist", icon: "heart" },
      { href: "/account/settings", label: "Settings", icon: "settings" },
    ],
    deliveryMethods: [],
    paymentMethods: [],
    analyticsRanges: [],
    homeSectionKinds: [],
    ...overrides,
  };
}
