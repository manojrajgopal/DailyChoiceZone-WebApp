import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { address, fresh, siteContent, storeSession, toastMessages } from "@/test/sliceD-acct1-fixtures";

async function load() {
  fresh();
  return (await import("./AddressesView")).AddressesView;
}

describe("AddressesView", () => {
  describe("loading", () => {
    it("shows placeholders while addresses load", async () => {
      storeSession();
      api.get("/site/content", siteContent());
      api.get("/account/addresses", () => new Promise(() => undefined));
      const AddressesView = await load();
      const { container } = renderUI(<AddressesView />);
      await waitFor(() => expect(screen.getByRole("heading", { name: "Saved addresses" })).toBeInTheDocument());
      expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
      expect(screen.queryByText("No saved addresses")).not.toBeInTheDocument();
    });
  });

  describe("empty", () => {
    it("shows the empty state and opens the form from it", async () => {
      storeSession();
      api.get("/site/content", siteContent());
      api.get("/account/addresses", []);
      const AddressesView = await load();
      const { user } = renderUI(<AddressesView />);
      expect(await screen.findByText("No saved addresses")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Add an address" }));
      expect(screen.getByRole("heading", { name: "Add a new address" })).toBeInTheDocument();
    });
  });

  describe("with addresses", () => {
    it("lists each address with its type, default badge and details", async () => {
      storeSession();
      api.get("/site/content", siteContent());
      api.get("/account/addresses", [address({ id: "A1", type: "home", isDefault: true }), address({ id: "A2", type: "work", isDefault: false, fullName: "Rahul Rao", line2: "" })]);
      const AddressesView = await load();
      renderUI(<AddressesView />);

      expect(await screen.findByText("Asha Rao")).toBeInTheDocument();
      expect(screen.getByText("Default")).toBeInTheDocument();
      expect(screen.getByText("12 MG Road, Near Metro")).toBeInTheDocument();
      expect(screen.getAllByText("Bengaluru, Karnataka 560001")).toHaveLength(2);
      expect(screen.getAllByText("+91 9876543210")).toHaveLength(2);
      expect(screen.getByText("Rahul Rao")).toBeInTheDocument();
      // Only the non-default address offers "Make default".
      expect(screen.getAllByRole("button", { name: "Make default" })).toHaveLength(1);
    });

    it("opens Edit pre-filled with the address, and Save changes updates it", async () => {
      storeSession();
      api.get("/site/content", siteContent());
      api.get("/account/addresses", [address({ id: "A1" })]);
      api.put("/account/addresses/A1", (req) => ({ id: "A1", ...req.body }));
      const AddressesView = await load();
      const { user } = renderUI(<AddressesView />);
      await screen.findByText("Asha Rao");

      await user.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.getByRole("heading", { name: "Edit address" })).toBeInTheDocument();
      expect(screen.getByLabelText(/^Full name/)).toHaveValue("Asha Rao");

      await user.clear(screen.getByLabelText(/^City/));
      await user.type(screen.getByLabelText(/^City/), "Mysuru");
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(api.last("PUT", "/account/addresses/A1")!.body).toMatchObject({ city: "Mysuru" }));
      expect(await toastMessages()).toContain("success: Address updated");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("adds a new address with Save address, posting without an id", async () => {
      storeSession();
      api.get("/site/content", siteContent());
      let addresses = [address({ id: "A1" })];
      api.get("/account/addresses", () => addresses);
      api.post("/account/addresses", (req) => {
        const created = { id: "A2", ...req.body };
        addresses = [...addresses, created];
        return created;
      });
      const AddressesView = await load();
      const { user } = renderUI(<AddressesView />);
      await screen.findByText("Asha Rao");

      await user.click(screen.getByRole("button", { name: "Add a new address" }));
      await user.type(screen.getByLabelText(/^Full name/), "Nina Kapoor");
      await user.type(screen.getByLabelText(/^Mobile number/), "9123456780");
      await user.type(screen.getByLabelText(/^Flat, house no\., building/), "22 Palm Grove Road");
      await user.type(screen.getByLabelText(/^City/), "Mysuru");
      await user.type(screen.getByLabelText(/^PIN code/), "570001");
      await user.click(screen.getByRole("button", { name: "Save address" }));

      await waitFor(() => expect(api.requests("POST", "/account/addresses")).toHaveLength(1));
      expect(api.last("POST", "/account/addresses")!.body).toMatchObject({ fullName: "Nina Kapoor", phone: "9123456780", city: "Mysuru", pincode: "570001" });
      expect(await toastMessages()).toContain("success: Address saved");
    });

    it("deletes an address", async () => {
      storeSession();
      api.get("/site/content", siteContent());
      api.get("/account/addresses", [address({ id: "A1", fullName: "Asha Rao" })]);
      api.delete("/account/addresses/A1", {});
      const AddressesView = await load();
      const { user } = renderUI(<AddressesView />);
      await screen.findByText("Asha Rao");
      await user.click(screen.getByRole("button", { name: "Delete address for Asha Rao" }));
      await waitFor(() => expect(api.requests("DELETE", "/account/addresses/A1")).toHaveLength(1));
      expect(await toastMessages()).toContain("info: Address removed");
    });

    it("makes a non-default address the default", async () => {
      storeSession();
      api.get("/site/content", siteContent());
      api.get("/account/addresses", [
        address({ id: "A1", isDefault: true }),
        address({ id: "A2", isDefault: false, fullName: "Rahul Rao" }),
      ]);
      api.put("/account/addresses/A2", (req) => ({ id: "A2", ...req.body }));
      const AddressesView = await load();
      const { user } = renderUI(<AddressesView />);
      await screen.findByText("Rahul Rao");

      await user.click(screen.getByRole("button", { name: "Make default" }));
      await waitFor(() => expect(api.last("PUT", "/account/addresses/A2")!.body).toMatchObject({ isDefault: true }));
      expect(await toastMessages()).toContain("success: Default address updated");
    });

    it("cancels the form without saving", async () => {
      storeSession();
      api.get("/site/content", siteContent());
      api.get("/account/addresses", [address({ id: "A1" })]);
      const AddressesView = await load();
      const { user } = renderUI(<AddressesView />);
      await screen.findByText("Asha Rao");
      await user.click(screen.getByRole("button", { name: "Add a new address" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.requests("POST", "/account/addresses")).toHaveLength(0);
    });
  });

  describe("form validation", () => {
    async function openForm() {
      storeSession();
      api.get("/site/content", siteContent());
      api.get("/account/addresses", []);
      const AddressesView = await load();
      const view = renderUI(<AddressesView />);
      await screen.findByText("No saved addresses");
      await view.user.click(screen.getByRole("button", { name: "Add an address" }));
      return view;
    }

    /**
     * Fills every field with a value that satisfies the native `required`
     * attribute (so jsdom's own constraint validation lets the submit event
     * through at all), letting a test then override just the one field it
     * cares about with a value that is non-empty but fails the component's
     * own, stricter check.
     */
    async function fillValid(user: ReturnType<typeof renderUI>["user"]) {
      await user.type(screen.getByLabelText(/^Full name/), "Nina Kapoor");
      await user.type(screen.getByLabelText(/^Mobile number/), "9876543210");
      await user.type(screen.getByLabelText(/^Flat, house no\., building/), "22 Palm Grove Road");
      await user.type(screen.getByLabelText(/^City/), "Mysuru");
      await user.type(screen.getByLabelText(/^PIN code/), "570001");
    }

    it("rejects fields that are non-empty but invalid, with every message, and sends nothing", async () => {
      const { user } = await openForm();
      // Each satisfies `required` (native validation lets the submit event
      // through) but fails the component's own, stricter check.
      await user.type(screen.getByLabelText(/^Full name/), "A");
      await user.type(screen.getByLabelText(/^Mobile number/), "1234567890");
      await user.type(screen.getByLabelText(/^Flat, house no\., building/), "22");
      await user.type(screen.getByLabelText(/^City/), "M");
      await user.type(screen.getByLabelText(/^PIN code/), "00001");
      await user.click(screen.getByRole("button", { name: "Save address" }));

      expect(screen.getByText("Enter a full name.")).toBeInTheDocument();
      expect(screen.getByText("Enter a 10-digit mobile number.")).toBeInTheDocument();
      expect(screen.getByText("Enter the house or flat and street.")).toBeInTheDocument();
      expect(screen.getByText("Enter a city.")).toBeInTheDocument();
      expect(screen.getByText("Enter a valid PIN code.")).toBeInTheDocument();
      expect(api.requests("POST", "/account/addresses")).toHaveLength(0);
    });

    it("the native required attribute blocks submission while a field is genuinely empty", async () => {
      // Documents current behaviour: the custom "Enter a full name." message
      // never has a chance to show for a wholly-empty field, because jsdom's
      // (and a real browser's) own constraint validation blocks the submit
      // event first. Only non-empty-but-invalid values reach the component's
      // own validator — see the test above.
      const { user } = await openForm();
      await user.click(screen.getByRole("button", { name: "Save address" }));
      expect(screen.queryByText("Enter a full name.")).not.toBeInTheDocument();
      expect(api.requests("POST", "/account/addresses")).toHaveLength(0);
    });

    it.each([
      ["6123456789", true],
      ["9876543210", true],
      ["5123456789", false],
      ["1234567890", false],
      ["987654321", false],
    ])("validates the phone number %s as %s", async (phone, valid) => {
      api.post("/account/addresses", { id: "A1" });
      const { user } = await openForm();
      await fillValid(user);
      await user.clear(screen.getByLabelText(/^Mobile number/));
      await user.type(screen.getByLabelText(/^Mobile number/), phone);
      await user.click(screen.getByRole("button", { name: "Save address" }));
      if (valid) {
        expect(screen.queryByText("Enter a 10-digit mobile number.")).not.toBeInTheDocument();
      } else {
        expect(screen.getByText("Enter a 10-digit mobile number.")).toBeInTheDocument();
      }
    });

    it.each([
      ["560001", true],
      ["012345", false],
      ["56000", false],
    ])("validates the PIN code %s as %s", async (pincode, valid) => {
      api.post("/account/addresses", { id: "A1" });
      const { user } = await openForm();
      await fillValid(user);
      await user.clear(screen.getByLabelText(/^PIN code/));
      await user.type(screen.getByLabelText(/^PIN code/), pincode);
      await user.click(screen.getByRole("button", { name: "Save address" }));
      if (valid) {
        expect(screen.queryByText("Enter a valid PIN code.")).not.toBeInTheDocument();
      } else {
        expect(screen.getByText("Enter a valid PIN code.")).toBeInTheDocument();
      }
    });

    it("clears a field's error as soon as it's edited", async () => {
      const { user } = await openForm();
      await fillValid(user);
      await user.clear(screen.getByLabelText(/^City/));
      await user.type(screen.getByLabelText(/^City/), "M");
      await user.click(screen.getByRole("button", { name: "Save address" }));
      expect(screen.getByText("Enter a city.")).toBeInTheDocument();
      await user.type(screen.getByLabelText(/^City/), "ysuru");
      expect(screen.queryByText("Enter a city.")).not.toBeInTheDocument();
    });

    it("strips non-digits from the phone number before sending", async () => {
      api.post("/account/addresses", (req) => ({ id: "A1", ...req.body }));
      const { user } = await openForm();
      await user.type(screen.getByLabelText(/^Full name/), "Nina Kapoor");
      await user.type(screen.getByLabelText(/^Mobile number/), "98765 43210");
      await user.type(screen.getByLabelText(/^Flat, house no\., building/), "22 Palm Grove Road");
      await user.type(screen.getByLabelText(/^City/), "Mysuru");
      await user.type(screen.getByLabelText(/^PIN code/), "570001");
      await user.click(screen.getByRole("button", { name: "Save address" }));
      await waitFor(() => expect(api.last("POST", "/account/addresses")!.body).toMatchObject({ phone: "9876543210" }));
    });
  });

  describe("guest", () => {
    it("is gated behind sign-in", async () => {
      api.get("/site/content", siteContent());
      const AddressesView = await load();
      renderUI(<AddressesView />);
      expect(screen.getByRole("heading", { name: "Your account" })).toBeInTheDocument();
    });
  });
});
