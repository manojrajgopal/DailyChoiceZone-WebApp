import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { setLocation, router } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";
import { authPayload, toastMessages } from "@/test/sliceD-acct1-fixtures";

import { AuthPanel } from "./AuthPanel";

/**
 * The submit button's accessible name ("Sign in" / "Create account") always
 * collides with the mode tab above it, which has the same name — so the only
 * unambiguous way to reach it is by its `type="submit"`.
 */
function submitButton(): HTMLButtonElement {
  return document.querySelector('form button[type="submit"]') as HTMLButtonElement;
}

describe("AuthPanel", () => {
  describe("mode switching", () => {
    it("starts on Sign in, with no name/referral/offers fields", () => {
      renderUI(<AuthPanel />);
      expect(screen.getByRole("button", { name: "Sign in", pressed: true })).toBeInTheDocument();
      expect(screen.queryByLabelText(/^First name/)).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Forgot your password?" })).toBeInTheDocument();
    });

    it("switches to Create account and shows its extra fields", async () => {
      const { user } = renderUI(<AuthPanel />);
      await user.click(screen.getByRole("button", { name: "Create account" }));
      expect(screen.getByRole("button", { name: "Create account", pressed: true })).toBeInTheDocument();
      expect(screen.getByLabelText(/^First name/)).toBeRequired();
      expect(screen.getByLabelText(/^Last name/)).not.toBeRequired();
      expect(screen.getByText("At least eight characters, with a letter and a number.")).toBeInTheDocument();
      expect(screen.getByLabelText(/Referral code/)).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: /Email me about offers/ })).toBeChecked();
      expect(screen.queryByRole("link", { name: "Forgot your password?" })).not.toBeInTheDocument();
    });

    it("requires email and password in both modes", () => {
      renderUI(<AuthPanel />);
      expect(screen.getByLabelText(/^Email address/)).toBeRequired();
      expect(screen.getByLabelText(/^Password/)).toBeRequired();
    });
  });

  describe("sign in", () => {
    it("signs in, stores the token, and greets the shopper by name", async () => {
      api.post("/auth/login", authPayload({ firstName: "Asha" }));
      const { user } = renderUI(<AuthPanel />);
      await user.type(screen.getByLabelText(/^Email address/), "asha@example.com");
      await user.type(screen.getByLabelText(/^Password/), "hunter2");
      await user.click(submitButton());

      await waitFor(() => expect(localStorage.getItem("dcz:auth-token")).toBe("new-token"));
      expect(api.last("POST", "/auth/login")!.body).toEqual({ email: "asha@example.com", password: "hunter2" });
      expect(await toastMessages()).toContain("success: Welcome back, Asha");
    });

    it("shows 'Please wait…' and disables the button while submitting", async () => {
      api.post("/auth/login", () => new Promise(() => undefined));
      const { user } = renderUI(<AuthPanel />);
      await user.type(screen.getByLabelText(/^Email address/), "asha@example.com");
      await user.type(screen.getByLabelText(/^Password/), "hunter2");
      await user.click(submitButton());
      expect(screen.getByRole("button", { name: "Please wait…" })).toBeDisabled();
    });

    it("reports invalid credentials without storing a token, and lets the shopper retry", async () => {
      api.post("/auth/login", fail(401, "That email and password do not match.", "UNAUTHORIZED"));
      const { user } = renderUI(<AuthPanel />);
      await user.type(screen.getByLabelText(/^Email address/), "asha@example.com");
      await user.type(screen.getByLabelText(/^Password/), "wrong");
      await user.click(submitButton());

      expect(await toastMessages()).toContain("error: That email and password do not match.");
      expect(localStorage.getItem("dcz:auth-token")).toBeNull();
      await waitFor(() => expect(submitButton()).toBeEnabled());
    });

    it("includes the typed email in the forgot-password link", async () => {
      const { user } = renderUI(<AuthPanel />);
      await user.type(screen.getByLabelText(/^Email address/), "asha@example.com");
      expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute(
        "href",
        "/forgot-password?email=asha%40example.com",
      );
    });

    it("links to a bare forgot-password page when no email is typed", () => {
      renderUI(<AuthPanel />);
      expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/forgot-password");
    });
  });

  describe("register", () => {
    it("registers, forgets any remembered referral code, and greets with 'Account created'", async () => {
      localStorage.setItem("dcz:referral-code", "FRIEND1");
      api.post("/auth/register", authPayload({ firstName: "Priya" }));
      const { user } = renderUI(<AuthPanel />);
      await user.click(screen.getByRole("button", { name: "Create account" }));
      await user.type(screen.getByLabelText(/^First name/), "Priya");
      await user.type(screen.getByLabelText(/^Email address/), "priya@example.com");
      await user.type(screen.getByLabelText(/^Password/), "hunter22");
      await user.click(submitButton());

      await waitFor(() => expect(localStorage.getItem("dcz:auth-token")).toBe("new-token"));
      expect(api.last("POST", "/auth/register")!.body).toMatchObject({
        firstName: "Priya",
        email: "priya@example.com",
        password: "hunter22",
        referralCode: "FRIEND1",
        marketingOptIn: true,
      });
      expect(localStorage.getItem("dcz:referral-code")).toBeNull();
      expect(await toastMessages()).toContain("success: Account created");
    });

    it("sends no referralCode when the field is empty", async () => {
      api.post("/auth/register", authPayload());
      const { user } = renderUI(<AuthPanel />);
      await user.click(screen.getByRole("button", { name: "Create account" }));
      await user.type(screen.getByLabelText(/^First name/), "Priya");
      await user.type(screen.getByLabelText(/^Email address/), "priya@example.com");
      await user.type(screen.getByLabelText(/^Password/), "hunter22");
      await user.click(submitButton());
      await waitFor(() => expect(api.last("POST", "/auth/register")).toBeTruthy());
      expect(api.last("POST", "/auth/register")!.body.referralCode).toBeUndefined();
    });

    it("unchecking the offers checkbox sends marketingOptIn: false", async () => {
      api.post("/auth/register", authPayload());
      const { user } = renderUI(<AuthPanel />);
      await user.click(screen.getByRole("button", { name: "Create account" }));
      await user.type(screen.getByLabelText(/^First name/), "Priya");
      await user.type(screen.getByLabelText(/^Email address/), "priya@example.com");
      await user.type(screen.getByLabelText(/^Password/), "hunter22");
      await user.click(screen.getByRole("checkbox", { name: /Email me about offers/ }));
      await user.click(submitButton());
      await waitFor(() => expect(api.last("POST", "/auth/register")!.body.marketingOptIn).toBe(false));
    });

    it("reports a failed registration by toast, keeping the token unset", async () => {
      api.post("/auth/register", fail(409, "That email is already registered.", "CONFLICT"));
      const { user } = renderUI(<AuthPanel />);
      await user.click(screen.getByRole("button", { name: "Create account" }));
      await user.type(screen.getByLabelText(/^First name/), "Priya");
      await user.type(screen.getByLabelText(/^Email address/), "priya@example.com");
      await user.type(screen.getByLabelText(/^Password/), "hunter22");
      await user.click(submitButton());
      expect(await toastMessages()).toContain("error: That email is already registered.");
      expect(localStorage.getItem("dcz:auth-token")).toBeNull();
    });
  });

  describe("arriving from a referral link", () => {
    it("opens on Create account with the code pre-filled and remembers it", async () => {
      setLocation("/account?ref=friend1");
      renderUI(<AuthPanel />);
      expect(screen.getByRole("button", { name: "Create account", pressed: true })).toBeInTheDocument();
      expect(screen.getByLabelText(/Referral code/)).toHaveValue("FRIEND1");
      expect(localStorage.getItem("dcz:referral-code")).toBe("FRIEND1");
    });

    it("fills a previously-remembered code when there is no ?ref= this time", async () => {
      localStorage.setItem("dcz:referral-code", "OLDCODE");
      const { user } = renderUI(<AuthPanel />);
      // Still opens on sign-in (no ?ref=); switching over shows the remembered code.
      expect(screen.getByRole("button", { name: "Sign in", pressed: true })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Create account" }));
      expect(await screen.findByLabelText(/Referral code/)).toHaveValue("OLDCODE");
    });
  });

  describe("returning to checkout", () => {
    it("shows the checkout banner and returns there after signing in", async () => {
      setLocation("/account?next=%2Fcheckout%2Fpayment");
      api.post("/auth/login", authPayload());
      const { user } = renderUI(<AuthPanel />);
      expect(screen.getByText("Sign in to check out.")).toBeInTheDocument();
      await user.type(screen.getByLabelText(/^Email address/), "a@b.com");
      await user.type(screen.getByLabelText(/^Password/), "hunter2");
      await user.click(submitButton());
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/checkout/payment"));
    });

    it("falls back to /account for an unsafe next, rather than leaving it open", async () => {
      setLocation("/account?next=https%3A%2F%2Fevil.example");
      api.post("/auth/login", authPayload());
      const { user } = renderUI(<AuthPanel />);
      expect(screen.queryByText("Sign in to check out.")).not.toBeInTheDocument();
      await user.type(screen.getByLabelText(/^Email address/), "a@b.com");
      await user.type(screen.getByLabelText(/^Password/), "hunter2");
      await user.click(submitButton());
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/account"));
    });

    it("does not redirect at all when there is no next", async () => {
      api.post("/auth/login", authPayload());
      const { user } = renderUI(<AuthPanel />);
      await user.type(screen.getByLabelText(/^Email address/), "a@b.com");
      await user.type(screen.getByLabelText(/^Password/), "hunter2");
      await user.click(submitButton());
      await waitFor(() => expect(localStorage.getItem("dcz:auth-token")).toBe("new-token"));
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("does not redirect after a failed sign-in even with a next set", async () => {
      setLocation("/account?next=%2Fcheckout%2Fpayment");
      api.post("/auth/login", fail(401, "Nope"));
      const { user } = renderUI(<AuthPanel />);
      await user.type(screen.getByLabelText(/^Email address/), "a@b.com");
      await user.type(screen.getByLabelText(/^Password/), "wrong");
      await user.click(submitButton());
      await waitFor(async () => expect(await toastMessages()).toContain("error: Nope"));
      expect(router.replace).not.toHaveBeenCalled();
    });
  });
});
