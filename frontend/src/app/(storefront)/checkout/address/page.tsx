"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { Address, BillingAddress, DeliveryMethodId } from "@/types";

import { CheckoutShell } from "@/components/checkout/CheckoutShell";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input, Radio, Select } from "@/components/ui/Field";
import { useCheckoutHydrated } from "@/hooks/useStoreHydrated";
import { getAddresses } from "@/services/accountService";
import { DELIVERY_METHODS } from "@/services/orderService";
import { useCheckoutStore } from "@/store/checkoutStore";
import { formatPrice } from "@/lib/utils/format";

/** A short list rather than all 28 — enough to be credible in a demo. */
const STATES = [
  "Karnataka", "Maharashtra", "Delhi", "Tamil Nadu", "Telangana", "Gujarat",
  "West Bengal", "Rajasthan", "Kerala", "Uttar Pradesh", "Punjab", "Haryana",
  "Madhya Pradesh", "Bihar", "Odisha", "Assam",
];

type FormState = Omit<Address, "id">;

const EMPTY_BILLING: BillingAddress = {
  fullName: "",
  phone: "",
  email: "",
  line1: "",
  line2: "",
  city: "",
  state: "Karnataka",
  postalCode: "",
  country: "India",
};

const EMPTY_FORM: FormState = {
  fullName: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  state: "Karnataka",
  pincode: "",
  type: "home",
  isDefault: true,
};

/**
 * Copy an address into form state.
 *
 * Fields are picked explicitly rather than spread, so a stored `id` cannot
 * leak into the form and there is no unused discard variable to explain.
 */
function toFormState(address: Omit<Address, "id">): FormState {
  return {
    fullName: address.fullName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
    type: address.type,
    isDefault: address.isDefault,
  };
}

/** Step 2 — where it is going, and how fast. */
export default function CheckoutAddressPage() {
  const router = useRouter();
  const checkoutHydrated = useCheckoutHydrated();

  const contact = useCheckoutStore((state) => state.contact);
  const storedAddress = useCheckoutStore((state) => state.address);
  const setAddress = useCheckoutStore((state) => state.setAddress);
  const deliveryMethodId = useCheckoutStore((state) => state.deliveryMethodId);
  const setDeliveryMethod = useCheckoutStore((state) => state.setDeliveryMethod);

  const billingSame = useCheckoutStore((state) => state.billingSameAsShipping);
  const setBillingSame = useCheckoutStore((state) => state.setBillingSameAsShipping);
  const storedBilling = useCheckoutStore((state) => state.billingAddress);
  const setBillingAddress = useCheckoutStore((state) => state.setBillingAddress);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [billing, setBilling] = useState<BillingAddress>(EMPTY_BILLING);
  const [saved, setSaved] = useState<Address[]>([]);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [billingErrors, setBillingErrors] = useState<Partial<Record<keyof BillingAddress, string>>>({});

  // Contact is required first; jump back if someone deep-linked here. Waits
  // for the store to rehydrate, or a refresh would bounce a valid checkout.
  useEffect(() => {
    if (!checkoutHydrated) return;
    if (!contact.email) router.replace("/checkout");
  }, [checkoutHydrated, contact.email, router]);

  // Seed from a previous visit, a saved address, or the contact phone.
  useEffect(() => {
    let active = true;
    getAddresses()
      .then((addresses) => {
        if (!active) return;
        setSaved(addresses);

        const seed =
          storedAddress ??
          (addresses.find((entry) => entry.isDefault) ?? addresses[0] ?? null);

        if (seed) {
          setForm(toFormState(seed));
        } else if (contact.phone) {
          setForm((current) => ({ ...current, phone: current.phone || contact.phone }));
        }
      })
      .catch(() => {
        if (active) setSaved([]);
      });

    return () => {
      active = false;
    };
  }, [storedAddress, contact.phone]);

  // Restore a separate billing address entered earlier in this checkout.
  useEffect(() => {
    if (storedBilling) setBilling(storedBilling);
  }, [storedBilling]);

  const updateBilling = <K extends keyof BillingAddress>(key: K, value: BillingAddress[K]) => {
    setBilling((current) => ({ ...current, [key]: value }));
    setBillingErrors((current) => ({ ...current, [key]: undefined }));
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    const next: Partial<Record<keyof FormState, string>> = {};
    if (form.fullName.trim().length < 2) next.fullName = "Enter the recipient's full name.";
    if (!/^[6-9]\d{9}$/.test(form.phone.replace(/\D/g, ""))) {
      next.phone = "Enter a 10-digit mobile number.";
    }
    if (form.line1.trim().length < 5) next.line1 = "Enter the house or flat and street.";
    if (form.city.trim().length < 2) next.city = "Enter a city.";
    // Indian PIN codes are six digits and never start with zero.
    if (!/^[1-9]\d{5}$/.test(form.pincode.trim())) next.pincode = "Enter a valid 6-digit PIN code.";

    // A separate billing address is validated to the same standard as the
    // shipping one — it is what goes on the invoice, and an invoice with a
    // half-filled address is not a document anyone can use.
    const billingNext: Partial<Record<keyof BillingAddress, string>> = {};
    if (!billingSame) {
      if (billing.fullName.trim().length < 2) billingNext.fullName = "Enter the billing name.";
      if (!/^\S+@\S+\.\S+$/.test(billing.email.trim())) billingNext.email = "Enter a valid email.";
      if (!/^[6-9]\d{9}$/.test(billing.phone.replace(/\D/g, ""))) {
        billingNext.phone = "Enter a 10-digit mobile number.";
      }
      if (billing.line1.trim().length < 5) billingNext.line1 = "Enter the house or flat and street.";
      if (billing.city.trim().length < 2) billingNext.city = "Enter a city.";
      if (!/^[1-9]\d{5}$/.test(billing.postalCode.trim())) {
        billingNext.postalCode = "Enter a valid 6-digit PIN code.";
      }
    }

    setErrors(next);
    setBillingErrors(billingNext);
    if (Object.keys(next).length > 0 || Object.keys(billingNext).length > 0) return;

    setAddress({ ...form, phone: form.phone.replace(/\D/g, "") });
    setBillingAddress(
      billingSame ? null : { ...billing, phone: billing.phone.replace(/\D/g, "") },
    );
    router.push("/checkout/payment");
  };

  return (
    <CheckoutShell
      title="Delivery address"
      description="Tell us where to send it, and choose how quickly you need it."
    >
      <form onSubmit={onSubmit}>
        {/* ------------------------------------------------ saved addresses */}
        {saved.length > 0 ? (
          <div className="mb-8">
            <p className="label-wide mb-3 text-ink-700">Use a saved address</p>
            <div className="flex flex-wrap gap-2">
              {saved.map((address) => (
                <button
                  key={address.id}
                  type="button"
                  onClick={() => setForm(toFormState(address))}
                  className="rounded-card border border-ink-200 bg-shell px-3.5 py-2.5 text-left text-xs transition-colors hover:border-ink"
                >
                  <span className="block font-medium text-ink">{address.fullName}</span>
                  <span className="mt-0.5 block text-ink-500">
                    {address.city}, {address.pincode}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid max-w-2xl gap-5 sm:grid-cols-2">
          <Input
            label="Full name"
            autoComplete="name"
            value={form.fullName}
            onChange={(event) => update("fullName", event.target.value)}
            error={errors.fullName}
            required
            className="sm:col-span-2"
          />

          <Input
            label="Mobile number"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            value={form.phone}
            onChange={(event) => update("phone", event.target.value)}
            error={errors.phone}
            required
          />

          <Select
            label="Address type"
            options={[
              { value: "home", label: "Home" },
              { value: "work", label: "Work" },
            ]}
            value={form.type}
            onChange={(event) => update("type", event.target.value as FormState["type"])}
          />

          <Input
            label="Flat, house no., building"
            autoComplete="address-line1"
            value={form.line1}
            onChange={(event) => update("line1", event.target.value)}
            error={errors.line1}
            required
            className="sm:col-span-2"
          />

          <Input
            label="Area, street, landmark"
            autoComplete="address-line2"
            value={form.line2}
            onChange={(event) => update("line2", event.target.value)}
            className="sm:col-span-2"
          />

          <Input
            label="City"
            autoComplete="address-level2"
            value={form.city}
            onChange={(event) => update("city", event.target.value)}
            error={errors.city}
            required
          />

          <Input
            label="PIN code"
            inputMode="numeric"
            autoComplete="postal-code"
            value={form.pincode}
            onChange={(event) => update("pincode", event.target.value)}
            error={errors.pincode}
            required
          />

          <Select
            label="State"
            autoComplete="address-level1"
            options={STATES.map((state) => ({ value: state, label: state }))}
            value={form.state}
            onChange={(event) => update("state", event.target.value)}
            className="sm:col-span-2"
          />
        </div>

        {/* ------------------------------------------------- billing address */}
        <fieldset className="mt-10 max-w-2xl">
          <legend className="label-wide mb-1 text-ink-700">Billing address</legend>
          <p className="mb-3 text-xs leading-relaxed text-ink-500">
            This is the address that appears on your invoice. It also decides how
            tax is applied to the order.
          </p>

          <Checkbox
            label="Billing address is the same as the delivery address"
            checked={billingSame}
            onChange={(event) => {
              setBillingSame(event.target.checked);
              // Pre-fill from what has already been typed, so unticking the
              // box asks for edits rather than for the whole address again.
              if (!event.target.checked) {
                setBilling((current) =>
                  current.line1
                    ? current
                    : {
                        ...current,
                        fullName: form.fullName,
                        phone: form.phone,
                        email: contact.email,
                        city: form.city,
                        state: form.state,
                        postalCode: form.pincode,
                      },
                );
              }
            }}
          />

          {!billingSame ? (
            <div className="mt-5 grid gap-5 rounded-card border border-ink-200 bg-shell p-5 sm:grid-cols-2">
              <Input
                label="Full name"
                autoComplete="billing name"
                value={billing.fullName}
                onChange={(event) => updateBilling("fullName", event.target.value)}
                error={billingErrors.fullName}
                required
                className="sm:col-span-2"
              />

              <Input
                label="Email"
                type="email"
                autoComplete="billing email"
                value={billing.email}
                onChange={(event) => updateBilling("email", event.target.value)}
                error={billingErrors.email}
                required
              />

              <Input
                label="Mobile number"
                type="tel"
                inputMode="numeric"
                autoComplete="billing tel"
                value={billing.phone}
                onChange={(event) => updateBilling("phone", event.target.value)}
                error={billingErrors.phone}
                required
              />

              <Input
                label="Flat, house no., building"
                autoComplete="billing address-line1"
                value={billing.line1}
                onChange={(event) => updateBilling("line1", event.target.value)}
                error={billingErrors.line1}
                required
                className="sm:col-span-2"
              />

              <Input
                label="Area, street, landmark"
                autoComplete="billing address-line2"
                value={billing.line2}
                onChange={(event) => updateBilling("line2", event.target.value)}
                className="sm:col-span-2"
              />

              <Input
                label="City"
                autoComplete="billing address-level2"
                value={billing.city}
                onChange={(event) => updateBilling("city", event.target.value)}
                error={billingErrors.city}
                required
              />

              <Input
                label="PIN code"
                inputMode="numeric"
                autoComplete="billing postal-code"
                value={billing.postalCode}
                onChange={(event) => updateBilling("postalCode", event.target.value)}
                error={billingErrors.postalCode}
                required
              />

              <Select
                label="State"
                autoComplete="billing address-level1"
                options={STATES.map((state) => ({ value: state, label: state }))}
                value={billing.state}
                onChange={(event) => updateBilling("state", event.target.value)}
              />

              <Select
                label="Country"
                autoComplete="billing country-name"
                options={[{ value: "India", label: "India" }]}
                value={billing.country}
                onChange={(event) => updateBilling("country", event.target.value)}
              />
            </div>
          ) : null}
        </fieldset>

        {/* ------------------------------------------------ delivery method */}
        <fieldset className="mt-10 max-w-2xl">
          <legend className="label-wide mb-3 text-ink-700">Delivery method</legend>
          <div className="flex flex-col gap-2.5">
            {DELIVERY_METHODS.map((method) => (
              <Radio
                key={method.id}
                name="delivery"
                value={method.id}
                checked={deliveryMethodId === method.id}
                onChange={() => setDeliveryMethod(method.id as DeliveryMethodId)}
                label={
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>{method.name}</span>
                    <span className="text-xs text-ink-500 tabular-nums">
                      {method.estimate}
                      {/* Standard's threshold is covered by its description;
                          an upgrade is priced as an explicit addition. */}
                      {method.id === "standard" ? "" : ` · +${formatPrice(method.fee)}`}
                    </span>
                  </span>
                }
                description={method.description}
              />
            ))}
          </div>
        </fieldset>

        <Button type="submit" size="lg" className="mt-8 sm:w-auto" fullWidth>
          Continue to payment
        </Button>
      </form>
    </CheckoutShell>
  );
}
