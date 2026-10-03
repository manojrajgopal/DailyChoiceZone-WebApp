import { afterEach, describe, expect, it } from "vitest";

import { stopSessionRefresh } from "@/services/sessionRefresh";
import { useSessionStore } from "@/store/sessionStore";
import { api, fail } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";
import { authPayload, toastMessages } from "@/test/sliceD-acct1-fixtures";

import { OAUTH_ERRORS } from "./auth/messages";
import { AuthCompleteView } from "./AuthCompleteView";

afterEach(() => stopSessionRefresh());

describe("AuthCompleteView", () => {
  describe("?code= — signing in", () => {
    it("exchanges the code once, signs in and goes on to next", async () => {
      setLocation("/auth/complete?code=handoff-1&next=%2Fcheckout%2Fpayment");
      api.post("/auth/oauth/complete", { ...authPayload({ firstName: "Asha" }, "oauth-token"), created: false });
      renderUI(<AuthCompleteView />);
      expect(screen.getByRole("status")).toHaveTextContent("Signing you in…");

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/checkout/payment"));
      expect(api.requests("POST", "/auth/oauth/complete")).toHaveLength(1);
      expect(api.last("POST", "/auth/oauth/complete")!.body).toEqual({ code: "handoff-1" });
      expect(localStorage.getItem("dcz:auth-token")).toBe("oauth-token");
      expect(useSessionStore.getState().session?.user.firstName).toBe("Asha");
      expect(await toastMessages()).toContain("success: Welcome back, Asha");
    });

    it("welcomes a brand-new customer", async () => {
      setLocation("/auth/complete?code=handoff-2");
      api.post("/auth/oauth/complete", { ...authPayload({ firstName: "Neel" }), created: true });
      renderUI(<AuthCompleteView />);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/account"));
      expect(await toastMessages()).toContain("success: Welcome to Daily Choice Zone, Neel");
    });

    it.each([
      ["https%3A%2F%2Fevil.example%2Fsteal"],
      ["%2F%2Fevil.example"],
      ["%2F%5Cevil.example"],
      ["javascript%3Aalert(1)"],
    ])("lands on /account instead of an unsafe next (%s)", async (next) => {
      setLocation(`/auth/complete?code=handoff-3&next=${next}`);
      api.post("/auth/oauth/complete", authPayload());
      renderUI(<AuthCompleteView />);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/account"));
    });

    it("explains a code that no longer works, and links back to sign in", async () => {
      setLocation("/auth/complete?code=used&next=%2Fcheckout");
      api.post("/auth/oauth/complete", fail(401, "That sign-in link has expired. Please try again.", "OAUTH_CODE_INVALID"));
      renderUI(<AuthCompleteView />);
      expect(await screen.findByRole("alert")).toHaveTextContent("That sign-in link has expired. Please try again.");
      expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/account");
      expect(router.replace).not.toHaveBeenCalled();
      expect(localStorage.getItem("dcz:auth-token")).toBeNull();
    });
  });

  describe("?linked= — an account was connected", () => {
    it("says so and returns to Settings", async () => {
      setLocation("/auth/complete?linked=google&next=%2Faccount%2Fsettings");
      renderUI(<AuthCompleteView />);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/account/settings"));
      expect(await toastMessages()).toContain("success: Google is now connected to your account");
      expect(api.calls).toHaveLength(0);
    });

    it("never follows an unsafe next", async () => {
      setLocation("/auth/complete?linked=microsoft&next=%2F%2Fevil.example");
      renderUI(<AuthCompleteView />);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/account/settings"));
    });
  });

  describe("?error= — it didn't work", () => {
    it("explains account_exists in words, with the way forward", () => {
      setLocation("/auth/complete?error=account_exists");
      renderUI(<AuthCompleteView />);
      expect(screen.getByRole("heading", { name: "We couldn't sign you in" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "An account with this email already exists. Sign in with your password or a code first, then connect it from Settings → Security",
      );
      expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/account");
      expect(api.calls).toHaveLength(0);
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("points a failed connection back at Settings", () => {
      setLocation("/auth/complete?error=identity_in_use&mode=link");
      renderUI(<AuthCompleteView />);
      expect(screen.getByRole("heading", { name: "We couldn't connect that account" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(OAUTH_ERRORS.identity_in_use!);
      expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/account/settings");
    });

    it.each(Object.keys(OAUTH_ERRORS))("has words for %s", (code) => {
      setLocation(`/auth/complete?error=${code}`);
      renderUI(<AuthCompleteView />);
      expect(screen.getByRole("alert")).toHaveTextContent(OAUTH_ERRORS[code]!);
      // Never the raw snake_case code ("cancelled" is a word in its own message).
      if (code.includes("_")) expect(screen.getByRole("alert")).not.toHaveTextContent(code);
    });

    it("falls back to a general message for an unknown code", () => {
      setLocation("/auth/complete?error=something_new");
      renderUI(<AuthCompleteView />);
      expect(screen.getByRole("alert")).toHaveTextContent(OAUTH_ERRORS.failed!);
    });
  });

  it("says the link is incomplete when it carries nothing", () => {
    setLocation("/auth/complete");
    renderUI(<AuthCompleteView />);
    expect(screen.getByRole("alert")).toHaveTextContent("This sign-in link is incomplete.");
  });
});
