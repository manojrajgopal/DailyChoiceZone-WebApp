"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";

import type { MemberPerks } from "@/services/cartService";

import { apiGet } from "@/services/api/client";

interface Programme {
  name: string;
  enabled: boolean;
  plans: { price: number; durationMonths: number; freeDelivery: boolean; memberDiscountPercent: number }[];
}

let programme: Promise<Programme | null> | null = null;

function loadProgramme(): Promise<Programme | null> {
  programme ??= apiGet<Programme>("/memberships").catch(() => {
    programme = null;
    return null;
  });
  return programme;
}

/**
 * The membership, beside the order summary.
 *
 * A member sees what it is doing for this bag. Anyone else sees one quiet line
 * inviting them to join — only when the programme is open and has a plan.
 */
export function MemberPerksNote({ membership }: { membership: MemberPerks | null }) {
  const [offer, setOffer] = useState<Programme | null>(null);

  useEffect(() => {
    if (membership) return;
    let active = true;
    void loadProgramme().then((result) => {
      if (active) setOffer(result);
    });
    return () => {
      active = false;
    };
  }, [membership]);

  if (membership) {
    const perks = [
      membership.discountPercent > 0 ? `${membership.discountPercent}% member savings` : null,
      membership.freeDelivery ? "free delivery" : null,
    ].filter(Boolean);
    return (
      <div className="flex items-start gap-2.5 rounded-card border border-sage-200 bg-sage-50 px-3.5 py-3">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-sage-600" strokeWidth={1.5} aria-hidden="true" />
        <p className="text-xs leading-relaxed text-ink-700">
          <span className="font-medium text-ink">{membership.name} member</span>
          {perks.length ? ` — ${perks.join(" and ")} applied to this order.` : "."}
          {membership.freeDeliveriesLeft !== null && membership.freeDeliveriesLeft >= 0 ? (
            <span className="mt-0.5 block text-ink-500">
              {membership.freeDeliveriesLeft === 0
                ? "You've used this month's free deliveries."
                : `${membership.freeDeliveriesLeft} free ${membership.freeDeliveriesLeft === 1 ? "delivery" : "deliveries"} left this month.`}
            </span>
          ) : null}
        </p>
      </div>
    );
  }

  if (!offer?.enabled || !offer.plans.length) return null;
  const cheapest = [...offer.plans].sort((a, b) => a.price / a.durationMonths - b.price / b.durationMonths)[0]!;
  const best = Math.max(...offer.plans.map((plan) => plan.memberDiscountPercent));

  return (
    <Link
      href="/membership"
      className="group flex items-center justify-between gap-3 rounded-card border border-copper-200 bg-copper-50 px-3.5 py-3 transition-colors hover:border-copper-400"
    >
      <span className="flex items-start gap-2.5">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-copper-700" strokeWidth={1.5} aria-hidden="true" />
        <span className="text-xs leading-relaxed text-ink-700">
          <span className="font-medium text-ink">Join {offer.name}</span>
          {" — "}
          {cheapest.freeDelivery ? "free delivery" : "member benefits"}
          {best > 0 ? ` and ${best}% off every order` : ""}, from{" "}
          ₹{Math.round(cheapest.price / cheapest.durationMonths).toLocaleString("en-IN")}/month.
        </span>
      </span>
      <ArrowRight
        className="h-4 w-4 shrink-0 text-copper-700 transition-transform group-hover:translate-x-0.5"
        strokeWidth={1.5}
        aria-hidden="true"
      />
    </Link>
  );
}
