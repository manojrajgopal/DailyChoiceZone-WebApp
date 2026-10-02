/**
 * `render` with a user-event instance, so a test reads:
 *
 *   const { user } = renderUI(<CartView />);
 *   await user.click(screen.getByRole("button", { name: /remove/i }));
 */
import { render, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

export function renderUI(ui: ReactElement, options?: RenderOptions & { userOptions?: Parameters<typeof userEvent.setup>[0] }) {
  const user = userEvent.setup(options?.userOptions);
  return { user, ...render(ui, options) };
}

/** Sign a customer or admin in, the way the app stores it (token in local storage). */
export function signIn(audience: "customer" | "admin" = "customer", token = "test-token") {
  window.localStorage.setItem(audience === "admin" ? "dcz:admin-token" : "dcz:auth-token", token);
}

export * from "@testing-library/react";
