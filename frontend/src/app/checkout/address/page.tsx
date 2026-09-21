"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { Address, DeliveryMethodId } from "@/types";

import { CheckoutShell } from "@/components/checkout/CheckoutShell";
import { Button } from "@/components/ui/Button";
import { Input, Radio, Select } from "@/components/ui/Field";
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

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saved, setSaved] = useState<Address[]>([]);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

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

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setAddress({ ...form, phone: form.phone.replace(/\D/g, "") });
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
