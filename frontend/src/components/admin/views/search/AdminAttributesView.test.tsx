import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { useToastStore } from "@/store/toastStore";
import type { ProductAttribute } from "@/types/searchAdmin";

import { AdminAttributesView } from "./AdminAttributesView";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

function attribute(overrides: Partial<ProductAttribute> = {}): ProductAttribute {
  return {
    id: 1,
    code: "material",
    label: "Material",
    type: "select",
    unit: "",
    filterable: true,
    searchable: true,
    position: 0,
    status: "active",
    options: [
      { id: 11, value: "cotton", label: "Cotton", position: 0 },
      { id: 12, value: "linen", label: "Linen", position: 1 },
    ],
    productCount: 0,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

const MATERIAL = attribute();
const WEIGHT = attribute({ id: 2, code: "weight", label: "Weight", type: "number", unit: "g", options: [], productCount: 4, position: 1 });
const OLD = attribute({ id: 3, code: "season", label: "Season", status: "archived", options: [], filterable: false, searchable: false });

function serve(list: ProductAttribute[] = [MATERIAL, WEIGHT, OLD]) {
  api.get("/admin/attributes", list);
}

async function open(href = "/admin/attributes", list?: ProductAttribute[]) {
  setLocation(href);
  serve(list);
  const view = renderUI(<AdminAttributesView />);
  await screen.findByRole("button", { name: "Material" });
  return view;
}

describe("AdminAttributesView", () => {
  it("lists active attributes with the admin token, counts per tab and product usage", async () => {
    signIn("admin", "adm");
    await open();

    expect(api.last("GET", "/admin/attributes")!.headers.authorization).toBe("Bearer adm");
    expect(api.last("GET", "/admin/attributes")!.query.get("status")).toBe("all");
    expect(screen.getByRole("tab", { name: "Active 2" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Archived 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All 3" })).toBeInTheDocument();

    const weight = screen.getByRole("button", { name: "Weight" }).closest("tr")!;
    expect(within(weight).getByText("Number")).toBeInTheDocument();
    expect(within(weight).getByText("4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Season" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "Material" }).closest("tr")!).getByText("2: Cotton, Linen")).toBeInTheDocument();
  });

  it("shows the archived tab and searches from the address bar", async () => {
    setLocation("/admin/attributes?status=archived");
    serve();
    const { user } = renderUI(<AdminAttributesView />);
    expect(await screen.findByRole("button", { name: "Season" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Material" })).not.toBeInTheDocument();
    expect(screen.getByText("Display only")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /^Active/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/attributes", { scroll: false });
  });

  it("filters by label or code", async () => {
    setLocation("/admin/attributes?q=weig");
    serve();
    renderUI(<AdminAttributesView />);
    expect(await screen.findByRole("button", { name: "Weight" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Material" })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search attributes" })).toHaveValue("weig");
  });

  it("creates an attribute, deriving the code from the label, with ordered options", async () => {
    const { user } = await open();
    api.post("/admin/attributes", (request) => ({ ...attribute({ id: 9, ...request.body }), options: [] }));

    await user.click(screen.getByRole("button", { name: "New attribute" }));
    const dialog = await screen.findByRole("dialog", { name: "New attribute" });
    await user.type(within(dialog).getByLabelText(/^Label/), "Sleeve length");
    expect(within(dialog).getByLabelText(/^Code/)).toHaveValue("sleeve_length");
    await user.selectOptions(within(dialog).getByLabelText("Type"), "multi");

    await user.click(within(dialog).getByRole("button", { name: "Add option" }));
    await user.type(within(dialog).getByLabelText("Option 1 label"), "Short");
    await user.click(within(dialog).getByRole("button", { name: "Add option" }));
    await user.type(within(dialog).getByLabelText("Option 2 label"), "Long");
    await user.type(within(dialog).getByLabelText("Option 2 value"), "full");
    await user.click(within(dialog).getByRole("button", { name: "Move Long up" }));
    await user.click(within(dialog).getByRole("button", { name: "Add option" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove option 3" }));
    await user.click(within(dialog).getByRole("switch", { name: /Searchable/ }));

    await user.click(within(dialog).getByRole("button", { name: "Create attribute" }));

    await waitFor(() => expect(api.last("POST", "/admin/attributes")).toBeDefined());
    expect(api.last("POST", "/admin/attributes")!.body).toEqual({
      label: "Sleeve length",
      code: "sleeve_length",
      type: "multi",
      unit: "",
      filterable: true,
      searchable: false,
      position: 0,
      status: "active",
      options: [{ label: "Long", value: "full" }, { label: "Short" }],
    });
    await waitFor(() => expect(toasts()).toContain("success:Sleeve length created"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("checks the code and options before sending", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "New attribute" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Code/), "9bad");
    await user.click(within(dialog).getByRole("button", { name: "Add option" }));
    await user.click(within(dialog).getByRole("button", { name: "Create attribute" }));

    expect(within(dialog).getByText("Give the attribute a label.")).toBeInTheDocument();
    expect(within(dialog).getByText("2–40 lower-case letters, digits or _, starting with a letter.")).toBeInTheDocument();
    expect(within(dialog).getByText("Every option needs a label.")).toBeInTheDocument();
    expect(api.requests("POST", "/admin/attributes")).toHaveLength(0);
  });

  it("shows the server's words when the code is taken", async () => {
    const { user } = await open();
    api.post("/admin/attributes", fail(409, "An attribute with the code “material” already exists.", "ATTRIBUTE_CODE_TAKEN"));
    await user.click(screen.getByRole("button", { name: "New attribute" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Label/), "Material");
    await user.click(within(dialog).getByRole("button", { name: "Create attribute" }));

    const code = within(dialog).getByLabelText(/^Code/);
    await waitFor(() => expect(code).toHaveAttribute("aria-invalid", "true"));
    expect(within(dialog).getByText("An attribute with the code “material” already exists.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("edits an attribute in use: code and type locked, options sent with their ids", async () => {
    const used = attribute({ productCount: 3 });
    const { user } = await open("/admin/attributes", [used, WEIGHT]);
    api.put("/admin/attributes/1", (request) => attribute({ ...request.body, productCount: 3 }));

    await user.click(screen.getByRole("button", { name: "Edit Material" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Material" });
    expect(within(dialog).getByLabelText(/^Code/)).toBeDisabled();
    expect(within(dialog).getByLabelText("Type")).toBeDisabled();
    expect(within(dialog).getByLabelText("Option 1 value")).toHaveAttribute("readonly");

    const label = within(dialog).getByLabelText("Option 2 label");
    await user.clear(label);
    await user.type(label, "Pure linen");
    await user.click(within(dialog).getByRole("button", { name: "Save attribute" }));

    await waitFor(() => expect(api.last("PUT", "/admin/attributes/1")).toBeDefined());
    const body = api.last("PUT", "/admin/attributes/1")!.body;
    expect(body.code).toBeUndefined();
    expect(body.type).toBeUndefined();
    expect(body.options).toEqual([{ id: 11, label: "Cotton" }, { id: 12, label: "Pure linen" }]);
    await waitFor(() => expect(toasts()).toContain("success:Material saved"));
  });

  it("explains an option products still use", async () => {
    const { user } = await open();
    api.put("/admin/attributes/1", fail(409, "“Linen” is set on products, so it can't be removed. Take it off those products first.", "OPTION_IN_USE"));
    await user.click(screen.getByRole("button", { name: "Edit Material" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove Linen" }));
    await user.click(within(dialog).getByRole("button", { name: "Save attribute" }));

    expect(await within(dialog).findByText(/“Linen” is set on products/)).toBeInTheDocument();
    expect(api.last("PUT", "/admin/attributes/1")!.body.options).toEqual([{ id: 11, label: "Cotton" }]);
  });

  it("archives and restores", async () => {
    const { user } = await open("/admin/attributes?status=all");
    api.put("/admin/attributes/1", attribute({ status: "archived" }));
    api.put("/admin/attributes/3", attribute({ ...OLD, status: "active" }));

    await user.click(screen.getByRole("button", { name: "Archive Material" }));
    await waitFor(() => expect(api.last("PUT", "/admin/attributes/1")?.body).toEqual({ status: "archived" }));
    await waitFor(() => expect(toasts()).toContain("success:Material archived"));

    await user.click(screen.getByRole("button", { name: "Restore Season" }));
    await waitFor(() => expect(api.last("PUT", "/admin/attributes/3")?.body).toEqual({ status: "active" }));
    expect(api.requests("GET", "/admin/attributes").length).toBeGreaterThanOrEqual(3);
  });

  it("deletes an unused attribute after confirming", async () => {
    const { user } = await open();
    api.delete("/admin/attributes/1", null);
    await user.click(screen.getByRole("button", { name: "Delete Material" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete attribute?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete attribute" }));
    await waitFor(() => expect(api.requests("DELETE", "/admin/attributes/1")).toHaveLength(1));
    await waitFor(() => expect(toasts()).toContain("success:Material deleted"));
  });

  it("offers to archive an attribute in use instead of deleting it", async () => {
    const { user } = await open();
    api.put("/admin/attributes/2", attribute({ ...WEIGHT, status: "archived" }));
    await user.click(screen.getByRole("button", { name: "Delete Weight" }));
    const dialog = await screen.findByRole("dialog", { name: "Attribute in use" });
    expect(within(dialog).getByText(/is set on 4 products/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Archive instead" }));
    await waitFor(() => expect(api.last("PUT", "/admin/attributes/2")?.body).toEqual({ status: "archived" }));
    expect(api.requests("DELETE")).toHaveLength(0);
  });

  it("shows the server's reason when a delete is refused", async () => {
    const { user } = await open();
    api.delete("/admin/attributes/1", fail(409, "Products use this attribute, so it can't be deleted. Archive it instead.", "ATTRIBUTE_IN_USE"));
    await user.click(screen.getByRole("button", { name: "Delete Material" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete attribute" }));
    await waitFor(() =>
      expect(toasts()).toContain("error:Products use this attribute, so it can't be deleted. Archive it instead."),
    );
  });

  it("says so when the role lacks the products permission", async () => {
    setLocation("/admin/attributes");
    api.get("/admin/attributes", fail(403, "Forbidden", "FORBIDDEN"));
    renderUI(<AdminAttributesView />);
    expect(await screen.findByText("Your role doesn't include products")).toBeInTheDocument();
  });

  it("offers a retry when the list fails", async () => {
    setLocation("/admin/attributes");
    api.get("/admin/attributes", fail(500, "Boom"));
    const { user } = renderUI(<AdminAttributesView />);
    await screen.findByText("This didn’t load.");
    serve();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Material" })).toBeInTheDocument();
  });
});
