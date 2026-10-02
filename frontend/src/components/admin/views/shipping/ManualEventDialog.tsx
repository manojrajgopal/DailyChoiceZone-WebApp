"use client";

import { useState } from "react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea, AdminToggle } from "@/components/admin/ui/AdminForm";
import { Modal } from "@/components/ui/Dialog";
import { problem } from "@/components/admin/views/operations/shared";
import { addShipmentEvent } from "@/services/shippingService";
import { toast } from "@/store/toastStore";
import { SHIPMENT_STATUSES, SHIPMENT_STATUS_LABELS, type Shipment } from "@/types/shipping";

/** Statuses staff can record by hand. Cancelling has its own action. */
const RECORDABLE = SHIPMENT_STATUSES.filter((status) => status !== "pending" && status !== "cancelled");

/** Now, as a `datetime-local` value in the browser's clock. */
function localNow(): string {
  const now = new Date();
  now.setSeconds(0, 0);
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

interface Errors {
  status?: string;
  occurredAt?: string;
  description?: string;
  location?: string;
}

/**
 * Record a tracking event by hand — for Manual couriers, or a courier that
 * told the team something its API didn't. It moves the shipment (and the
 * order) exactly like a courier event, so it asks once more before saving.
 */
export function ManualEventDialog({
  shipment,
  open,
  onOpenChange,
  onSaved,
}: {
  shipment: Shipment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (shipment: Shipment) => void;
}) {
  const [status, setStatus] = useState("");
  const [occurredAt, setOccurredAt] = useState(localNow);
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [visible, setVisible] = useState(true);
  const [errors, setErrors] = useState<Errors>({});
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");

  const validate = (): boolean => {
    const next: Errors = {};
    if (!status) next.status = "Choose what happened.";
    const when = occurredAt ? new Date(occurredAt) : null;
    if (!when || Number.isNaN(when.getTime())) next.occurredAt = "Enter when it happened.";
    else if (when.getTime() > Date.now() + 5 * 60_000) next.occurredAt = "This can't be in the future.";
    if (description.trim().length > 500) next.description = "At most 500 characters.";
    if (location.trim().length > 120) next.location = "At most 120 characters.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = async () => {
    setSaving(true);
    setServerError("");
    try {
      const updated = await addShipmentEvent(shipment.id, {
        status,
        description: description.trim(),
        location: location.trim(),
        occurredAt: new Date(occurredAt).toISOString(),
        visible,
      });
      toast.success(`Recorded “${SHIPMENT_STATUS_LABELS[status as keyof typeof SHIPMENT_STATUS_LABELS] ?? status}”.`);
      onSaved(updated);
      onOpenChange(false);
    } catch (error) {
      setServerError(problem(error, "The event wasn't recorded. Please try again."));
      setStep("form");
    } finally {
      setSaving(false);
    }
  };

  const label = SHIPMENT_STATUS_LABELS[status as keyof typeof SHIPMENT_STATUS_LABELS] ?? status;

  return (
    <Modal open={open} onOpenChange={(next) => !saving && onOpenChange(next)} title="Record a tracking event" className="max-w-lg">
      {step === "form" ? (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (validate()) setStep("confirm");
          }}
        >
          {serverError ? (
            <p role="alert" className="rounded-[3px] bg-[#fbeaea] px-3 py-2 text-xs text-[#a12b2b]">
              {serverError}
            </p>
          ) : null}
          <AdminSelect
            label="What happened"
            required
            placeholder="Choose a status"
            value={status}
            error={errors.status}
            onChange={(event) => setStatus(event.target.value)}
            options={RECORDABLE.map((value) => ({ value, label: SHIPMENT_STATUS_LABELS[value] }))}
          />
          <AdminInput
            label="When"
            type="datetime-local"
            required
            value={occurredAt}
            error={errors.occurredAt}
            max={localNow()}
            onChange={(event) => setOccurredAt(event.target.value)}
          />
          <AdminInput
            label="Location"
            value={location}
            error={errors.location}
            placeholder="e.g. Bengaluru Hub"
            onChange={(event) => setLocation(event.target.value)}
          />
          <AdminTextarea
            label="Description"
            rows={3}
            value={description}
            error={errors.description}
            hint="Optional. Shown to the customer when the event is visible."
            onChange={(event) => setDescription(event.target.value)}
          />
          <AdminToggle
            label="Show to the customer"
            description="Off keeps it on this page only."
            checked={visible}
            onChange={setVisible}
          />
          <div className="flex justify-end gap-2">
            <AdminButton variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" variant="primary">
              Continue
            </AdminButton>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-admin-muted">
            Record <strong className="text-admin-ink">{label}</strong> for {shipment.shipmentNumber}? It moves the shipment — and the order,
            when it&rsquo;s a step forward — exactly as a courier update would, and the customer may be emailed.
          </p>
          <div className="flex justify-end gap-2">
            <AdminButton variant="secondary" disabled={saving} onClick={() => setStep("form")}>
              Back
            </AdminButton>
            <AdminButton variant="primary" loading={saving} onClick={() => void save()}>
              Record event
            </AdminButton>
          </div>
        </div>
      )}
    </Modal>
  );
}
