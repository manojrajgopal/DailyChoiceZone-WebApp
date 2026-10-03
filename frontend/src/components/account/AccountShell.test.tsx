import { beforeEach, describe, expect, it } from "vitest";

import { api, fail, networkError } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { fresh, siteContent, storeSession, stores, toastMessages } from "@/test/sliceD-acct1-fixtures";

async function load() {
  return (await import("./AccountShell")).AccountShell;
}

async function renderShell(props: { title?: string; description?: string; breadcrumb?: { label: string; href?: string }[] } = {}) {
  const AccountShell = await load();
  return renderUI(
    <AccountShell title={props.title ?? "Your profile"} description={props.description} breadcrumb={props.breadcrumb}>
      <p>Page body</p>
    </AccountShell>,
  );
}

function navLinks() {
  const nav = screen.getByRole("navigation", { name: "Account" });
  return within(nav).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]);
}

describe("AccountShell", () => {
  beforeEach(() => {
    fresh();
    api.get("/site/content", siteContent());
  });

  describe("signed out", () => {
    it("replaces the page with the sign-in panel and hides the content", async () => {
      await renderShell();
      expect(screen.getByRole("heading", { name: "Your account" })).toBeInTheDocument();
      expect(screen.getByText(/Sign in to track orders/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign in", pressed: true })).toBeInTheDocument();
      expect(screen.queryByText("Page body")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Your profile" })).not.toBeInTheDocument();
      // A guest has nothing to confirm with the server.
      expect(api.requests("GET", "/auth/me")).toHaveLength(0);
    });
  });

  describe("signed in", () => {
    it("shows the title, description, customer card and the page content", async () => {
      storeSession();
      await renderShell({ description: "Everything in one place." });
      expect(screen.getByRole("heading", { name: "Your profile" })).toBeInTheDocument();
      expect(screen.getByText("Everything in one place.")).toBeInTheDocument();
      expect(screen.getByText("Asha Rao")).toBeInTheDocument();
      expect(screen.getByText("asha@example.com")).toBeInTheDocument();
      expect(screen.getByText("Member since 15 Jan 2025")).toBeInTheDocument();
      expect(screen.getByText("Page body")).toBeInTheDocument();
    });

    it("omits the description paragraph when none is given", async () => {
      storeSession();
      const { container } = await renderShell();
      expect(container.querySelector("h1 + p")).toBeNull();
    });

    it("confirms the stored token with the server once, sending it as a bearer token", async () => {
      storeSession();
      await renderShell();
      await waitFor(() => expect(api.requests("GET", "/auth/me")).toHaveLength(1));
      expect(api.last("GET", "/auth/me")!.headers.authorization).toBe("Bearer test-token");
    });

    it("builds the menu from site content, remaps /wishlist and adds the newer pages after their neighbours", async () => {
      storeSession();
      await renderShell();
      await waitFor(() => expect(screen.getByRole("link", { name: "Profile" })).toBeInTheDocument());
      expect(navLinks()).toEqual([
        ["Profile", "/account"],
        ["Orders", "/account/orders"],
        ["Support requests", "/account/support"],
        ["Addresses", "/account/addresses"],
        ["Wishlist", "/account/wishlist"],
        ["Recently viewed", "/account/recently-viewed"],
        ["Saved for later", "/account/saved-for-later"],
        ["Stock & price alerts", "/account/alerts"],
        ["Membership", "/account/membership"],
        ["Reward points", "/account/rewards"],
        ["Gift cards & credit", "/account/wallet"],
        ["Refer a friend", "/account/referrals"],
        ["Settings", "/account/settings"],
      ]);
    });

    it("does not duplicate entries the store already lists, and appends ones whose neighbour is missing", async () => {
      api.get(
        "/site/content",
        siteContent({
          accountNavigation: [
            { href: "/account", label: "Profile", icon: "user" },
            { href: "/account/support", label: "Help", icon: "life-buoy" },
            { href: "/account/custom", label: "Custom", icon: "not-an-icon" },
          ],
        }),
      );
      storeSession();
      await renderShell();
      await waitFor(() => expect(screen.getByRole("link", { name: "Profile" })).toBeInTheDocument());
      const links = navLinks();
      expect(links.filter(([, href]) => href === "/account/support")).toEqual([["Help", "/account/support"]]);
      // Each added entry anchors on its original neighbour; when that
      // neighbour isn't in this store's (older) menu, it falls back to
      // appending at the current end, in ADDED_ENTRIES order — so alerts
      // (anchored on the absent /account/wishlist) ends up after referrals,
      // which anchors on /account/wallet and is processed later.
      expect(links.map(([, href]) => href)).toEqual([
        "/account",
        "/account/support",
        "/account/custom",
        "/account/membership",
        "/account/rewards",
        "/account/wallet",
        "/account/referrals",
        "/account/alerts",
        "/account/saved-for-later",
        "/account/recently-viewed",
      ]);
    });

    it("shows only Sign out in the menu while site content is unavailable", async () => {
      api.get("/site/content", fail(500));
      storeSession();
      await renderShell();
      await waitFor(() => expect(api.requests("GET", "/site/content")).toHaveLength(1));
      expect(within(screen.getByRole("navigation", { name: "Account" })).queryAllByRole("link")).toHaveLength(0);
      expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    });

    it.each([
      ["/account/orders", "Orders"],
      ["/account/ticket", "Support requests"],
    ])("marks the current page (%s) in the menu", async (path, label) => {
      setLocation(path);
      storeSession();
      await renderShell();
      const link = await screen.findByRole("link", { name: label });
      expect(link).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("link", { name: "Profile" })).not.toHaveAttribute("aria-current");
    });

    it("uses a plain Account crumb without extra crumbs, and links it when there are some", async () => {
      storeSession();
      const AccountShell = await load();
      const { rerender } = renderUI(<AccountShell title="Orders"><p /></AccountShell>);
      const crumbs = () => within(screen.getByRole("navigation", { name: "Breadcrumb" }));
      expect(crumbs().getByText("Account")).toHaveAttribute("aria-current", "page");
      expect(crumbs().getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");

      rerender(
        <AccountShell title="Order" breadcrumb={[{ label: "Orders", href: "/account/orders" }, { label: "DCZ-1" }]}>
          <p />
        </AccountShell>,
      );
      expect(crumbs().getByRole("link", { name: "Account" })).toHaveAttribute("href", "/account");
      expect(crumbs().getByRole("link", { name: "Orders" })).toHaveAttribute("href", "/account/orders");
      expect(crumbs().getByText("DCZ-1")).toHaveAttribute("aria-current", "page");
    });

    it("shows the confirm-your-email banner only for an unverified address", async () => {
      storeSession({ emailVerified: false });
      await renderShell();
      expect(screen.getByText("Please confirm your email address.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send the link again" })).toBeInTheDocument();
    });

    it("hides the banner for a verified address", async () => {
      storeSession();
      await renderShell();
      expect(screen.queryByText("Please confirm your email address.")).not.toBeInTheDocument();
    });
  });

  describe("signing out", () => {
    it("tells the server, forgets the token and session, and shows the sign-in panel", async () => {
      storeSession();
      api.post("/auth/logout", null);
      const { user } = await renderShell();
      const { useSessionStore } = await stores();
      await waitFor(() => expect(api.requests("GET", "/auth/me")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Sign out" }));

      expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
      const logout = api.last("POST", "/auth/logout")!;
      expect(logout.headers.authorization).toBe("Bearer test-token");
      expect(window.localStorage.getItem("dcz:auth-token")).toBeNull();
      expect(useSessionStore.getState().session).toBeNull();
      expect(await toastMessages()).toContain("info: Signed out");
    });

    it("still signs out locally when the server can't be reached", async () => {
      storeSession();
      api.post("/auth/logout", networkError());
      const { user } = await renderShell();
      await user.click(screen.getByRole("button", { name: "Sign out" }));
      expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
      expect(window.localStorage.getItem("dcz:auth-token")).toBeNull();
    });
  });

  describe("session expiry", () => {
    it.each([
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
    ])("drops an expired session (%i from /auth/me) and clears the token", async (status, code) => {
      storeSession({}, { me: false });
      api.get("/auth/me", fail(status, "Session expired", code));
      await renderShell();
      expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
      expect(screen.queryByText("Page body")).not.toBeInTheDocument();
      expect(window.localStorage.getItem("dcz:auth-token")).toBeNull();
    });

    it("drops the session but keeps the token when /auth/me fails for another reason", async () => {
      storeSession({}, { me: false });
      api.get("/auth/me", fail(500));
      await renderShell();
      expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
      expect(window.localStorage.getItem("dcz:auth-token")).toBe("test-token");
    });

    it("refreshes the stored profile with what the server says", async () => {
      storeSession({}, { me: false });
      api.get("/auth/me", {
        id: "C1", email: "asha.new@example.com", firstName: "Asha", lastName: "Menon", name: "Asha Menon",
        phone: "", status: "active", joinedAt: "2025-01-15",
      });
      await renderShell();
      expect(await screen.findByText("Asha Menon")).toBeInTheDocument();
      // emailVerified missing from the API counts as not verified, so the
      // address appears twice: the sidebar card and the verify-email banner.
      expect(screen.getAllByText("asha.new@example.com")).toHaveLength(2);
      expect(screen.getByText("Please confirm your email address.")).toBeInTheDocument();
    });
  });
});
