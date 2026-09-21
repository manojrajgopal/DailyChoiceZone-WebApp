import type { AuthSession, Credentials, RegisterInput, User } from "@/types";

import { STORAGE_KEYS, readJson, remove, writeJson } from "@/lib/storage/local-storage";

/**
 * Mock authentication.
 *
 * There is no auth backend, so this accepts any well-formed email with a
 * password of at least six characters and mints a local session. It exists to
 * give the account area a real shape, not to provide security.
 *
 *   signIn   →  POST /auth/login
 *   register →  POST /auth/register
 *   signOut  →  POST /auth/logout
 *
 * IMPORTANT: passwords are never stored — not hashed, not in local storage,
 * not anywhere. Only the resulting session is kept. When a real backend
 * arrives it should set an httpOnly cookie rather than handing a token to JS.
 */

export type AuthResult =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function nameFromEmail(email: string): { firstName: string; lastName: string } {
  const local = email.split("@")[0] ?? "there";
  const parts = local.split(/[._-]+/).filter(Boolean);
  const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  return {
    firstName: capitalise(parts[0] ?? "There"),
    lastName: parts[1] ? capitalise(parts[1]) : "",
  };
}

function buildSession(user: User): AuthSession {
  // Deliberately opaque and obviously not a credential.
  return { user, token: `mock-session-${user.id}` };
}

function persist(session: AuthSession): AuthSession {
  writeJson(STORAGE_KEYS.session, session);
  return session;
}

export async function signIn({ email, password }: Credentials): Promise<AuthResult> {
  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, reason: "Enter a valid email address." };
  }
  if (password.length < 6) {
    return { ok: false, reason: "Password must be at least 6 characters." };
  }

  const { firstName, lastName } = nameFromEmail(email);
  const user: User = {
    id: `usr_${Math.abs(hashCode(email)).toString(36)}`,
    firstName,
    lastName,
    email: email.toLowerCase(),
    phone: "",
    memberSince: new Date().toISOString().slice(0, 10),
  };

  return { ok: true, session: persist(buildSession(user)) };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  if (!input.firstName.trim()) return { ok: false, reason: "Enter your first name." };
  if (!EMAIL_PATTERN.test(input.email)) {
    return { ok: false, reason: "Enter a valid email address." };
  }
  if (input.password.length < 6) {
    return { ok: false, reason: "Password must be at least 6 characters." };
  }

  const user: User = {
    id: `usr_${Math.abs(hashCode(input.email)).toString(36)}`,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    email: input.email.toLowerCase(),
    phone: "",
    memberSince: new Date().toISOString().slice(0, 10),
  };

  return { ok: true, session: persist(buildSession(user)) };
}

export async function signOut(): Promise<void> {
  remove(STORAGE_KEYS.session);
}

/** The current session, or `null`. Reads local storage; safe on the server. */
export function getSession(): AuthSession | null {
  return readJson<AuthSession | null>(STORAGE_KEYS.session, null);
}

export function updateProfile(patch: Partial<User>): AuthSession | null {
  const session = getSession();
  if (!session) return null;
  const updated: AuthSession = { ...session, user: { ...session.user, ...patch } };
  return persist(updated);
}

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
