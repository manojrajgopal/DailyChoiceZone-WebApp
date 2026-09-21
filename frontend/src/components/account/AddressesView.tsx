"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";

import type { Address } from "@/types";

import { AccountShell } from "@/components/account/AccountShell";
import { EmptyState } from "@/components/common/States";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Checkbox, Input, Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { useSession } from "@/hooks/useSession";
import {
  deleteAddress,
  getAddresses,
  saveAddress,
  setDefaultAddress,
} from "@/services/accountService";
import { toast } from "@/store/toastStore";

const STATES = [
  "Karnataka", "Maharashtra", "Delhi", "Tamil Nadu", "Telangana", "Gujarat",
  "West Bengal", "Rajasthan", "Kerala", "Uttar Pradesh", "Punjab", "Haryana",
  "Madhya Pradesh", "Bihar", "Odisha", "Assam",
];

type FormState = Omit<Address, "id"> & { id?: string };

const EMPTY_FORM: FormState = {
  fullName: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  state: "Karnataka",
  pincode: "",
  type: "home",
  isDefault: false,
};

/** Saved address book: add, edit, delete and choose a default. */
export function AddressesView() {
  const { isSignedIn } = useSession();

  const [addresses, setAddresses] = useState<Address[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  const refresh = useCallback(async () => {
    const result = await getAddresses();
    setAddresses(result);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (!isSignedIn) return;
    void refresh();
  }, [isSignedIn, refresh]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setEditing((current) => (current ? { ...current, [key]: value } : current));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;

    const next: Partial<Record<keyof FormState, string>> = {};
    if (editing.fullName.trim().length < 2) next.fullName = "Enter a full name.";
    if (!/^[6-9]\d{9}$/.test(editing.phone.replace(/\D/g, ""))) {
      next.phone = "Enter a 10-digit mobile number.";
    }
    if (editing.line1.trim().length < 5) next.line1 = "Enter the house or flat and street.";
    if (editing.city.trim().length < 2) next.city = "Enter a city.";
    if (!/^[1-9]\d{5}$/.test(editing.pincode.trim())) next.pincode = "Enter a valid PIN code.";

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    await saveAddress({ ...editing, phone: editing.phone.replace(/\D/g, "") });
    await refresh();
    setEditing(null);
    toast.success(editing.id ? "Address updated" : "Address saved");
  };

  const onDelete = async (address: Address) => {
    await deleteAddress(address.id);
    await refresh();
    toast.info("Address removed");
  };

  const onMakeDefault = async (address: Address) => {
    await setDefaultAddress(address.id);
    await refresh();
    toast.success("Default address updated");
  };

  return (
    <AccountShell
      title="Saved addresses"
      description="Addresses you save here are offered at checkout."
      breadcrumb={[{ label: "Addresses" }]}
    >
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : addresses.length === 0 ? (
        <EmptyState
          title="No saved addresses"
          description="Add one here, or it will be saved automatically the first time you check out."
          secondaryAction={{ label: "Add an address", onClick: () => setEditing(EMPTY_FORM) }}
        />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2">
            {addresses.map((address) => (
              <li
                key={address.id}
                className="flex flex-col rounded-card border border-ink-200 bg-shell p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium text-ink">{address.fullName}</p>
                  <div className="flex shrink-0 gap-1.5">
                    <Badge tone="neutral">{address.type}</Badge>
                    {address.isDefault ? <Badge tone="stock">Default</Badge> : null}
                  </div>
                </div>

                <div className="mt-2 text-sm leading-relaxed text-ink-700">
                  <p>
                    {address.line1}
                    {address.line2 ? `, ${address.line2}` : ""}
                  </p>
                  <p className="mt-0.5">
                    {address.city}, {address.state} {address.pincode}
                  </p>
                  <p className="mt-0.5">+91 {address.phone}</p>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing({ ...address })}
                    className="px-2.5"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                    Edit
                  </Button>

                  {!address.isDefault ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void onMakeDefault(address)}
                      className="px-2.5"
                    >
                      <Check className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Make default
                    </Button>
                  ) : null}

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void onDelete(address)}
                    aria-label={`Delete address for ${address.fullName}`}
                    className="ml-auto px-2.5 hover:bg-danger-bg hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          <Button variant="outline" className="mt-6" onClick={() => setEditing(EMPTY_FORM)}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Add a new address
          </Button>
        </>
      )}

      {/* ------------------------------------------------------ edit modal */}
      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setErrors({});
          }
        }}
        title={editing?.id ? "Edit address" : "Add a new address"}
        className="max-w-xl"
      >
        {editing ? (
          <form onSubmit={onSubmit}>
            <div className="grid gap-5 sm:grid-cols-2">
              <Input
                label="Full name"
                autoComplete="name"
                value={editing.fullName}
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
                value={editing.phone}
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
                value={editing.type}
                onChange={(event) => update("type", event.target.value as Address["type"])}
              />

              <Input
                label="Flat, house no., building"
                autoComplete="address-line1"
                value={editing.line1}
                onChange={(event) => update("line1", event.target.value)}
                error={errors.line1}
                required
                className="sm:col-span-2"
              />

              <Input
                label="Area, street, landmark"
                autoComplete="address-line2"
                value={editing.line2}
                onChange={(event) => update("line2", event.target.value)}
                className="sm:col-span-2"
              />

              <Input
                label="City"
                autoComplete="address-level2"
                value={editing.city}
                onChange={(event) => update("city", event.target.value)}
                error={errors.city}
                required
              />

              <Input
                label="PIN code"
                inputMode="numeric"
                autoComplete="postal-code"
                value={editing.pincode}
                onChange={(event) => update("pincode", event.target.value)}
                error={errors.pincode}
                required
              />

              <Select
                label="State"
                autoComplete="address-level1"
                options={STATES.map((state) => ({ value: state, label: state }))}
                value={editing.state}
                onChange={(event) => update("state", event.target.value)}
                className="sm:col-span-2"
              />
            </div>

            <Checkbox
              label="Use this as my default address"
              checked={editing.isDefault}
              onChange={(event) => update("isDefault", event.target.checked)}
              className="mt-4"
            />

            <div className="mt-6 flex gap-2">
              <Button
                type="button"
                variant="outline"
                fullWidth
                onClick={() => {
                  setEditing(null);
                  setErrors({});
                }}
              >
                Cancel
              </Button>
              <Button type="submit" fullWidth>
                {editing.id ? "Save changes" : "Save address"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </AccountShell>
  );
}
