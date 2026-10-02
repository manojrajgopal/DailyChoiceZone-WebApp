import { describe, expect, it } from "vitest";

import type { AuthSession } from "@/types";

import { useSessionStore } from "./sessionStore";

const KEY = "dcz:session";
const SESSION: AuthSession = {
  token: "tok",
  user: { id: "U1", firstName: "Asha", lastName: "Rao", email: "asha@example.com", phone: "1", memberSince: "2025-01-01" },
};
const session = () => useSessionStore.getState();

describe("useSessionStore", () => {
  it("starts signed out", () => {
    expect(session().session).toBeNull();
  });

  it("sets and signs out a session", () => {
    session().setSession(SESSION);
    expect(session().session).toEqual(SESSION);
    session().signOut();
    expect(session().session).toBeNull();
  });

  it("patches the user, keeping the token and other fields", () => {
    session().setSession(SESSION);
    session().updateUser({ firstName: "Ash", emailVerified: true });
    expect(session().session).toEqual({ token: "tok", user: { ...SESSION.user, firstName: "Ash", emailVerified: true } });
  });

  it("does nothing when patching while signed out", () => {
    session().updateUser({ firstName: "Ghost" });
    expect(session().session).toBeNull();
  });

  it("persists only the session and rehydrates it", async () => {
    session().setSession(SESSION);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ state: { session: SESSION }, version: 1 });
    session().signOut();
    localStorage.setItem(KEY, JSON.stringify({ state: { session: SESSION }, version: 1 }));
    await useSessionStore.persist.rehydrate();
    expect(session().session).toEqual(SESSION);
  });

  it("ignores corrupt stored data", async () => {
    localStorage.setItem(KEY, "garbage");
    await useSessionStore.persist.rehydrate();
    expect(session().session).toBeNull();
  });
});
