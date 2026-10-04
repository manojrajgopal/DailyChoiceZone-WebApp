import { describe, expect, it } from "vitest";

import type { AdminCustomer } from "@/types/admin";
import { api } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor } from "@/test/render";

import { AdminCustomersView } from "./AdminCustomersView";

function customer(overrides: Partial<AdminCustomer> = {}): AdminCustomer {
  return {
    id: "CUS001", firstName: "Asha", lastName: "Rao", email: "asha@example.com", phone: "9876500001",
    status: "active", joinedAt: "2026-01-05T10:00:00Z", orderCount: 2, totalSpent: 1500,
    lastOrderAt: "2026-09-20T10:00:00Z", addresses: [], wishlistProductIds: [],
    ...overrides,
  };
}

const customers = [customer(), customer({ id: "CUS002", firstName: "Ravi", lastName: "Kumar", email: "ravi@example.com" })];

function customerLookup() {
  lookupBackend("customer", [
    idPreview("customer", "CUS001", { title: "Asha Rao", subtitle: "asha@example.com" }),
    idPreview("customer", "CUS002", { title: "Ravi Kumar", subtitle: "ravi@example.com" }),
  ]);
}

describe("AdminCustomersView — Customer ID filter", () => {
  it("suggests Customer IDs as one is typed; a name finds nothing; picking one filters by that ID", async () => {
    signIn("admin");
    setLocation("/admin/customers");
    api.get("/admin/customers", customers);
    customerLookup();
    const { user } = renderUI(<AdminCustomersView />);

    expect(await screen.findByText("Ravi Kumar")).toBeInTheDocument();
    expect(api.last("GET", "/admin/customers")!.query.has("q")).toBe(false);

    const field = screen.getByRole("combobox", { name: "Customer ID" });
    await user.type(field, "Ravi");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    // The name is not used to narrow the list in the browser either.
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "CUS");
    expect(await screen.findByRole("option", { name: /CUS001/ })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /CUS002/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/customers?q=CUS002", { scroll: false });
  });

  it("asks the server for exactly that customer, and the chip clears it", async () => {
    signIn("admin");
    setLocation("/admin/customers?q=CUS002");
    api.get("/admin/customers", [customers[1]!]);
    const { user } = renderUI(<AdminCustomersView />);

    expect(await screen.findByRole("group", { name: "Filtered by Customer ID CUS002" })).toBeInTheDocument();
    await waitFor(() => expect(api.last("GET", "/admin/customers")!.query.get("q")).toBe("CUS002"));
    expect(await screen.findByText("Ravi Kumar")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Customer ID filter" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/customers", { scroll: false });
  });
});
