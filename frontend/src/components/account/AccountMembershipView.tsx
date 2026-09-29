"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check } from "lucide-react";

import { AccountShell } from "@/components/account/AccountShell";
import { EmptyState, ErrorState } from "@/components/common/States";
import {
  MembershipStatusPill,
  benefitLines,
  isUpcoming,
} from "@/components/membership/MembershipView";
import { ButtonLink } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useConfirmedCustomer } from "@/hooks/useSession";
import { formatMoney } from "@/lib/money";
import { formatDate, formatPrice } from "@/lib/utils/format";
import {
  getMyMembership,
  type MembershipSummary,
  type MyMembership,
} from "@/services/membershipService";

/**
 * The customer's membership, inside the account area.
 *
 * What they have, how long it runs, what it has saved them so far, and every
 * plan they have held. Joining and extending happen on the membership page,
 * where the plans are.
 */
export function AccountMembershipView() {
  const signedIn = useConfirmedCustomer();
  const [data, setData] = useState<MyMembership | null>(null);
  const [failed, setFailed] = useState(false);

  // State is set only once the answer arrives, never synchronously.
  const load = useCallback(
    () =>
      getMyMembership().then(
        (value) => {
          setData(value);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [],
  );

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  const name = data?.programme.name;
  const current = data?.membership ?? null;
  const history = data?.history ?? [];

  return (
    <AccountShell
      title="Membership"
      description={name ? `Your ${name} benefits and savings.` : "Your membership benefits and savings."}
      breadcrumb={[{ label: "Membership" }]}
    >
      <div aria-live="polite" aria-busy={!data && !failed}>
        {failed && !data ? (
          <ErrorState
            description="We couldn't load your membership just now. Please try again."
            onRetry={() => void load()}
          />
        ) : !data ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            {current ? (
              <CurrentMembership membership={current} programmeName={data.programme.name} />
            ) : data.programme.enabled ? (
              <div className="rounded-card border border-ink-200 bg-shell">
                <EmptyState
                  title={`You're not a ${data.programme.name} member yet`}
                  description={
                    data.programme.tagline ||
                    "Join for free delivery, extra savings on every order and more."
                  }
                  action={{ label: `Explore ${data.programme.name}`, href: "/membership" }}
                  className="py-12 sm:py-14"
                />
              </div>
            ) : (
              <div className="rounded-card border border-ink-200 bg-shell">
                <EmptyState
                  title="Membership opens soon"
                  description={`We're putting the finishing touches to ${data.programme.name}. Check back shortly.`}
                  className="py-12 sm:py-14"
                />
              </div>
            )}

            {history.length > 0 ? (
              <section aria-labelledby="membership-history" className="mt-8 sm:mt-10">
                <h2 id="membership-history" className="font-display text-lg text-ink">
                  Membership history
                </h2>
                <ul className="mt-4 divide-y divide-ink-100 rounded-card border border-ink-200 bg-shell">
                  {history.map((entry) => (
                    <HistoryRow key={entry.id} entry={entry} isCurrent={entry.id === current?.id} />
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </AccountShell>
  );
}

/* --------------------------------------------------------------- current */

function CurrentMembership({
  membership,
  programmeName,
}: {
  membership: MembershipSummary;
  programmeName: string;
}) {
  const benefits = membership.benefits;
  const lines = benefitLines(benefits);
  const active = membership.status === "active";

  const deliveriesLeft = !benefits.freeDelivery
    ? null
    : membership.freeDeliveriesLeftThisMonth !== null
      ? String(membership.freeDeliveriesLeftThisMonth)
      : benefits.freeDeliveriesPerMonth
        ? null
        : "Unlimited";

  return (
    <section
      aria-labelledby="current-membership"
      className="rounded-card border border-copper-200 bg-copper-50 p-5 sm:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label-wide text-copper-700">{programmeName}</p>
          <h2 id="current-membership" className="mt-2.5 font-display text-xl text-ink sm:text-2xl">
            {membership.planName}
          </h2>
          <p className="mt-1.5 text-sm text-ink-600">
            {active
              ? `Member since ${formatDate(membership.startsAt)} · benefits run until ${formatDate(membership.endsAt)}`
              : `Ended ${formatDate(membership.endsAt)}`}
          </p>
        </div>
        <MembershipStatusPill status={membership.status} />
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-copper-200 pt-5 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-500">Saved on orders</dt>
          <dd className="mt-1 font-display text-lg text-ink">{formatPrice(membership.savedOnOrders)}</dd>
        </div>
        {benefits.freeDelivery ? (
          <div>
            <dt className="text-xs text-ink-500">Orders delivered free</dt>
            <dd className="mt-1 font-display text-lg text-ink">{membership.freeDeliveryOrders}</dd>
          </div>
        ) : null}
        {active && deliveriesLeft !== null ? (
          <div>
            <dt className="text-xs text-ink-500">Free deliveries left this month</dt>
            <dd className="mt-1 font-display text-lg text-ink">{deliveriesLeft}</dd>
          </div>
        ) : null}
      </dl>

      {lines.length > 0 ? (
        <div className="mt-6 border-t border-copper-200 pt-5">
          <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-500">
            Your benefits
          </h3>
          <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {lines.map((line) => (
              <li key={line} className="flex gap-2.5 text-sm leading-snug text-ink-700">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-sage-600" strokeWidth={2} aria-hidden="true" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <ButtonLink href="/membership" variant="primary" className="gap-2">
          Extend your membership
          <ArrowRight className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
        </ButtonLink>
        <p className="text-xs leading-relaxed text-ink-500">
          Extra time is added after your current membership ends.
        </p>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- history */

function HistoryRow({ entry, isCurrent }: { entry: MembershipSummary; isCurrent: boolean }) {
  const upcoming = isUpcoming(entry);

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">
          {entry.planName}
          {isCurrent ? <span className="ml-2 text-xs font-normal text-copper-700">Current</span> : null}
        </p>
        <p className="mt-0.5 text-xs text-ink-500">
          {formatDate(entry.startsAt)} – {formatDate(entry.endsAt)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
        <span className="text-sm tabular-nums text-ink-700">{formatMoney(entry.amount)}</span>
        {entry.savedOnOrders > 0 ? (
          <span className="text-xs text-sage-700">Saved {formatPrice(entry.savedOnOrders)}</span>
        ) : null}
        <MembershipStatusPill status={entry.status} upcoming={upcoming} />
      </div>
    </li>
  );
}
