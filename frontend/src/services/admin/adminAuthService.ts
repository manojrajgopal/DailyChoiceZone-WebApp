import adminUsersJson from "@/data/admin/admin-users.json";

import type { AdminResult, AdminRole, AdminSession, AdminUser } from "@/types/admin";

import { useAdminAuthStore } from "@/store/adminAuthStore";

/**
 * Mock admin authentication.
 *
 * ## This is not security
 *
 * The credential check below runs **in the browser**, which means the expected
 * password is in the JavaScript bundle and anyone can read it or skip the check
 * entirely by writing a session into local storage by hand. Nothing here keeps
 * an unauthorised person out, and nothing here should ever be relied on to.
 *
 * It exists for one reason: to give the admin portal the *shape* of an
 * authenticated app — a login screen, a session, a signed-in user, a role — so
 * that swapping in a real backend is a change to this file and not a
 * re-architecture of every page.
 *
 * ## What real authentication needs
 *
 * `signIn` becomes `POST /admin/auth/login`, which sets an **httpOnly** cookie
 * the browser cannot read. The route guard moves to middleware or a server
 * component so an unauthenticated request never receives admin HTML at all.
 * Permission checks move to the API, because a check the client performs is a
 * convenience for the UI, never an authorisation boundary.
 *
 * Until then, treat this portal as a local demo and do not deploy it with real
 * customer data behind it.
 */

/**
 * Demo credentials.
 *
 * Deliberately confined to this module so they appear only in the admin bundle
 * and are never referenced from a customer-facing page. They are still
 * readable in built JavaScript — see the warning above.
 */
const DEMO_EMAIL = "admin@dailychoicezone.com";
const DEMO_PASSWORD = "Admin@123";

export const DEMO_CREDENTIALS = { email: DEMO_EMAIL, password: DEMO_PASSWORD };

const USERS = adminUsersJson as AdminUser[];

export interface AdminCredentials {
  email: string;
  password: string;
}

/* ---------------------------------------------------------------- sign in */

export async function signIn(
  credentials: AdminCredentials,
): Promise<AdminResult<AdminSession>> {
  const email = credentials.email.trim().toLowerCase();

  if (!email) return { ok: false, reason: "Enter your email address." };
  if (!credentials.password) return { ok: false, reason: "Enter your password." };

  const user = USERS.find((entry) => entry.email.toLowerCase() === email);

  // One message for both a wrong address and a wrong password — the habit is
  // worth keeping even in a mock, since distinguishing them tells an attacker
  // which accounts exist.
  if (!user || credentials.password !== DEMO_PASSWORD) {
    return { ok: false, reason: "That email and password do not match." };
  }

  if (user.status === "disabled") {
    return { ok: false, reason: "This account has been disabled. Contact a super admin." };
  }

  const session: AdminSession = {
    user: { ...user, lastLoginAt: new Date().toISOString() },
    // Obviously not a credential. A real backend issues an httpOnly cookie.
    token: `mock-admin-session-${user.id}`,
    issuedAt: new Date().toISOString(),
  };

  // The store owns persistence — see `adminAuthStore`. Writing it here as well
  // would put two different shapes under the same key.
  return { ok: true, data: session };
}

/**
 * Sign out.
 *
 * Nothing to revoke in a mock; the store clears the session. Kept as an async
 * function because a real implementation calls `POST /admin/auth/logout` to
 * invalidate the cookie server-side, and callers should already be awaiting it.
 */
export async function signOut(): Promise<void> {
  useAdminAuthStore.getState().signOut();
}

/**
 * The current session, read outside React.
 *
 * Services use this to stamp "who did this" onto a record. Components should
 * use the `useAdminSession` hook instead, so they re-render on change.
 */
export function getSession(): AdminSession | null {
  return useAdminAuthStore.getState().session;
}

/** The acting admin's id, for `updatedBy` fields. */
export function currentActorId(): string {
  return getSession()?.user.id ?? "adm_001";
}

/* ------------------------------------------------------------ permissions */

/**
 * Permission names the UI asks about.
 *
 * A placeholder, not a permission engine. It exists so pages express intent —
 * `can(user, "manage:adminUsers")` rather than `user.role === "super-admin"` —
 * which is the part that would otherwise be scattered everywhere and painful to
 * replace once the backend owns authorisation.
 */
export type Permission =
  | "view:dashboard"
  | "manage:catalogue"
  | "manage:orders"
  | "manage:customers"
  | "manage:marketing"
  | "manage:storefront"
  | "manage:settings"
  | "manage:adminUsers";

const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  "super-admin": [
    "view:dashboard", "manage:catalogue", "manage:orders", "manage:customers",
    "manage:marketing", "manage:storefront", "manage:settings", "manage:adminUsers",
  ],
  admin: [
    "view:dashboard", "manage:catalogue", "manage:orders", "manage:customers",
    "manage:marketing", "manage:storefront", "manage:settings",
  ],
  manager: [
    "view:dashboard", "manage:orders", "manage:customers", "manage:catalogue",
  ],
  editor: ["view:dashboard", "manage:catalogue", "manage:storefront"],
};

/**
 * Whether a role carries a permission.
 *
 * **UI convenience only.** Hiding a button does not protect the action behind
 * it; the API must enforce the same rule once it exists.
 */
export function can(user: AdminUser | null, permission: Permission): boolean {
  if (!user || user.status !== "active") return false;
  return ROLE_PERMISSIONS[user.role]?.includes(permission) ?? false;
}

export function permissionsFor(role: AdminRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
