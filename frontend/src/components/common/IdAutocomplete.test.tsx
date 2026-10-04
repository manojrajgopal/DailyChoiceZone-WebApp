import { describe, expect, it, vi } from "vitest";

import { IdAutocomplete } from "@/components/common/IdAutocomplete";
import { api, fail, hang, networkError } from "@/test/api";
import { renderUI, screen, signIn, waitFor } from "@/test/render";

const suggestions = (items: { id: string; match?: string }[], hasMore = false) => ({
  entity: "product",
  label: "Product",
  idLabel: "Product ID",
  query: "",
  items,
  hasMore,
});

const PRODUCTS = suggestions([{ id: "PRD001" }, { id: "PRD002" }, { id: "PRD003", match: "DCZ-EL0003" }]);

function setup(props: Partial<React.ComponentProps<typeof IdAutocomplete>> = {}) {
  signIn("admin");
  const onSelect = vi.fn();
  const utils = renderUI(<IdAutocomplete entity="product" onSelect={onSelect} debounceMs={10} {...props} />);
  return { ...utils, onSelect, input: screen.getByRole("combobox", { name: "Product ID" }) };
}

describe("IdAutocomplete", () => {
  it("says which ID it wants", () => {
    const { input } = setup();
    expect(input).toHaveAttribute("placeholder", "Search Product ID…");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the matching IDs as options and asks the ID endpoint, not a name search", async () => {
    api.get("/admin/lookup/product", PRODUCTS);
    const { user, input } = setup();
    await user.type(input, "prd00");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["PRD001", "PRD002", "PRD003matched DCZ-EL0003"]);
    expect(input).toHaveAttribute("aria-expanded", "true");
    const request = api.last("GET", "/admin/lookup/product")!;
    expect(request.query.get("q")).toBe("prd00");
    expect(request.headers.authorization).toBe("Bearer test-token");
  });

  it("debounces typing into one request", async () => {
    api.get("/admin/lookup/product", PRODUCTS);
    const { user, input } = setup({ debounceMs: 120 });
    await user.type(input, "PRD-0");
    await screen.findAllByRole("option");
    expect(api.requests("GET", "/admin/lookup/product")).toHaveLength(1);
  });

  it("selects with the arrow keys and Enter, handing back the exact ID", async () => {
    api.get("/admin/lookup/product", PRODUCTS);
    const { user, input, onSelect } = setup();
    await user.type(input, "PRD");
    await screen.findAllByRole("option");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{ArrowUp}");
    // Wrapped round from the first to the last.
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[2]!.id);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("PRD003", undefined);
    expect(input).toHaveValue("");
  });

  it("selects with a click", async () => {
    api.get("/admin/lookup/product", PRODUCTS);
    const { user, input, onSelect } = setup();
    await user.type(input, "PRD");
    await user.click((await screen.findAllByRole("option"))[1]!);
    expect(onSelect).toHaveBeenCalledWith("PRD002", undefined);
  });

  it("checks a whole typed ID exactly when Enter is pressed with nothing highlighted", async () => {
    api.get("/admin/lookup/product", PRODUCTS);
    api.get("/admin/lookup/product/PRD001", { id: "PRD001", key: "PRD001", entity: "product", volatile: true, fields: [], related: [] });
    const { user, input, onSelect } = setup();
    await user.type(input, "PRD001{Enter}");
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("PRD001", expect.objectContaining({ id: "PRD001" })));
  });

  it("names the entity when a typed ID does not exist", async () => {
    api.get("/admin/lookup/product", suggestions([]));
    api.get("/admin/lookup/product/PRD999", fail(404, "Product ID PRD999 was not found.", "LOOKUP_NOT_FOUND"));
    const { user, input, onSelect } = setup();
    await user.type(input, "PRD999{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Product ID PRD999 was not found.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("says when no IDs match — in ID terms", async () => {
    api.get("/admin/lookup/product", suggestions([]));
    const { user, input } = setup();
    await user.type(input, "SHOE");
    expect(await screen.findByRole("status")).toHaveTextContent("No matching IDs found.");
    expect(screen.queryByText(/shoe/i, { selector: "[role=status]" })).toBeNull();
  });

  it("shows a searching state while IDs load", async () => {
    api.get("/admin/lookup/product", hang());
    const { user, input } = setup();
    await user.type(input, "P");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Searching IDs…"));
  });

  it.each([
    [fail(403, "Nope", "PERMISSION_DENIED"), "You don't have access to product records."],
    [fail(429, "Slow", "RATE_LIMITED"), "That's a lot of lookups in a short time. Please wait a moment and try again."],
    [fail(500, "Traceback (most recent call last)", "INTERNAL"), "Something went wrong looking that ID up. Please try again."],
    [networkError(), "We couldn't connect just now"],
  ])("explains a failed suggestion request without internals", async (reply, message) => {
    api.get("/admin/lookup/product", reply);
    const { user, input } = setup();
    await user.type(input, "P");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
    expect(document.body.textContent).not.toContain("Traceback");
  });

  it("aborts a stale request so its answer never lands", async () => {
    api.on("GET", "/admin/lookup/product", (req) =>
      req.query.get("q") === "P" ? hang() : PRODUCTS,
    );
    const { user, input } = setup({ debounceMs: 30 });
    await user.type(input, "P");
    await waitFor(() => expect(api.requests("GET", "/admin/lookup/product")).toHaveLength(1));
    await user.type(input, "RD");
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(api.requests("GET", "/admin/lookup/product").map((r) => r.query.get("q"))).toEqual(["P", "PRD"]);
  });

  it("Escape closes the list, and pressed again clears the text", async () => {
    api.get("/admin/lookup/product", PRODUCTS);
    const { user, input } = setup();
    await user.type(input, "PRD");
    await screen.findAllByRole("option");
    await user.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveValue("PRD");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
  });

  it("shows IDs already chosen but will not choose them again", async () => {
    api.get("/admin/lookup/product", PRODUCTS);
    const { user, input, onSelect } = setup({ exclude: ["prd001"] });
    await user.type(input, "PRD");
    const [first] = await screen.findAllByRole("option");
    expect(first).toHaveAttribute("aria-disabled", "true");
    await user.click(first!);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("PRD002", undefined);
  });

  it("works for the customer's own records with the customer token", async () => {
    signIn("customer", "shopper-token");
    api.get("/account/lookup/order", suggestions([{ id: "DCZ10001" }]));
    const onSelect = vi.fn();
    const { user } = renderUI(<IdAutocomplete entity="order" scope="account" tone="store" onSelect={onSelect} debounceMs={10} />);
    await user.type(screen.getByRole("combobox", { name: "Order ID" }), "DCZ");
    await user.click(await screen.findByRole("option", { name: "DCZ10001" }));
    expect(onSelect).toHaveBeenCalledWith("DCZ10001", undefined);
    expect(api.last("GET", "/account/lookup/order")!.headers.authorization).toBe("Bearer shopper-token");
  });
});
