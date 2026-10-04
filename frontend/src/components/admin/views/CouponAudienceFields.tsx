"use client";

import type { AdminCoupon } from "@/types/admin";

import { AdminCheckbox, AdminInput, AdminSelect } from "@/components/admin/ui/AdminForm";
import { IdMultiSelect } from "@/components/common/IdMultiSelect";
import { IdSelector } from "@/components/common/IdSelector";

const AUDIENCES = [
  { value: "everyone", label: "Everyone" },
  { value: "selected", label: "Selected customers only" },
  { value: "members", label: "Members only" },
  { value: "first-order", label: "First order only" },
  { value: "segment", label: "Customers in a segment" },
];

/**
 * Who may use a coupon, and how often.
 *
 * - **Limit per customer** — each person may redeem it this many times.
 * - **Total limit** (in the main form) — all customers together.
 * Both may be set: "each customer once, 1,000 in all".
 *
 * Customers and the segment are chosen by ID (docs/id-lookup.md); their names
 * show in the preview once picked.
 */
export function CouponAudienceFields({
  coupon,
  onChange,
}: {
  coupon: AdminCoupon;
  onChange: (next: AdminCoupon) => void;
}) {
  const audience = coupon.audience ?? "everyone";
  const chosen = coupon.customerIds ?? [];

  return (
    <>
      <AdminInput
        label="Limit per customer"
        type="number"
        min={0}
        value={coupon.perCustomerLimit ?? ""}
        onChange={(event) =>
          onChange({
            ...coupon,
            perCustomerLimit: event.target.value === "" ? null : Number(event.target.value),
          })
        }
        hint="How many times each customer may use it. Blank for no limit."
      />

      <AdminSelect
        label="Who can use it"
        value={audience}
        onChange={(event) => {
          const next = event.target.value as AdminCoupon["audience"];
          // A segment only means something for the "segment" audience.
          onChange({ ...coupon, audience: next, ...(next !== "segment" && coupon.segmentId ? { segmentId: null } : {}) });
        }}
        options={AUDIENCES}
        hint={
          audience === "members"
            ? "Only customers with an active membership."
            : audience === "first-order"
              ? "Only customers who haven't ordered before."
              : audience === "selected"
                ? "Only the customers you pick below."
                : audience === "segment"
                  ? "Only signed-in customers who match the segment's rules when they apply the code."
                  : "Any shopper."
        }
      />

      {audience === "segment" ? (
        <div>
          <IdSelector
            entity="segment"
            label="Segment"
            value={coupon.segmentId ? String(coupon.segmentId) : null}
            onChange={(id, preview) =>
              onChange({
                ...coupon,
                segmentId: id ? Number(id) : null,
                ...(preview?.title ? { segmentName: preview.title } : {}),
              })
            }
            hint="Segments are managed under Customers → Segments."
          />
          {!coupon.segmentId ? (
            <p className="mt-1.5 text-[0.6875rem] text-[#9c4a24]">Choose a segment.</p>
          ) : null}
        </div>
      ) : null}

      {audience === "selected" ? (
        <div className="sm:col-span-2">
          <IdMultiSelect
            entity="customer"
            label="Customer ID"
            hint="Add each customer who may use it."
            values={chosen}
            onChange={(customerIds) => onChange({ ...coupon, customerIds })}
          />
          {!chosen.length ? (
            <p className="mt-1.5 text-[0.6875rem] text-[#9c4a24]">Pick at least one customer.</p>
          ) : null}
        </div>
      ) : null}

      <AdminCheckbox
        label="Show in the store"
        description="List it for eligible shoppers in the bag and at checkout. Turn off for private codes you share yourself."
        checked={coupon.showInStore ?? true}
        onChange={(event) => onChange({ ...coupon, showInStore: event.target.checked })}
        className="sm:col-span-2"
      />
    </>
  );
}
