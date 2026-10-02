import { describe, expect, it } from "vitest";

import { api, fail, networkError, raw } from "@/test/api";
import { router } from "@/test/navigation";
import { fireEvent, renderUI, screen, waitFor } from "@/test/render";
import { adminUser, signInAdminUser } from "@/test/sliceG1-admin";
import { useAdminAuthStore } from "@/store/adminAuthStore";

import { AdminLoginView } from "./AdminLoginView";

function loginPayload() {
  return {
    token: { accessToken: "fresh-admin-token", tokenType: "bearer", expiresIn: 3600 },
    admin: adminUser({ name: "Asha Rao" }),
  };
}

async function fillAndSubmit(user: ReturnType<typeof renderUI>["user"], email: string, password: string) {
  if (email) await user.type(screen.getByLabelText(/Email address/), email);
  if (password) await user.type(screen.getByLabelText(/Password/), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("AdminLoginView", () => {
  describe("rendering", () => {
    it("shows the brand, an email and password form and a link back to the storefront", () => {
      renderUI(<AdminLoginView />);
      expect(screen.getByRole("heading", { name: "Daily Choice Zone" })).toBeInTheDocument();
      expect(screen.getByText("Admin portal")).toBeInTheDocument();
      const email = screen.getByLabelText(/Email address/);
      expect(email).toHaveAttribute("type", "email");
      expect(email).toBeRequired();
      expect(email).toHaveFocus();
      expect(screen.getByLabelText(/Password/)).toHaveAttribute("type", "password");
      expect(screen.getByRole("link", { name: /Back to the storefront/ })).toHaveAttribute("href", "/");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("success cases", () => {
    it("signs in with a trimmed, lower-cased email, stores the token and session and goes to the dashboard", async () => {
      api.post("/admin/auth/login", loginPayload());
      const { user } = renderUI(<AdminLoginView />);
      await fillAndSubmit(user, "  Asha@Example.COM ", "s3cret!");

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin/dashboard"));
      expect(api.last("POST", "/admin/auth/login")!.body).toEqual({ email: "asha@example.com", password: "s3cret!" });
      expect(window.localStorage.getItem("dcz:admin-token")).toBe("fresh-admin-token");
      expect(useAdminAuthStore.getState().session).toMatchObject({ token: "fresh-admin-token", user: { name: "Asha Rao" } });
    });

    it("skips the form for an admin who is already signed in", async () => {
      signInAdminUser();
      renderUI(<AdminLoginView />);
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin/dashboard"));
      expect(api.requests("POST", "/admin/auth/login")).toHaveLength(0);
    });

    it("disables the button while the sign-in is in flight", async () => {
      let answer: (value: unknown) => void = () => undefined;
      api.post("/admin/auth/login", () => new Promise((resolve) => { answer = resolve; }));
      const { user } = renderUI(<AdminLoginView />);
      await fillAndSubmit(user, "a@b.co", "pw");
      expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
      answer(fail(401, "Wrong email or password.", "UNAUTHORIZED"));
      await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled());
    });
  });

  describe("error cases", () => {
    it.each([
      [401, "Wrong email or password."],
      [403, "This account is disabled."],
      [429, "Too many attempts. Try again later."],
      [500, "Server error"],
    ])("shows the server's message on a %i and stays on the page", async (status, message) => {
      api.post("/admin/auth/login", fail(status, message));
      const { user } = renderUI(<AdminLoginView />);
      await fillAndSubmit(user, "asha@example.com", "wrong");

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(router.replace).not.toHaveBeenCalled();
      expect(useAdminAuthStore.getState().session).toBeNull();
      expect(window.localStorage.getItem("dcz:admin-token")).toBeNull();
      expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    });

    it("reports an unreachable server", async () => {
      api.post("/admin/auth/login", networkError());
      const { user } = renderUI(<AdminLoginView />);
      await fillAndSubmit(user, "asha@example.com", "pw");
      expect(await screen.findByRole("alert")).toHaveTextContent(/.+/);
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("reports a malformed response", async () => {
      api.post("/admin/auth/login", raw(502, "<html>bad gateway</html>"));
      const { user } = renderUI(<AdminLoginView />);
      await fillAndSubmit(user, "asha@example.com", "pw");
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("clears the previous error when the next attempt succeeds", async () => {
      api.post("/admin/auth/login", loginPayload());
      api.once("POST", "/admin/auth/login", fail(401, "Wrong email or password."));
      const { user } = renderUI(<AdminLoginView />);
      await fillAndSubmit(user, "asha@example.com", "wrong");
      expect(await screen.findByRole("alert")).toHaveTextContent("Wrong email or password.");

      await user.click(screen.getByRole("button", { name: "Sign in" }));
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin/dashboard"));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("validation", () => {
    it("explains a missing email, then a missing password, without calling the API", async () => {
      // Submitted directly, bypassing the browser's own `required` checks as a script would.
      renderUI(<AdminLoginView />);
      const form = screen.getByRole("button", { name: "Sign in" }).closest("form")!;
      fireEvent.submit(form);
      expect(await screen.findByRole("alert")).toHaveTextContent("Enter your email address.");

      fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "   " } });
      fireEvent.submit(form);
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Enter your email address."));

      fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "asha@example.com" } });
      fireEvent.submit(form);
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Enter your password."));
      expect(api.requests("POST", "/admin/auth/login")).toHaveLength(0);
    });
  });
});
