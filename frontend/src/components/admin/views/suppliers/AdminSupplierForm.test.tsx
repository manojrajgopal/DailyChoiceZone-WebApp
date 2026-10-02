import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { supplier, supplierDetail } from "@/test/suppliers-fixtures";
import { useToastStore } from "@/store/toastStore";

import { AdminSupplierForm } from "./AdminSupplierForm";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);
const input = (label: RegExp | string) => screen.getByLabelText(label);
const submit = () => screen.getByRole("button", { name: /^(Add supplier|Save changes)$/ });
/** An input's error, read through its aria-describedby. */
function errorOf(label: RegExp | string): string | null {
  const field = input(label);
  const ids = field.getAttribute("aria-describedby")?.split(" ") ?? [];
  const error = ids.map((id) => document.getElementById(id)).find((node) => node?.getAttribute("role") === "alert");
  return error?.textContent ?? null;
}

describe("AdminSupplierForm — create", () => {
  it("shows an empty form that only needs a name (and a GSTIN while registered)", async () => {
    const { user } = renderUI(<AdminSupplierForm mode="create" />);
    expect(screen.getByRole("heading", { name: "New supplier" })).toBeInTheDocument();
    expect(input(/^Tax treatment/)).toHaveValue("registered");
    expect(input(/^Billing country/)).toHaveValue("India");
    expect(input(/^GSTIN/)).toBeRequired();
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/admin/suppliers");

    await user.click(submit());
    expect(errorOf(/^Name/)).toBe("Enter the supplier's name.");
    expect(errorOf(/^GSTIN/)).toBe("A registered supplier needs a GSTIN.");
    expect(input(/^Name/)).toHaveAttribute("aria-invalid", "true");
    expect(toasts()).toContain("error:Check the highlighted fields.");
    expect(api.requests("POST", "/admin/suppliers")).toHaveLength(0);
  });

  it("drops the GSTIN requirement for an unregistered supplier", async () => {
    const { user } = renderUI(<AdminSupplierForm mode="create" />);
    await user.click(submit());
    expect(errorOf(/^GSTIN/)).not.toBeNull();
    await user.selectOptions(input(/^Tax treatment/), "unregistered");
    expect(errorOf(/^GSTIN/)).toBeNull();
    expect(input(/^GSTIN/)).not.toBeRequired();
    await user.type(input(/^Name/), "Local Weaver");
    expect(errorOf(/^Name/)).toBeNull();
  });

  it("explains a malformed code, GSTIN, PAN, email, phone, credit days and pincode", async () => {
    const { user } = renderUI(<AdminSupplierForm mode="create" />);
    await user.type(input(/^Name/), "Anvi");
    await user.type(input(/^Code/), "a");
    expect(input(/^Code/)).toHaveValue("A");
    await user.type(input(/^GSTIN/), "29abcde1234f");
    expect(input(/^GSTIN/)).toHaveValue("29ABCDE1234F");
    await user.type(input(/^PAN/), "abcde12");
    await user.type(input(/^Email/), "sales@anvi");
    await user.type(input(/^Phone/), "12345");
    await user.clear(input(/^Credit days/));
    await user.type(input(/^Credit days/), "400");
    await user.type(input(/^Billing pincode/), "5600");
    await user.click(submit());

    expect(errorOf(/^Code/)).toBe("Use 2–30 capital letters, digits or hyphens.");
    expect(errorOf(/^GSTIN/)).toBe("A GSTIN is 15 characters, like 29ABCDE1234F1Z5.");
    expect(errorOf(/^PAN/)).toBe("A PAN is 10 characters, like ABCDE1234F.");
    expect(errorOf(/^Email/)).toBe("Enter a valid email address.");
    expect(errorOf(/^Phone/)).toBe("Enter a 10-digit number, or + and the country code.");
    expect(errorOf(/^Credit days/)).toBe("Credit days are a whole number from 0 to 365.");
    expect(errorOf(/^Billing pincode/)).toBe("A pincode in India is 6 digits.");
    expect(api.requests("POST", "/admin/suppliers")).toHaveLength(0);

    // Fixing a field clears its error.
    await user.type(input(/^Billing pincode/), "01");
    expect(errorOf(/^Billing pincode/)).toBeNull();
  });

  it("checks that the PAN matches the GSTIN", async () => {
    const { user } = renderUI(<AdminSupplierForm mode="create" />);
    await user.type(input(/^Name/), "Anvi");
    await user.type(input(/^GSTIN/), "29ABCDE1234F1Z5");
    await user.type(input(/^PAN/), "ZZZZZ9999Z");
    await user.click(submit());
    expect(errorOf(/^PAN/)).toBe("The PAN doesn't match characters 3–12 of the GSTIN.");
    expect(errorOf(/^GSTIN/)).toBeNull();
  });

  it("checks the warehouse pincode once a separate warehouse is ticked", async () => {
    const { user } = renderUI(<AdminSupplierForm mode="create" />);
    expect(screen.queryByLabelText(/^Warehouse pincode/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Goods come from a different address/ }));
    await user.type(input(/^Name/), "Anvi");
    await user.selectOptions(input(/^Tax treatment/), "unregistered");
    await user.type(input(/^Warehouse pincode/), "12");
    await user.click(submit());
    expect(errorOf(/^Warehouse pincode/)).toBe("A pincode in India is 6 digits.");
  });

  it("creates the supplier and opens its page", async () => {
    signIn("admin", "adm");
    api.post("/admin/suppliers", supplier({ id: "SUP009", name: "Anvi Textiles" }));
    const { user } = renderUI(<AdminSupplierForm mode="create" />);
    await user.type(input(/^Name/), "  Anvi Textiles ");
    await user.type(input(/^GSTIN/), "29ABCDE1234F1Z5");
    await user.type(input(/^PAN/), "ABCDE1234F");
    await user.type(input(/^Phone/), "98765 43210");
    await user.type(input(/^Billing city/), "Bengaluru");
    await user.type(input(/^Billing state/), "Karnataka");
    await user.type(input(/^Billing pincode/), "560001");
    await user.type(input(/^Payment terms/), "Net 30");
    await user.clear(input(/^Credit days/));
    await user.type(input(/^Credit days/), "30");
    await user.click(submit());

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/suppliers/detail?id=SUP009"));
    const request = api.last("POST", "/admin/suppliers")!;
    expect(request.headers.authorization).toBe("Bearer adm");
    expect(request.body).toEqual({
      name: "Anvi Textiles",
      legalName: "",
      contactPerson: "",
      phone: "98765 43210",
      email: "",
      website: "",
      gstin: "29ABCDE1234F1Z5",
      pan: "ABCDE1234F",
      businessType: "manufacturer",
      taxTreatment: "registered",
      billingAddress: { line1: "", line2: "", city: "Bengaluru", state: "Karnataka", country: "India", pincode: "560001" },
      warehouseAddress: null,
      paymentTerms: "Net 30",
      creditDays: 30,
      currency: "INR",
      notes: "",
    });
    expect(toasts()).toContain("success:Anvi Textiles added");
  });

  it("puts a taken code on the code field", async () => {
    api.post("/admin/suppliers", fail(409, "Code ANVI-TEX is already used by Anvi Textiles.", "SUPPLIER_CODE_TAKEN"));
    const { user } = renderUI(<AdminSupplierForm mode="create" />);
    await user.type(input(/^Name/), "Anvi");
    await user.type(input(/^Code/), "ANVI-TEX");
    await user.selectOptions(input(/^Tax treatment/), "unregistered");
    await user.click(submit());
    await waitFor(() => expect(errorOf(/^Code/)).toBe("Code ANVI-TEX is already used by Anvi Textiles."));
    // A field error, not a banner.
    expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual(["Code ANVI-TEX is already used by Anvi Textiles."]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("puts the server's validation errors on their fields", async () => {
    api.post(
      "/admin/suppliers",
      fail(422, "Check the form.", "VALIDATION_ERROR", [{ field: "body.billingAddress.pincode", message: "Not a real pincode." }, { field: "email", message: "Domain doesn't exist." }]),
    );
    const { user } = renderUI(<AdminSupplierForm mode="create" />);
    await user.type(input(/^Name/), "Anvi");
    await user.selectOptions(input(/^Tax treatment/), "unregistered");
    await user.click(submit());
    await waitFor(() => expect(errorOf(/^Billing pincode/)).toBe("Not a real pincode."));
    expect(errorOf(/^Email/)).toBe("Domain doesn't exist.");
  });

  it("shows a banner for an error that isn't about a field", async () => {
    api.post("/admin/suppliers", fail(500, "Something broke.", "INTERNAL"));
    const { user } = renderUI(<AdminSupplierForm mode="create" />);
    await user.type(input(/^Name/), "Anvi");
    await user.selectOptions(input(/^Tax treatment/), "unregistered");
    await user.click(submit());
    const form = screen.getByRole("form", { name: "New supplier" });
    expect(await within(form).findByRole("alert")).toHaveTextContent("Something broke.");
    expect(toasts()).toContain("error:Something broke.");
    expect(submit()).toBeEnabled();
  });
});

describe("AdminSupplierForm — edit", () => {
  it("is not found without an id", () => {
    renderUI(<AdminSupplierForm mode="edit" />);
    expect(screen.getByRole("heading", { name: "Supplier not found" })).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it("shows a skeleton, then not-found on a 404", async () => {
    setLocation("/admin/suppliers/edit?id=SUP404");
    api.get("/admin/suppliers/SUP404", fail(404, "Not found", "NOT_FOUND"));
    renderUI(<AdminSupplierForm mode="edit" />);
    expect(screen.getByLabelText("Loading supplier")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Supplier not found" })).toBeInTheDocument();
  });

  it("explains a missing permission", async () => {
    setLocation("/admin/suppliers/edit?id=SUP001");
    api.get("/admin/suppliers/SUP001", fail(403, "Forbidden", "FORBIDDEN"));
    renderUI(<AdminSupplierForm mode="edit" />);
    expect(await screen.findByText("Your role doesn't include suppliers")).toBeInTheDocument();
  });

  it("offers a retry when it doesn't load", async () => {
    setLocation("/admin/suppliers/edit?id=SUP001");
    api.get("/admin/suppliers/SUP001", supplierDetail());
    api.once("GET", "/admin/suppliers/SUP001", fail(500, "Database busy.", "INTERNAL"));
    const { user } = renderUI(<AdminSupplierForm mode="edit" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Database busy.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Edit Anvi Textiles" })).toBeInTheDocument();
  });

  it("prefills from the supplier and saves the changes", async () => {
    setLocation("/admin/suppliers/edit?id=SUP001");
    api.get("/admin/suppliers/SUP001", supplierDetail({ warehouseAddress: { line1: "Unit 4", line2: "", city: "Tiruppur", state: "Tamil Nadu", country: "India", pincode: "641601" } }));
    api.put("/admin/suppliers/SUP001", supplier());
    const { user } = renderUI(<AdminSupplierForm mode="edit" />);

    expect(await screen.findByRole("heading", { name: "Edit Anvi Textiles" })).toBeInTheDocument();
    expect(input(/^Name/)).toHaveValue("Anvi Textiles");
    expect(input(/^Code/)).toHaveValue("ANVI-TEX");
    expect(input(/^GSTIN/)).toHaveValue("29ABCDE1234F1Z5");
    expect(input(/^Billing pincode/)).toHaveValue("560001");
    expect(screen.getByRole("checkbox", { name: /different address/ })).toBeChecked();
    expect(input(/^Warehouse city/)).toHaveValue("Tiruppur");
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/admin/suppliers/detail?id=SUP001");

    await user.clear(input(/^Payment terms/));
    await user.type(input(/^Payment terms/), "Net 45");
    await user.click(submit());

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/suppliers/detail?id=SUP001"));
    const body = api.last("PUT", "/admin/suppliers/SUP001")!.body;
    expect(body.code).toBe("ANVI-TEX");
    expect(body.paymentTerms).toBe("Net 45");
    expect(body.warehouseAddress).toMatchObject({ city: "Tiruppur", pincode: "641601" });
    expect(toasts()).toContain("success:Supplier updated");
  });

  it("keeps an unusual business type and currency it doesn't offer", async () => {
    setLocation("/admin/suppliers/edit?id=SUP001");
    api.get("/admin/suppliers/SUP001", supplierDetail({ businessType: "cooperative", currency: "USD" }));
    renderUI(<AdminSupplierForm mode="edit" />);
    await screen.findByRole("heading", { name: "Edit Anvi Textiles" });
    expect(input(/^Business type/)).toHaveValue("cooperative");
    expect(input(/^Currency/)).toHaveValue("USD");
  });
});
