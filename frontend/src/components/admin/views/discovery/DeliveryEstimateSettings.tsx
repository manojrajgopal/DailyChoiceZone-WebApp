"use client";

import { useEffect, useState } from "react";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminTextarea, FormGrid } from "@/components/admin/ui/AdminForm";
import { useAdminResource } from "@/hooks/useAdminResource";
import { ApiError } from "@/services/api/client";
import {
  getDeliverySettings,
  saveDeliveryEstimateSettings,
  type DeliveryEstimateSettings as Settings,
} from "@/services/admin/discoveryAdminService";
import { toast } from "@/store/toastStore";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * How the delivery estimate is worked out, on the pincode screen: when orders
 * stop going out the same day, how long they take to get ready, the days
 * parcels move, holidays, how long delivery takes where a pincode doesn't say,
 * and the most cash on delivery is offered for. The product page, the bag and
 * checkout all count from these.
 */
export function DeliveryEstimateSettings({ onSaved }: { onSaved?: () => void }) {
  const loaded = useAdminResource(() => getDeliverySettings(), []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [holidays, setHolidays] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loaded.data) return;
    setDraft(loaded.data);
    setHolidays(loaded.data.holidays.join("\n"));
  }, [loaded.data]);

  if (loaded.error && !draft) {
    return (
      <AdminCard title="Delivery estimates" className="mb-5">
        <p role="alert" className="text-xs text-admin-ink">
          {loaded.error instanceof ApiError ? loaded.error.message : "The delivery settings didn't load."}
        </p>
      </AdminCard>
    );
  }
  if (!draft) return null;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  const number = (value: string) => (value === "" ? 0 : Number(value));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveDeliveryEstimateSettings({
        dispatchCutoffHour: draft.dispatchCutoffHour,
        processingDays: draft.processingDays,
        standardMinDays: draft.standardMinDays,
        standardMaxDays: draft.standardMaxDays,
        expressMinDays: draft.expressMinDays,
        expressMaxDays: draft.expressMaxDays,
        workingDays: draft.workingDays,
        holidays: holidays.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
        codMaxOrderValue: draft.codMaxOrderValue,
      });
      setDraft(saved);
      setHolidays(saved.holidays.join("\n"));
      toast.success("Delivery estimate settings saved.");
      onSaved?.();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "The settings weren't saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminCard
      title="Delivery estimates"
      description="Used for the dates shown on product pages, in the bag and at checkout, and written on each order."
      className="mb-5"
    >
      <div className="flex flex-col gap-4">
        <FormGrid columns={3}>
          <AdminInput
            label="Same-day dispatch cutoff (hour, 0–23)"
            type="number"
            min={0}
            max={23}
            value={draft.dispatchCutoffHour ?? ""}
            onChange={(event) => set("dispatchCutoffHour", event.target.value === "" ? null : Number(event.target.value))}
            hint="Orders after this go out the next working day. Empty: no cutoff."
          />
          <AdminInput label="Processing days" type="number" min={0} max={30} value={draft.processingDays}
            onChange={(event) => set("processingDays", number(event.target.value))}
            hint="Working days to get an order ready." />
          <AdminInput
            label="Cash on delivery up to (₹)"
            type="number"
            min={1}
            value={draft.codMaxOrderValue ?? ""}
            onChange={(event) => set("codMaxOrderValue", event.target.value === "" ? null : Number(event.target.value))}
            hint="Empty: no limit."
          />
        </FormGrid>
        <FormGrid columns={2}>
          <div className="grid grid-cols-2 gap-2">
            <AdminInput label="Standard: fastest (days)" type="number" min={0} max={60} value={draft.standardMinDays}
              onChange={(event) => set("standardMinDays", number(event.target.value))} />
            <AdminInput label="Standard: slowest (days)" type="number" min={0} max={60} value={draft.standardMaxDays}
              onChange={(event) => set("standardMaxDays", number(event.target.value))} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <AdminInput label="Express: fastest (days)" type="number" min={0} max={30} value={draft.expressMinDays}
              onChange={(event) => set("expressMinDays", number(event.target.value))} />
            <AdminInput label="Express: slowest (days)" type="number" min={0} max={30} value={draft.expressMaxDays}
              onChange={(event) => set("expressMaxDays", number(event.target.value))} />
          </div>
        </FormGrid>
        <p className="-mt-2 text-[0.6875rem] text-admin-muted">
          In transit, for pincodes that don&rsquo;t set their own days.
        </p>
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-admin-ink">Days parcels move</legend>
          <div className="flex flex-wrap gap-x-4">
            {DAYS.map((label, day) => (
              <AdminCheckbox
                key={label}
                label={label}
                checked={draft.workingDays.includes(day)}
                onChange={(event) => set("workingDays", event.target.checked
                  ? [...draft.workingDays, day].sort()
                  : draft.workingDays.filter((d) => d !== day))}
              />
            ))}
          </div>
        </fieldset>
        <AdminTextarea
          label="Holidays"
          rows={3}
          value={holidays}
          onChange={(event) => setHolidays(event.target.value)}
          hint="One date per line, as YYYY-MM-DD. Nothing is dispatched or delivered on these."
        />
        <div className="flex justify-end">
          <AdminButton variant="primary" loading={saving} onClick={() => void save()}>Save estimate settings</AdminButton>
        </div>
      </div>
    </AdminCard>
  );
}
