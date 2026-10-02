import { describe, expect, it, vi } from "vitest";

import type { BillingAddress } from "@/types";

import { useCheckoutStore } from "./checkoutStore";

const KEY = "dcz:checkout";
const checkout = () => useCheckoutStore.getState();

const ADDRESS = {
  fullName: "Asha Rao",
  phone: "9876543210",
  line1: "1 MG Road",
  line2: "",
  city: "Bengaluru",
  state: "Karnataka",
  pincode: "560001",
  type: "home" as const,
  isDefault: true,
};

const BILLING: BillingAddress = {
  fullName: "Asha Rao",
  phone: "9876543210",
  email: "asha@example.com",
  line1: "2 Brigade Rd",
  line2: "",
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560025",
  country: "IN",
};

const DEFAULTS = {
  contact: { email: "", phone: "" },
  address: null,
  billingSameAsShipping: true,
  billingAddress: null,
  deliveryMethodId: "standard",
  paymentMethodId: "upi",
};

describe("useCheckoutStore", () => {
  it("starts blank with billing same as shipping, standard delivery and UPI", () => {
    expect(checkout()).toMatchObject(DEFAULTS);
  });

  describe("setters", () => {
    it("sets contact, address, delivery and payment method", () => {
      checkout().setContact({ email: "a@b.co", phone: "1" });
      checkout().setAddress(ADDRESS);
      checkout().setDeliveryMethod("express");
      checkout().setPaymentMethod("cod");
      expect(checkout()).toMatchObject({
        contact: { email: "a@b.co", phone: "1" },
        address: ADDRESS,
        deliveryMethodId: "express",
        paymentMethodId: "cod",
      });
    });

    it("keeps a separate billing address while the box stays unticked", () => {
      checkout().setBillingSameAsShipping(false);
      checkout().setBillingAddress(BILLING);
      checkout().setBillingSameAsShipping(false);
      expect(checkout().billingSameAsShipping).toBe(false);
      expect(checkout().billingAddress).toEqual(BILLING);
    });

    it("drops the separate billing address when the box is ticked again", () => {
      checkout().setBillingSameAsShipping(false);
      checkout().setBillingAddress(BILLING);
      checkout().setBillingSameAsShipping(true);
      expect(checkout().billingSameAsShipping).toBe(true);
      expect(checkout().billingAddress).toBeNull();
    });

    it("can clear the billing address explicitly", () => {
      checkout().setBillingAddress(BILLING);
      checkout().setBillingAddress(null);
      expect(checkout().billingAddress).toBeNull();
    });
  });

  it("reset returns every field to its default", () => {
    checkout().setContact({ email: "a@b.co", phone: "1" });
    checkout().setAddress(ADDRESS);
    checkout().setBillingSameAsShipping(false);
    checkout().setBillingAddress(BILLING);
    checkout().setDeliveryMethod("express");
    checkout().setPaymentMethod("card");
    checkout().reset();
    expect(checkout()).toMatchObject(DEFAULTS);
  });

  describe("persistence", () => {
    it("persists every data field but no functions, as version 2", () => {
      checkout().setContact({ email: "a@b.co", phone: "1" });
      const saved = JSON.parse(localStorage.getItem(KEY)!) as { state: Record<string, unknown>; version: number };
      expect(saved.version).toBe(2);
      expect(Object.keys(saved.state).sort()).toEqual(
        ["address", "billingAddress", "billingSameAsShipping", "contact", "deliveryMethodId", "paymentMethodId"],
      );
      expect(saved.state.contact).toEqual({ email: "a@b.co", phone: "1" });
    });

    it("never stores anything that looks like a card credential", () => {
      checkout().setPaymentMethod("card");
      expect(localStorage.getItem(KEY)).not.toMatch(/cvv|cardNumber|expiry/i);
    });

    it("rehydrates a saved checkout", async () => {
      localStorage.setItem(KEY, JSON.stringify({
        state: { contact: { email: "x@y.z", phone: "2" }, address: ADDRESS, billingSameAsShipping: false, billingAddress: BILLING, deliveryMethodId: "express", paymentMethodId: "netbanking" },
        version: 2,
      }));
      await useCheckoutStore.persist.rehydrate();
      expect(checkout()).toMatchObject({ address: ADDRESS, billingAddress: BILLING, paymentMethodId: "netbanking", deliveryMethodId: "express", billingSameAsShipping: false });
    });

    it("discards a checkout saved by the previous version", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      localStorage.setItem(KEY, JSON.stringify({ state: { address: ADDRESS, paymentMethodId: "card" }, version: 1 }));
      await useCheckoutStore.persist.rehydrate();
      expect(checkout().address).toBeNull();
      expect(checkout().paymentMethodId).toBe("upi");
    });

    it("survives corrupt stored data", async () => {
      localStorage.setItem(KEY, "corrupt");
      await useCheckoutStore.persist.rehydrate();
      expect(checkout()).toMatchObject(DEFAULTS);
    });
  });
});
