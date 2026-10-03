import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";
import { useToastStore } from "@/store/toastStore";
import type { ProductAttributeEntry } from "@/types/searchAdmin";

import { ProductAttributesPanel } from "./ProductAttributesPanel";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

const ENTRIES: ProductAttributeEntry[] = [
  {
    id: 1, code: "material", label: "Material", type: "select", unit: "",
    options: [{ id: 11, value: "cotton", label: "Cotton", position: 0 }, { id: 12, value: "linen", label: "Linen", position: 1 }],
    value: "cotton",
  },
  {
    id: 2, code: "occasion", label: "Occasion", type: "multi", unit: "",
    options: [
      { id: 21, value: "party", label: "Party", position: 0 },
      { id: 22, value: "office", label: "Office", position: 1 },
      { id: 23, value: "casual", label: "Casual", position: 2 },
    ],
    value: ["casual"],
  },
  { id: 3, code: "weight", label: "Weight", type: "number", unit: "g", options: [], value: 180 },
  { id: 4, code: "organic", label: "Organic", type: "boolean", unit: "", options: [], value: null },
];

function serve(attributes = ENTRIES) {
  api.get("/admin/products/P1/attributes", { productId: "P1", attributes });
}

describe("ProductAttributesPanel", () => {
  it("shows an input per attribute type with the product's values", async () => {
    serve();
    renderUI(<ProductAttributesPanel productId="P1" />);

    expect(await screen.findByLabelText("Material")).toHaveValue("cotton");
    expect(screen.getByRole("checkbox", { name: "Casual" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Party" })).not.toBeChecked();
    expect(screen.getByLabelText("Weight (g)")).toHaveValue(180);
    expect(screen.getByRole("switch", { name: /Organic/ })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /Organic.*Not set/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save attributes" })).toBeDisabled();
  });

  it("sends only the values that changed, in their API shapes", async () => {
    serve();
    const { user } = renderUI(<ProductAttributesPanel productId="P1" />);
    await screen.findByLabelText("Material");
    api.put("/admin/products/P1/attributes", { productId: "P1", attributes: ENTRIES });

    await user.selectOptions(screen.getByLabelText("Material"), "linen");
    await user.click(screen.getByRole("checkbox", { name: "Party" }));
    const weight = screen.getByLabelText("Weight (g)");
    await user.clear(weight);
    await user.type(weight, "2.5");
    await user.click(screen.getByRole("switch", { name: /Organic/ }));
    expect(screen.getByText("4 unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save attributes" }));
    await waitFor(() => expect(api.last("PUT", "/admin/products/P1/attributes")).toBeDefined());
    expect(api.last("PUT", "/admin/products/P1/attributes")!.body).toEqual({
      values: { material: "linen", occasion: ["party", "casual"], weight: 2.5, organic: true },
    });
    await waitFor(() => expect(toasts()).toContain("success:Attributes saved"));
  });

  it("clears values", async () => {
    serve();
    const { user } = renderUI(<ProductAttributesPanel productId="P1" />);
    await screen.findByLabelText("Material");
    api.put("/admin/products/P1/attributes", { productId: "P1", attributes: ENTRIES });

    await user.selectOptions(screen.getByLabelText("Material"), "");
    await user.click(screen.getByRole("checkbox", { name: "Casual" }));
    await user.clear(screen.getByLabelText("Weight (g)"));
    await user.click(screen.getByRole("button", { name: "Save attributes" }));

    await waitFor(() => expect(api.last("PUT", "/admin/products/P1/attributes")).toBeDefined());
    expect(api.last("PUT", "/admin/products/P1/attributes")!.body).toEqual({
      values: { material: null, occasion: [], weight: null },
    });
  });

  it("shows the server's reason for a refused value", async () => {
    serve();
    const { user } = renderUI(<ProductAttributesPanel productId="P1" />);
    await screen.findByLabelText("Material");
    api.put("/admin/products/P1/attributes", fail(422, "Weight is out of range.", "INVALID_ATTRIBUTE_VALUE"));
    const weight = screen.getByLabelText("Weight (g)");
    await user.clear(weight);
    await user.type(weight, "99999999999");
    await user.click(screen.getByRole("button", { name: "Save attributes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Weight is out of range.");
  });

  it("points to the attributes page when none exist", async () => {
    serve([]);
    renderUI(<ProductAttributesPanel productId="P1" />);
    expect(await screen.findByRole("link", { name: "Create attributes" })).toHaveAttribute("href", "/admin/attributes");
  });

  it("offers a retry when the values fail to load", async () => {
    api.get("/admin/products/P1/attributes", fail(500, "Boom"));
    const { user } = renderUI(<ProductAttributesPanel productId="P1" />);
    expect(await screen.findByText(/The attributes didn.t load/)).toBeInTheDocument();
    serve();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Material")).toHaveValue("cotton");
  });
});
