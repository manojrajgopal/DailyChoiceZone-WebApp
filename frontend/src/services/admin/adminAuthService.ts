import type { AdminResult, AdminRole, AdminSession, AdminUser } from "@/types/admin";

import { ApiError, apiGet, apiPost, setToken } from "@/services/api/client";
import { useAdminAuthStore } from "@/store/adminAuthStore";

/**
 * Admin authentication.
 *
 * The check happens on the server. The password is verified against a bcrypt
 * hash, the token that comes back carries an `actor: "admin"` claim, and every
 * admin endpoint validates it — a customer's token will not do, and neither
 * will a session written into local storage by hand, because the portal's own
 * belief about who is signed in buys nothing from the API.
 *
 * That is the important difference from what this file used to be. The old
 * version compared a password in the browser against a constant in the bundle;
 * it gave the portal the *shape* of an authenticated app and no security at
 * all. What is left here is the shape — a session, a signed-in user, a role —
 * now backed by something real.
 *
 * `can()` below is still only a UI convenience: it decides which buttons to
 * draw. The boundary is `require_permission` in the backend, which checks the
 * same vocabulary on every write.
 */

const AUTH = { auth: "admin" } as const;

/** Demo credentials for the seeded portal. Shown on the sign-in screen. */
export const DEMO_CREDENTIALS = {
  email: "admin@dailychoicezone.com",
  password: "Admin@123",
};

export interface AdminCredentials {
  email: string;
  password: string;
}

/** What `/admin/auth/login` returns. */
interface ApiAdminUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  status: AdminUser["status"];
  permissions: string[];
  lastLoginAt: string | null;
  createdAt: string;
  avatarInitials: string;
}

interface ApiAdminAuthPayload {
  token: { accessToken: string; tokenType: string; expiresIn: number };
  admin: ApiAdminUser;
}

function toUser(payload: ApiAdminUser): AdminUser {
  return {
    id: payload.id,
    name: payload.name,
    email: payload.email,
    role: payload.role,
    status: payload.status,
    permissions: payload.permissions,
    lastLoginAt: payload.lastLoginAt,
    createdAt: payload.createdAt,
    avatarInitials: payload.avatarInitials,
  };
}

/* ---------------------------------------------------------------- sign in */

export async function signIn(
  credentials: AdminCredentials,
): Promise<AdminResult<AdminSession>> {
  const email = credentials.email.trim().toLowerCase();

  if (!email) return { ok: false, reason: "Enter your email address." };
  if (!credentials.password) return { ok: false, reason: "Enter your password." };

  try {
    const payload = await apiPost<ApiAdminAuthPayload>("/admin/auth/login", {
      email,
      password: credentials.password,
    });

    setToken(payload.token.accessToken, "admin");

    return {
      ok: true,
      data: {
        user: toUser(payload.admin),
        token: payload.token.accessToken,
        issuedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    // The API gives one message for a wrong address and a wrong password, and
    // it is already written to be read — pass it through rather than inventing
    // a second vocabulary for the same failures.
    if (error instanceof ApiError) return { ok: false, reason: error.message };
    return { ok: false, reason: "Something went wrong. Please try again." };
  }
}

/**
 * Sign out.
 *
 * Told to the server as well as forgotten locally. There is nothing to revoke
 * today — a JWT is valid until it expires — but this is where a denylist would
 * hook in, and the local clear happens either way.
 */
export async function signOut(): Promise<void> {
  try {
    await apiPost("/admin/auth/logout", {}, AUTH);
  } catch {
    /* signing out has to succeed even when the request does not */
  }
  setToken(null, "admin");
  useAdminAuthStore.getState().signOut();
}

/**
 * Re-read the signed-in administrator from the server.
 *
 * A persisted session says who *was* signed in. This says whether that is
 * still true — the account may since have been disabled, its role changed, or
 * the token expired. The guard calls it on mount.
 */
export async function refreshSession(): Promise<AdminUser | null> {
  try {
    return toUser(await apiGet<ApiAdminUser>("/admin/auth/me", AUTH));
  } catch {
    return null;
  }
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
  return getSession()?.user.id ?? "";
}

/* ------------------------------------------------------------ permissions */

/**
 * Permission names the UI asks about.
 *
 * Pages express intent — `can(user, "manage:adminUsers")` rather than
 * `user.role === "super-admin"` — so the rule lives in one place instead of
 * being scattered through every view.
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

/**
 * The portal's names, in the backend's vocabulary.
 *
 * Two vocabularies because they answer different questions: the UI asks about
 * a screen ("may I show the storefront editor?"), the API about a resource
 * ("may you write content?"). `null` means every active administrator has it.
 */
const SERVER_PERMISSION: Record<Permission, string | null> = {
  "view:dashboard": null,
  "manage:catalogue": "products",
  "manage:orders": "orders",
  "manage:customers": "customers",
  "manage:marketing": "coupons",
  "manage:storefront": "content",
  "manage:settings": "settings",
  "manage:adminUsers": "admins",
};

/**
 * What each role may do, when the server has not said.
 *
 * Only reached for a user assembled locally — a row in the admin-users table
 * that was listed rather than signed in as. A signed-in user always carries
 * the server's own list.
 */
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
 * Whether a user carries a permission.
 *
 * **UI convenience only.** Hiding a button does not protect the action behind
 * it — the API enforces the same rule on every write, and that is the boundary.
 */
export function can(user: AdminUser | null, permission: Permission): boolean {
  if (!user || user.status !== "active") return false;

  // A super admin is not enumerated in every list; the role carries it, the
  // same way the backend's `require_permission` treats it.
  if (user.role === "super-admin") return true;

  if (user.permissions) {
    const key = SERVER_PERMISSION[permission];
    return key === null || user.permissions.includes(key);
  }

  return ROLE_PERMISSIONS[user.role]?.includes(permission) ?? false;
}

export function permissionsFor(role: AdminRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
