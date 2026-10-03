"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import type { AdminCoupon, AdminCustomer } from "@/types/admin";

import { AdminCheckbox, AdminInput, AdminSelect } from "@/components/admin/ui/AdminForm";
import { listCustomers } from "@/services/admin/customerAdminService";
import { listSegments } from "@/services/segmentsService";
import type { SegmentSummary } from "@/types/segments";

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
 */
export function CouponAudienceFields({
  coupon,
  onChange,
}: {
  coupon: AdminCoupon;
  onChange: (next: AdminCoupon) => void;
}) {
  const audience = coupon.audience ?? "everyone";
  const chosen = useMemo(() => coupon.customerIds ?? [], [coupon.customerIds]);

  const [customers, setCustomers] = useState<AdminCustomer[] | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (audience !== "selected" || customers) return;
    let active = true;
    void listCustomers()
      .then((rows) => active && setCustomers(rows))
      .catch(() => active && setCustomers([]));
    return () => {
      active = false;
    };
  }, [audience, customers]);

  // Customer segmentation: the active segments, fetched once "segment" is chosen.
  const [segments, setSegments] = useState<SegmentSummary[] | null>(null);
  const [segmentsFailed, setSegmentsFailed] = useState(false);
  useEffect(() => {
    if (audience !== "segment" || segments) return;
    let active = true;
    void listSegments({ status: "active", pageSize: 100 })
      .then((page) => active && setSegments(page.items))
      .catch(() => {
        if (!active) return;
        setSegments([]);
        setSegmentsFailed(true);
      });
    return () => {
      active = false;
    };
  }, [audience, segments]);

  const byId = useMemo(() => new Map((customers ?? []).map((c) => [c.id, c])), [customers]);
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term || !customers) return [];
    return customers
      .filter((c) => !chosen.includes(c.id))
      .filter((c) =>
        `${c.firstName} ${c.lastName} ${c.email} ${c.phone}`.toLowerCase().includes(term),
      )
      .slice(0, 8);
  }, [search, customers, chosen]);

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
        <AdminSelect
          label="Segment"
          value={coupon.segmentId ? String(coupon.segmentId) : ""}
          onChange={(event) =>
            onChange({ ...coupon, segmentId: event.target.value ? Number(event.target.value) : null })
          }
          disabled={!segments}
          placeholder={segments ? "Choose a segment" : "Loading segments…"}
          options={[
            ...(segments ?? []).map((segment) => ({
              value: String(segment.id),
              label: `${segment.name} (${segment.memberCount.toLocaleString("en-IN")})`,
            })),
            // Keep a chosen segment visible even if it isn't in the active list (archived since).
            ...(coupon.segmentId && segments && !segments.some((segment) => segment.id === coupon.segmentId)
              ? [{ value: String(coupon.segmentId), label: coupon.segmentName || `Segment #${coupon.segmentId}` }]
              : []),
          ]}
          error={
            segmentsFailed
              ? "Segments didn't load. Your role may not include segments."
              : segments && !coupon.segmentId
                ? "Choose a segment."
                : undefined
          }
          hint="Segments are managed under Customers → Segments."
        />
      ) : null}

      {audience === "selected" ? (
        <div className="sm:col-span-2">
          <AdminInput
            label="Add customers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={customers ? "Search by name, email or phone" : "Loading customers…"}
            disabled={!customers}
          />
          {matches.length ? (
            <ul className="mt-1 max-h-48 overflow-y-auto rounded-[3px] border border-admin-border bg-admin-surface">
              {matches.map((customer) => (
                <li key={customer.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange({ ...coupon, customerIds: [...chosen, customer.id] });
                      setSearch("");
                    }}
                    className="flex w-full items-center justify-between gap-3 px-2.5 py-2 text-left text-xs hover:bg-admin-raised"
                  >
                    <span className="text-admin-ink">
                      {customer.firstName} {customer.lastName}
                    </span>
                    <span className="truncate text-admin-muted">{customer.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Selected customers">
            {chosen.map((id) => {
              const customer = byId.get(id);
              return (
                <li key={id}>
                  <span className="inline-flex items-center gap-1.5 rounded-[3px] bg-admin-raised px-2 py-1 text-[0.6875rem] text-admin-ink ring-1 ring-inset ring-admin-border">
                    {customer ? `${customer.firstName} ${customer.lastName}` : id}
                    <button
                      type="button"
                      onClick={() =>
                        onChange({ ...coupon, customerIds: chosen.filter((entry) => entry !== id) })
                      }
                      aria-label={`Remove ${customer?.firstName ?? id}`}
                      className="text-admin-faint hover:text-[#c23434]"
                    >
                      <X className="h-3 w-3" strokeWidth={2} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
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
