import { describe, expect, it } from "vitest";

import type { PincodePage, PincodeRow } from "@/services/admin/operationsAdminService";
import { api } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor } from "@/test/render";

import { AdminPincodesView } from "./AdminPincodesView";

function row(overrides: Partial<PincodeRow> = {}): PincodeRow {
  return {
    id: 1, pincode: "560001", city: "Bengaluru", district: "Bengaluru Urban", state: "Karnataka",
    serviceable: true, codAvailable: true, expressAvailable: true, minDays: 2, maxDays: 4, deliveryFee: null,
    courier: "", notes: "", active: true, createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

function pageOf(items: PincodeRow[]): PincodePage {
  return {
    items,
    pagination: { page: 1, page_size: 25, total: items.length, total_pages: 1 },
    states: ["Karnataka", "Kerala"],
    counts: { active: items.length, inactive: 0 },
    settings: { restrictToListed: false },
  };
}

const lastQuery = () => api.last("GET", "/admin/delivery/pincodes")!.query;

describe("AdminPincodesView — pincode filter", () => {
  it("narrows the list to one pincode picked by ID; a city name finds nothing", async () => {
    signIn("admin");
    setLocation("/admin/delivery");
    api.get("/admin/delivery/pincodes", pageOf([row(), row({ id: 2, pincode: "560002" })]));
    lookupBackend("pincode", [
      idPreview("pincode", "560001", { title: "Bengaluru", volatile: false }),
      idPreview("pincode", "560002", { title: "Bengaluru", volatile: false }),
    ]);
    const { user } = renderUI(<AdminPincodesView />);

    const field = await screen.findByRole("combobox", { name: "Pincode" });
    await user.type(field, "Bengaluru");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "5600");
    expect(await screen.findByRole("option", { name: "560001" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "560002" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/delivery?q=560002", { scroll: false });
  });

  it("sends the pincode exactly, alongside the separate state filter", async () => {
    signIn("admin");
    setLocation("/admin/delivery?q=560001&state=Karnataka");
    api.get("/admin/delivery/pincodes", pageOf([row()]));
    const { user } = renderUI(<AdminPincodesView />);

    expect(await screen.findByRole("group", { name: "Filtered by Pincode 560001" })).toBeInTheDocument();
    await waitFor(() => expect(lastQuery().get("q")).toBe("560001"));
    expect(lastQuery().get("state")).toBe("Karnataka");
    expect(screen.getByRole("combobox", { name: "State" })).toHaveValue("Karnataka");

    await user.click(screen.getByRole("button", { name: "Remove Pincode filter" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/delivery?state=Karnataka", { scroll: false });
  });
});
