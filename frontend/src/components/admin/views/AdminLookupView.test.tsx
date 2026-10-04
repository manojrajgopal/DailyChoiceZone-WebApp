import { beforeEach, describe, expect, it } from "vitest";

import { AdminLookupView } from "@/components/admin/views/AdminLookupView";
import { api } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen } from "@/test/render";
import { setUpAdmin } from "@/test/sliceB-admin";

const ENTITIES = {
  items: [
    { entity: "order", label: "Order", idLabel: "Order ID", example: "DCZ10001", volatile: true },
    { entity: "product", label: "Product", idLabel: "Product ID", example: "PRD001", volatile: true },
  ],
};

const ORDER = {
  entity: "order",
  label: "Order",
  idLabel: "Order ID",
  id: "DCZ10001",
  key: "ORD001",
  volatile: true,
  title: "Order DCZ10001",
  subtitle: "Asha Rao",
  status: "confirmed",
  image: null,
  fields: [{ label: "Total", value: 99900, format: "money" }],
  related: [{ entity: "customer", id: "CUS001", label: "Customer" }],
};

beforeEach(() => {
  setUpAdmin();
  api.get("/admin/lookup/entities", ENTITIES);
});

describe("AdminLookupView", () => {
  it("opens the ID in the URL and links to the full record", async () => {
    setLocation("/admin/lookup?entity=order&id=DCZ10001");
    api.get("/admin/lookup/order/DCZ10001", ORDER);
    renderUI(<AdminLookupView />);
    expect(await screen.findByText("Order DCZ10001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View full details/ })).toHaveAttribute("href", "/admin/orders/detail?id=ORD001");
    expect(screen.getByRole("link", { name: /Customer CUS001/ })).toHaveAttribute("href", "/admin/lookup?entity=customer&id=CUS001");
  });

  it("offers only the record types this role may open, and switches between them", async () => {
    setLocation("/admin/lookup?entity=order");
    const { user } = renderUI(<AdminLookupView />);
    const select = await screen.findByRole("combobox", { name: "Record type" });
    await screen.findByRole("option", { name: "Product ID" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Order ID", "Product ID"]);
    await user.selectOptions(select, "product");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/lookup?entity=product", { scroll: false });
  });

  it("puts a chosen ID in the URL", async () => {
    setLocation("/admin/lookup?entity=order");
    api.get("/admin/lookup/order", { items: [{ id: "DCZ10001" }], hasMore: false });
    const { user } = renderUI(<AdminLookupView />);
    await user.type(await screen.findByRole("combobox", { name: "Order ID" }), "DCZ");
    await user.click(await screen.findByRole("option", { name: "DCZ10001" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/lookup?entity=order&id=DCZ10001", { scroll: false });
  });

  it("says so when the role cannot open that type", async () => {
    setLocation("/admin/lookup?entity=customer&id=CUS001");
    renderUI(<AdminLookupView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role doesn't include customer records.");
    expect(api.requests("GET", "/admin/lookup/customer/CUS001")).toHaveLength(0);
  });
});
