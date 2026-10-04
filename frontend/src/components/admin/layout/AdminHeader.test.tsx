import { beforeEach, describe, expect, it } from "vitest";

import { AdminHeader } from "@/components/admin/layout/AdminHeader";
import { api, fail } from "@/test/api";
import { router } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";
import { setUpAdmin } from "@/test/sliceB-admin";

const FOUND = {
  query: "DCZ1",
  total: 3,
  groups: [
    { entity: "order", label: "Order", idLabel: "Order ID", query: "DCZ1", hasMore: false, items: [{ id: "DCZ10001" }, { id: "DCZ10002" }] },
    { entity: "product", label: "Product", idLabel: "Product ID", query: "DCZ1", hasMore: false, items: [{ id: "PRD007", match: "DCZ-AC0140" }] },
  ],
};

beforeEach(() => {
  setUpAdmin();
  api.get("/admin/notifications", []);
});

function input() {
  return screen.getByRole("combobox", { name: "Search any record by its ID" });
}

describe("AdminHeader global ID search", () => {
  it("asks for an ID, not for anything", () => {
    renderUI(<AdminHeader onOpenSidebar={() => undefined} />);
    expect(input().getAttribute("placeholder")).toMatch(/^Search by ID/);
  });

  it("lists matching IDs by entity, from one server request", async () => {
    api.get("/admin/lookup", FOUND);
    const { user } = renderUI(<AdminHeader onOpenSidebar={() => undefined} />);
    await user.type(input(), "DCZ1");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Order — DCZ10001",
      "Order — DCZ10002",
      "Product — PRD007matched DCZ-AC0140",
    ]);
    expect(screen.getByRole("group", { name: "Order ID" })).toBeInTheDocument();
    expect(api.requests("GET", "/admin/lookup")).toHaveLength(1);
    // The old search downloaded every order and customer; this one never does.
    expect(api.requests("GET", /^\/admin\/(orders|customers)$/)).toHaveLength(0);
  });

  it("opens the chosen ID's preview, by keyboard", async () => {
    api.get("/admin/lookup", FOUND);
    const { user } = renderUI(<AdminHeader onOpenSidebar={() => undefined} />);
    await user.type(input(), "DCZ1");
    await screen.findAllByRole("option");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");
    expect(router.push).toHaveBeenCalledWith("/admin/lookup?entity=order&id=DCZ10002");
  });

  it("opens the chosen ID's preview, by click", async () => {
    api.get("/admin/lookup", FOUND);
    const { user } = renderUI(<AdminHeader onOpenSidebar={() => undefined} />);
    await user.type(input(), "DCZ1");
    await user.click(await screen.findByRole("option", { name: /PRD007/ }));
    expect(router.push).toHaveBeenCalledWith("/admin/lookup?entity=product&id=PRD007");
  });

  it("says when no ID matches", async () => {
    api.get("/admin/lookup", { query: "ASHA", groups: [], total: 0 });
    const { user } = renderUI(<AdminHeader onOpenSidebar={() => undefined} />);
    await user.type(input(), "Asha");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No matching IDs found."));
  });

  it("explains a refusal without internals", async () => {
    api.get("/admin/lookup", fail(429, "slow down", "RATE_LIMITED"));
    const { user } = renderUI(<AdminHeader onOpenSidebar={() => undefined} />);
    await user.type(input(), "DCZ1");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("a lot of lookups"));
  });
});
