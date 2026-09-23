"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Address, BillingAddress, DeliveryMethodId, PaymentMethodId } from "@/types";

import { STORAGE_KEYS } from "@/lib/storage/local-storage";

/**
 * Checkout state across the four steps.
 *
 * Persisted so a refresh or an accidental back-navigation mid-checkout does
 * not throw away what someone has already typed. Cleared as soon as the order
 * is placed.
 *
 * Note what is *not* here: no card number, CVV, expiry or any other payment
 * credential. Only the chosen payment *method* is stored. There is no gateway
 * and nothing sensitive is ever collected — see `PaymentStep`.
 */

export interface CheckoutContact {
  email: string;
  phone: string;
}

interface CheckoutState {
  contact: CheckoutContact;
  address: Omit<Address, "id"> | null;
  /**
   * Whether the invoice goes to the delivery address.
   *
   * Ticked by default because it is true for almost every order, and the
   * shortest correct path through a checkout is the one most people take.
   */
  billingSameAsShipping: boolean;
  /** Only set when the box above is unticked. */
  billingAddress: BillingAddress | null;
  deliveryMethodId: DeliveryMethodId;
  paymentMethodId: PaymentMethodId;

  setContact: (contact: CheckoutContact) => void;
  setAddress: (address: Omit<Address, "id">) => void;
  setBillingSameAsShipping: (same: boolean) => void;
  setBillingAddress: (address: BillingAddress | null) => void;
  setDeliveryMethod: (id: DeliveryMethodId) => void;
  setPaymentMethod: (id: PaymentMethodId) => void;
  reset: () => void;
}

const EMPTY_CONTACT: CheckoutContact = { email: "", phone: "" };

export const useCheckoutStore = create<CheckoutState>()(
  persist(
    (set) => ({
      contact: EMPTY_CONTACT,
      address: null,
      billingSameAsShipping: true,
      billingAddress: null,
      deliveryMethodId: "standard",
      paymentMethodId: "upi",

      setContact: (contact) => set({ contact }),
      setAddress: (address) => set({ address }),
      setBillingSameAsShipping: (billingSameAsShipping) =>
        // Clearing the separate address when the box is re-ticked stops a
        // stale one being billed after someone changes their mind.
        set(billingSameAsShipping ? { billingSameAsShipping, billingAddress: null } : { billingSameAsShipping }),
      setBillingAddress: (billingAddress) => set({ billingAddress }),
      setDeliveryMethod: (deliveryMethodId) => set({ deliveryMethodId }),
      setPaymentMethod: (paymentMethodId) => set({ paymentMethodId }),

      reset: () =>
        set({
          contact: EMPTY_CONTACT,
          address: null,
          billingSameAsShipping: true,
          billingAddress: null,
          deliveryMethodId: "standard",
          paymentMethodId: "upi",
        }),
    }),
    {
      name: STORAGE_KEYS.checkout,
      version: 2,
      partialize: (state) => ({
        contact: state.contact,
        address: state.address,
        billingSameAsShipping: state.billingSameAsShipping,
        billingAddress: state.billingAddress,
        deliveryMethodId: state.deliveryMethodId,
        paymentMethodId: state.paymentMethodId,
      }),
    },
  ),
);
