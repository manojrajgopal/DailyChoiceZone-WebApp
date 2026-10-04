import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { IdMultiSelect } from "@/components/common/IdMultiSelect";
import { IdSelector } from "@/components/common/IdSelector";
import { clearIdCache } from "@/services/lookupService";
import { api, fail, hang } from "@/test/api";
import { renderUI, screen, signIn, waitFor } from "@/test/render";

const PREVIEW = {
  entity: "product",
  label: "Product",
  idLabel: "Product ID",
  example: "PRD001",
  volatile: true,
  id: "PRD001",
  key: "PRD001",
  title: "Cotton Kurta",
  subtitle: "Anvi",
  status: "active",
  image: null,
  fields: [
    { label: "Price", value: 100000, format: "money" },
    { label: "Stock", value: 25, format: "number" },
  ],
  related: [{ entity: "category", id: "CAT001", label: "Category" }],
};

function Harness({ initial = null as string | null, onChange = vi.fn() }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <IdSelector
      entity="product"
      value={value}
      debounceMs={10}
      onChange={(id, preview) => {
        setValue(id);
        onChange(id, preview);
      }}
    />
  );
}

describe("IdSelector", () => {
  it("picks an ID, then loads and shows that record's main details", async () => {
    signIn("admin");
    clearIdCache();
    api.get("/admin/lookup/product", { items: [{ id: "PRD001" }], hasMore: false });
    api.get("/admin/lookup/product/PRD001", PREVIEW);
    const onChange = vi.fn();
    const { user } = renderUI(<Harness onChange={onChange} />);

    await user.type(screen.getByRole("combobox", { name: "Product ID" }), "PRD");
    await user.click(await screen.findByRole("option", { name: "PRD001" }));
    expect(onChange).toHaveBeenCalledWith("PRD001", null);

    expect(await screen.findByText("Cotton Kurta")).toBeInTheDocument();
    expect(screen.getByText("Stock").nextSibling).toHaveTextContent("25");
    expect(screen.getByText("Price").nextSibling?.textContent).toMatch(/1,000/);
    expect(screen.getByRole("link", { name: /View full details/ })).toHaveAttribute("href", "/admin/products/edit?id=PRD001");
    expect(screen.getByRole("link", { name: /Category CAT001/ })).toHaveAttribute(
      "href",
      "/admin/lookup?entity=category&id=CAT001",
    );
    // The exact ID was asked for — not a search.
    expect(api.last("GET", /\/admin\/lookup\/product\/PRD001$/)).toBeDefined();
  });

  it("shows a loading state while the details arrive", async () => {
    signIn("admin");
    api.get("/admin/lookup/product/PRD001", hang());
    renderUI(<Harness initial="PRD001" />);
    expect(screen.getByText("Loading details…")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Selected Product: PRD001/ })).toHaveAttribute("aria-busy", "true");
  });

  it("Change lets another ID be chosen; Escape keeps the current one", async () => {
    signIn("admin");
    api.get("/admin/lookup/product/PRD001", PREVIEW);
    const { user } = renderUI(<Harness initial="PRD001" />);
    await screen.findByText("Cotton Kurta");
    await user.click(screen.getByRole("button", { name: "Change Product ID" }));
    const input = screen.getByRole("combobox", { name: "Product ID" });
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(await screen.findByText("Cotton Kurta")).toBeInTheDocument();
  });

  it("Clear empties the field", async () => {
    signIn("admin");
    api.get("/admin/lookup/product/PRD001", PREVIEW);
    const onChange = vi.fn();
    const { user } = renderUI(<Harness initial="PRD001" onChange={onChange} />);
    await screen.findByText("Cotton Kurta");
    await user.click(screen.getByRole("button", { name: "Clear Product ID" }));
    expect(onChange).toHaveBeenCalledWith(null, null);
    expect(screen.getByRole("combobox", { name: "Product ID" })).toBeInTheDocument();
  });

  it("explains an ID that no longer exists and can retry", async () => {
    signIn("admin");
    api.once("GET", "/admin/lookup/product/PRD009", fail(404, "Product ID PRD009 was not found.", "LOOKUP_NOT_FOUND"));
    const { user } = renderUI(<Harness initial="PRD009" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Product ID PRD009 was not found.");
    api.get("/admin/lookup/product/PRD009", { ...PREVIEW, id: "PRD009", title: "Back again" });
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Back again")).toBeInTheDocument();
  });

  it("refetches volatile records every time (no stale stock)", async () => {
    signIn("admin");
    api.get("/admin/lookup/product/PRD001", PREVIEW);
    const first = renderUI(<Harness initial="PRD001" />);
    await screen.findByText("Cotton Kurta");
    first.unmount();
    renderUI(<Harness initial="PRD001" />);
    await screen.findByText("Cotton Kurta");
    expect(api.requests("GET", /\/admin\/lookup\/product\/PRD001$/)).toHaveLength(2);
  });

  it("reuses a slow-moving record's preview", async () => {
    signIn("admin");
    clearIdCache();
    api.get("/admin/lookup/supplier/SUP001", { ...PREVIEW, entity: "supplier", id: "SUP001", key: "SUP001", volatile: false, title: "Acme" });
    const Supplier = () => <IdSelector entity="supplier" value="SUP001" onChange={() => undefined} />;
    const first = renderUI(<Supplier />);
    await screen.findByText("Acme");
    first.unmount();
    renderUI(<Supplier />);
    await screen.findByText("Acme");
    expect(api.requests("GET", /\/admin\/lookup\/supplier\/SUP001$/)).toHaveLength(1);
  });
});

describe("IdMultiSelect", () => {
  it("adds IDs as chips, previews one, and removes it", async () => {
    signIn("admin");
    api.get("/admin/lookup/customer", { items: [{ id: "CUS001" }, { id: "CUS002" }], hasMore: false });
    api.get("/admin/lookup/customer/CUS001", { ...PREVIEW, entity: "customer", id: "CUS001", key: "CUS001", title: "Asha Rao" });
    function Multi() {
      const [ids, setIds] = useState<string[]>([]);
      return <IdMultiSelect entity="customer" values={ids} onChange={setIds} debounceMs={10} />;
    }
    const { user } = renderUI(<Multi />);
    const input = screen.getByRole("combobox", { name: "Customer ID" });
    await user.type(input, "CUS");
    await user.click(await screen.findByRole("option", { name: "CUS001" }));
    expect(screen.getByRole("button", { name: "Show Customer ID CUS001" })).toBeInTheDocument();

    await user.type(input, "CUS");
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-disabled", "true");

    await user.click(screen.getByRole("button", { name: "Show Customer ID CUS001" }));
    expect(await screen.findByText("Asha Rao")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Customer ID CUS001" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show Customer ID CUS001" })).toBeNull());
  });
});
