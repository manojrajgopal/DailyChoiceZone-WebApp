import { describe, expect, it, vi } from "vitest";

import type { OrderShipping, RateOption } from "@/types/shipping";
import { api, fail, networkError } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { orderShipping, shipment } from "@/test/shipping-fixtures";
import { useToastStore } from "@/store/toastStore";

import { CreateShipmentDialog } from "./CreateShipmentDialog";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

const RATES: RateOption[] = [
  { courierCode: "12", courierName: "Delhivery Surface", rate: 79, etaDays: { min: 3, max: 5 }, estimatedDeliveryAt: "2026-10-09T00:00:00", codAvailable: true },
  { courierCode: "44", courierName: "Blue Dart Air", rate: 149.6, etaDays: 1, estimatedDeliveryAt: null, codAvailable: false },
];

const PACKAGE = { weightGrams: 800, lengthCm: 30, widthCm: 20, heightCm: 5, count: 1, type: "box" };

function couriers() {
  lookupBackend("courier", [
    idPreview("courier", "shiprocket", { title: "Shiprocket", volatile: false }),
    idPreview("courier", "manual", { title: "Manual", volatile: false }),
    idPreview("courier", "delhivery", { title: "Delhivery", volatile: false }),
  ]);
}

function setup(shipping: OrderShipping = orderShipping({ defaultPackage: PACKAGE })) {
  couriers();
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const view = renderUI(<CreateShipmentDialog orderId="ORD042" shipping={shipping} onClose={onClose} onCreated={onCreated} />);
  const dialog = screen.getByRole("dialog", { name: "Create shipment for #DCZ10042" });
  return { ...view, dialog, onClose, onCreated };
}

const field = (dialog: HTMLElement, label: RegExp) => within(dialog).getByLabelText(label);

/** The provider is picked by its courier code, from the ID autocomplete. */
async function pickProvider(user: ReturnType<typeof renderUI>["user"], dialog: HTMLElement, code: string) {
  const change = within(dialog).queryByRole("button", { name: /^Change Courier provider/ });
  if (change) await user.click(change);
  await user.type(within(dialog).getByRole("combobox", { name: /^Courier provider/ }), code);
  await user.click(await within(dialog).findByRole("option", { name: code }));
}

describe("CreateShipmentDialog", () => {
  describe("the form", () => {
    it("preselects the default provider and prefills the saved default package", () => {
      const { dialog } = setup();
      // The default courier is preselected, by its code; its name is shown after.
      expect(within(dialog).getByText("shiprocket")).toBeInTheDocument();
      expect(within(dialog).getByText("Shiprocket (default)")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Change Courier provider/ })).toBeInTheDocument();
      // Two services: nothing is chosen for you.
      expect(field(dialog, /^Service/)).toHaveValue("");
      expect(field(dialog, /^Weight/)).toHaveValue("800");
      expect(field(dialog, /^Package type/)).toHaveValue("box");
      expect(dialog).toHaveTextContent("Prefilled from the courier's saved default package.");
      expect(within(dialog).queryByLabelText(/^AWB/)).not.toBeInTheDocument();
    });

    it("suggests couriers by code, never by name", async () => {
      const { user, dialog } = setup();
      await user.click(within(dialog).getByRole("button", { name: /^Change Courier provider/ }));
      const input = within(dialog).getByRole("combobox", { name: /^Courier provider/ });
      await user.type(input, "Ship rocket courier");
      expect((await within(dialog).findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
      await user.clear(input);
      await user.type(input, "ma");
      expect(await within(dialog).findByRole("option", { name: "manual" })).toBeInTheDocument();
      expect(api.last("GET", "/admin/lookup/courier")!.query.get("q")).toBe("ma");
    });

    it("refuses a courier that isn't switched on for shipments", async () => {
      const { user, dialog } = setup();
      await pickProvider(user, dialog, "delhivery");
      expect(within(dialog).getByRole("alert")).toHaveTextContent("Courier delhivery isn’t switched on for shipments.");
      expect(within(dialog).getByRole("button", { name: "Create shipment" })).toBeDisabled();
    });

    it("prefers the packed parcels over the courier's default package", () => {
      const { dialog } = setup(orderShipping({
        defaultPackage: PACKAGE,
        packing: { jobId: 7, status: "packed", statusLabel: "Packed · ready to ship",
          package: { weightGrams: 450, lengthCm: 20, widthCm: 15, heightCm: 8, count: 1, type: "box" } },
      }));
      expect(field(dialog, /^Weight/)).toHaveValue("450");
      expect(field(dialog, /^Length/)).toHaveValue("20");
      expect(dialog).toHaveTextContent("Prefilled from the packed parcels.");
    });

    it("starts blank without a default package", () => {
      const { dialog } = setup(orderShipping());
      expect(field(dialog, /^Weight/)).toHaveValue("");
      expect(dialog).not.toHaveTextContent("Prefilled");
    });

    it("needs a service and the full package for an API courier, and sends nothing until then", async () => {
      const { user, dialog } = setup(orderShipping());
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      expect(within(dialog).getByText("Choose a service.")).toBeInTheDocument();
      expect(within(dialog).getByText("Enter the weight in grams.")).toBeInTheDocument();
      expect(within(dialog).getAllByText("Required for this courier.")).toHaveLength(5);
      expect(api.requests("POST", "/admin/shipments")).toHaveLength(0);

      await user.selectOptions(field(dialog, /^Service/), "Express");
      expect(within(dialog).queryByText("Choose a service.")).not.toBeInTheDocument();
    });

    it("shows package range errors", async () => {
      const { user, dialog } = setup();
      await user.selectOptions(field(dialog, /^Service/), "Surface");
      await user.clear(field(dialog, /^Height/));
      await user.type(field(dialog, /^Height/), "400");
      await user.clear(field(dialog, /^Weight/));
      await user.type(field(dialog, /^Weight/), "0.5");
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      expect(within(dialog).getByText("Between 0.1 and 300 cm.")).toBeInTheDocument();
      expect(within(dialog).getByText("Use whole grams, e.g. 800.")).toBeInTheDocument();
      expect(api.requests("POST", "/admin/shipments")).toHaveLength(0);
    });

    it("says when no courier is switched on and can't create", () => {
      const { dialog } = setup(orderShipping({ providers: [] }));
      expect(dialog).toHaveTextContent("No courier is switched on.");
      expect(within(dialog).getByRole("button", { name: "Create shipment" })).toBeDisabled();
    });

    it("closes on Cancel", async () => {
      const { user, dialog, onClose } = setup();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("rates and courier choice", () => {
    it("asks for the dimensions before fetching rates", async () => {
      const { user, dialog } = setup(orderShipping());
      await user.type(field(dialog, /^Weight/), "800");
      await user.click(within(dialog).getByRole("button", { name: "Get rates" }));
      expect(within(dialog).getByText("Enter the weight and all three dimensions to get rates.")).toBeInTheDocument();
      expect(within(dialog).getAllByText("Required for this courier.")).toHaveLength(3);
      expect(api.requests("POST", "/admin/orders/ORD042/shipping/rates")).toHaveLength(0);
    });

    it("quotes couriers for the package, lets you choose one and books it", async () => {
      signIn("admin", "adm");
      api.post("/admin/orders/ORD042/shipping/rates", { options: RATES, source: "shiprocket" });
      api.post("/admin/shipments", (req) => shipment({ courierCode: req.body.courierCode }));
      const { user, dialog, onCreated } = setup();

      await user.click(within(dialog).getByRole("button", { name: "Get rates" }));
      const group = await within(dialog).findByRole("radiogroup", { name: "Choose a courier" });
      expect(api.last("POST", "/admin/orders/ORD042/shipping/rates")!.body).toEqual({
        providerCode: "shiprocket",
        package: { weightGrams: 800, lengthCm: 30, widthCm: 20, heightCm: 5 },
      });
      expect(api.last()!.headers.authorization).toBe("Bearer adm");

      const options = within(group).getAllByRole("listitem");
      expect(options[0]).toHaveTextContent("Delhivery Surface");
      expect(options[0]).toHaveTextContent("3–5 days · by 9 Oct 2026 · COD");
      expect(options[0]).toHaveTextContent("₹79");
      expect(options[1]).toHaveTextContent("1 day · No COD");
      expect(options[1]).toHaveTextContent("₹150");

      await user.click(within(options[1]!).getByRole("radio"));
      expect(within(options[1]!).getByRole("radio")).toBeChecked();
      expect(dialog).toHaveTextContent("Courier: Blue Dart Air");

      await user.selectOptions(field(dialog, /^Service/), "Express");
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

      const body = api.last("POST", "/admin/shipments")!.body;
      expect(body).toEqual({
        orderId: "ORD042",
        providerCode: "shiprocket",
        service: "Express",
        courierCode: "44",
        package: PACKAGE,
        idempotencyKey: expect.any(String),
      });
      expect(body.idempotencyKey.length).toBeGreaterThan(8);
      expect(toasts()).toContain("success:Shipment DCZ-SH-2026-000012 created.");
    });

    it("lets the provider assign a courier when none is chosen", async () => {
      api.post("/admin/shipments", shipment());
      const { user, dialog } = setup();
      await user.selectOptions(field(dialog, /^Service/), "Surface");
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      await waitFor(() => expect(api.requests("POST", "/admin/shipments")).toHaveLength(1));
      expect(api.last("POST", "/admin/shipments")!.body).not.toHaveProperty("courierCode");
    });

    it("says when no courier serves the route", async () => {
      api.post("/admin/orders/ORD042/shipping/rates", { options: [], source: "shiprocket" });
      const { user, dialog } = setup();
      await user.click(within(dialog).getByRole("button", { name: "Get rates" }));
      expect(await within(dialog).findByText("No courier serves this route for that package.")).toBeInTheDocument();
    });

    it("explains COURIER_UNAVAILABLE and still lets the shipment be created", async () => {
      api.post("/admin/orders/ORD042/shipping/rates", fail(503, "Shiprocket is down", "COURIER_UNAVAILABLE"));
      api.post("/admin/shipments", shipment());
      const { user, dialog, onCreated } = setup();
      await user.click(within(dialog).getByRole("button", { name: "Get rates" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "The courier couldn't be reached for rates. You can still create the shipment and let the courier assign one.",
      );
      expect(within(dialog).queryByRole("radiogroup")).not.toBeInTheDocument();

      await user.selectOptions(field(dialog, /^Service/), "Surface");
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(api.last("POST", "/admin/shipments")!.body).not.toHaveProperty("courierCode");
    });

    it("shows the API's own message for any other rates failure", async () => {
      api.post("/admin/orders/ORD042/shipping/rates", fail(422, "Pincode 570001 isn't served.", "NOT_SERVICEABLE"));
      const { user, dialog } = setup();
      await user.click(within(dialog).getByRole("button", { name: "Get rates" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Pincode 570001 isn't served.");
    });

    it("drops the quote when the package changes", async () => {
      api.post("/admin/orders/ORD042/shipping/rates", { options: RATES, source: "shiprocket" });
      const { user, dialog } = setup();
      await user.click(within(dialog).getByRole("button", { name: "Get rates" }));
      await user.click(within(await within(dialog).findByRole("radiogroup")).getAllByRole("radio")[0]!);
      expect(dialog).toHaveTextContent("Courier: Delhivery Surface");

      await user.type(field(dialog, /^Weight/), "0");
      expect(within(dialog).queryByRole("radiogroup")).not.toBeInTheDocument();
      expect(dialog).not.toHaveTextContent("Courier: Delhivery Surface");
    });
  });

  describe("a manual courier", () => {
    it("asks for the courier name and AWB, needs only the weight, and offers no rates", async () => {
      api.post("/admin/shipments", shipment({ provider: { code: "manual", name: "Manual" } }));
      const { user, dialog, onCreated } = setup(orderShipping());
      await pickProvider(user, dialog, "manual");

      // One service: chosen for you.
      expect(field(dialog, /^Service/)).toHaveValue("Standard");
      expect(within(dialog).queryByRole("region", { name: "Courier rates" })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Get rates" })).not.toBeInTheDocument();
      expect(dialog).toHaveTextContent("Only the weight is needed for a manual courier.");

      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      expect(within(dialog).getByText("Enter the courier's name.")).toBeInTheDocument();
      expect(within(dialog).getByText("Enter the AWB / tracking number.")).toBeInTheDocument();
      expect(within(dialog).getByText("Enter the weight in grams.")).toBeInTheDocument();
      expect(within(dialog).queryByText("Required for this courier.")).not.toBeInTheDocument();

      await user.type(field(dialog, /^Courier name/), " DTDC ");
      await user.type(field(dialog, /^AWB/), "AB 12");
      await user.type(field(dialog, /^Weight/), "500");
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      expect(within(dialog).getByText("4 to 40 letters, digits or hyphens.")).toBeInTheDocument();
      expect(api.requests("POST", "/admin/shipments")).toHaveLength(0);

      await user.clear(field(dialog, /^AWB/));
      await user.type(field(dialog, /^AWB/), "D123456789");
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect(api.last("POST", "/admin/shipments")!.body).toEqual({
        orderId: "ORD042",
        providerCode: "manual",
        service: "Standard",
        courierName: "DTDC",
        awb: "D123456789",
        package: { weightGrams: 500 },
        idempotencyKey: expect.any(String),
      });
    });

    it("forgets the quote and the errors when the provider changes", async () => {
      api.post("/admin/orders/ORD042/shipping/rates", { options: RATES, source: "shiprocket" });
      const { user, dialog } = setup();
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      expect(within(dialog).getByText("Choose a service.")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Get rates" }));
      await within(dialog).findByRole("radiogroup");

      await pickProvider(user, dialog, "manual");
      await pickProvider(user, dialog, "shiprocket");
      expect(within(dialog).queryByRole("radiogroup")).not.toBeInTheDocument();
      expect(within(dialog).queryByText("Choose a service.")).not.toBeInTheDocument();
    });
  });

  describe("submitting safely", () => {
    it("sends the same idempotency key when a failed create is retried", async () => {
      const { user, dialog, onCreated } = setup();
      await user.selectOptions(field(dialog, /^Service/), "Surface");

      api.post("/admin/shipments", shipment());
      api.once("POST", "/admin/shipments", networkError());
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(/couldn't connect just now/);
      expect(onCreated).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

      const [first, second] = api.requests("POST", "/admin/shipments").map((request) => request.body.idempotencyKey);
      expect(first).toBeTruthy();
      expect(second).toBe(first);
    });

    it("sends one request for a double click, and the button is busy meanwhile", async () => {
      let answer: (value: unknown) => void = () => undefined;
      api.post("/admin/shipments", () => new Promise((resolve) => (answer = resolve)));
      const { user, dialog, onCreated } = setup();
      await user.selectOptions(field(dialog, /^Service/), "Surface");

      const button = within(dialog).getByRole("button", { name: "Create shipment" });
      await user.dblClick(button);
      expect(button).toBeDisabled();
      expect(field(dialog, /^Weight/)).toBeDisabled();
      expect(api.requests("POST", "/admin/shipments")).toHaveLength(1);

      answer(shipment());
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    });

    it("uses a new key for a new opening of the dialog", async () => {
      api.post("/admin/shipments", shipment());
      const first = setup();
      await first.user.selectOptions(field(first.dialog, /^Service/), "Surface");
      await first.user.click(within(first.dialog).getByRole("button", { name: "Create shipment" }));
      await waitFor(() => expect(first.onCreated).toHaveBeenCalled());
      first.unmount();

      const second = setup();
      await second.user.selectOptions(field(second.dialog, /^Service/), "Surface");
      await second.user.click(within(second.dialog).getByRole("button", { name: "Create shipment" }));
      await waitFor(() => expect(second.onCreated).toHaveBeenCalled());

      const keys = api.requests("POST", "/admin/shipments").map((request) => request.body.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    });

    it("points at the existing shipment on SHIPMENT_EXISTS", async () => {
      api.post("/admin/shipments", fail(409, "This order already has an active shipment.", "SHIPMENT_EXISTS"));
      const { user, dialog, onCreated } = setup();
      await user.selectOptions(field(dialog, /^Service/), "Surface");
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "This order already has an active shipment. Close this and open the existing shipment instead.",
      );
      expect(onCreated).not.toHaveBeenCalled();
    });

    it("warns when the shipment was saved but the courier refused it", async () => {
      const refused = shipment({ technical: { ...shipment().technical, requestStatus: "failed", lastError: "Invalid pincode" } });
      api.post("/admin/shipments", refused);
      const { user, dialog, onCreated } = setup();
      await user.selectOptions(field(dialog, /^Service/), "Surface");
      await user.click(within(dialog).getByRole("button", { name: "Create shipment" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(refused));
      expect(toasts()).toContain(
        "error:Shipment DCZ-SH-2026-000012 is saved, but Shiprocket didn't accept it: Invalid pincode Retry it from the shipment page.",
      );
    });
  });
});
