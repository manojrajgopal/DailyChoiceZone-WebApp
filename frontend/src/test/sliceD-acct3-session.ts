/**
 * Customer session fixture for slice D / acct3 (account money & engagement views).
 *
 *   signInCustomer()   // token in local storage, session in the store, /auth/me answered
 *
 * `useConfirmedCustomer` re-checks the stored session with `/auth/me` once per
 * module load, so the endpoint is answered on every sign-in: whichever test in
 * a file runs first is the one that triggers the check.
 */
import type { User } from "@/types";

import { useSessionStore } from "@/store/sessionStore";

import { api } from "./api";
import { signIn } from "./render";

export function customerUser(overrides: Partial<User> = {}): User {
  return {
    id: "C1",
    firstName: "Meera",
    lastName: "Iyer",
    email: "meera@example.com",
    phone: "9876543210",
    memberSince: "2025-03-01",
    emailVerified: true,
    ...overrides,
  };
}

export function signInCustomer(overrides: Partial<User> = {}): User {
  const user = customerUser(overrides);
  signIn("customer", "cust-token");
  useSessionStore.setState({ session: { user, token: "cust-token" } });
  api.get("/auth/me", {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    name: `${user.firstName} ${user.lastName}`,
    phone: user.phone,
    status: "active",
    joinedAt: user.memberSince,
    emailVerified: user.emailVerified,
  });
  return user;
}
