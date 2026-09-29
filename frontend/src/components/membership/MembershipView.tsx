"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Headphones,
  Percent,
  RotateCcw,
  Sparkles,
  Truck,
} from "lucide-react";

import { EmptyState, ErrorState } from "@/components/common/States";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useCustomerStatus } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import {
  abandonMembershipCheckout,
  getMembershipOverview,
  startMembershipCheckout,
  verifyMembershipPayment,
  type MembershipBenefits,
  type MembershipOverview,
  type MembershipPlan,
  type MembershipStatus,
  type MembershipSummary,
} from "@/services/membershipService";
import { openRazorpayCheckout } from "@/services/payments/razorpayCheckout";
import { toast } from "@/store/toastStore";

/* ------------------------------------------------------------------ helpers */

/** `12` becomes "1 year", `3` becomes "3 months". */
export function durationLabel(months: number): string {
  if (months >= 12 && months % 12 === 0) {
    const years = months / 12;
    return `${years} ${years === 1 ? "year" : "years"}`;
  }
  return `${months} ${months === 1 ? "month" : "months"}`;
}

/** `7.5` becomes "7.5", `10` becomes "10". */
function percent(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Each benefit as one plain sentence, in the order shoppers care about. */
export function benefitLines(benefits: Partial<MembershipBenefits>): string[] {
  const lines: string[] = [];
  if (benefits.freeDelivery) {
    const allowance = benefits.freeDeliveriesPerMonth;
    lines.push(
      allowance
        ? `${allowance} free standard ${allowance === 1 ? "delivery" : "deliveries"} every month`
        : "Free standard delivery on every order",
    );
  }
  if (benefits.memberDiscountPercent && benefits.memberDiscountPercent > 0) {
    lines.push(`An extra ${percent(benefits.memberDiscountPercent)}% off every order`);
  }
  if (benefits.extraReturnDays && benefits.extraReturnDays > 0) {
    lines.push(
      `${benefits.extraReturnDays} extra ${benefits.extraReturnDays === 1 ? "day" : "days"} to return`,
    );
  }
  if (benefits.earlyAccess) lines.push("Early access to every sale");
  if (benefits.prioritySupport) lines.push("Priority customer care");
  return lines;
}

export const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  active: "Active",
  expired: "Ended",
  cancelled: "Cancelled",
  pending: "Awaiting payment",
};

const STATUS_TONE: Record<MembershipStatus, string> = {
  active: "bg-sage-50 text-sage-700 ring-sage-200",
  expired: "bg-ink-50 text-ink-500 ring-ink-200",
  cancelled: "bg-ink-50 text-ink-500 ring-ink-200",
  pending: "bg-copper-50 text-copper-700 ring-copper-200",
};

/** Whether an active membership is an extension that has not begun yet. */
export function isUpcoming(membership: MembershipSummary, now: number = Date.now()): boolean {
  return membership.status === "active" && new Date(membership.startsAt).getTime() > now;
}

export function MembershipStatusPill({
  status,
  upcoming = false,
}: {
  status: MembershipStatus;
  /** An active membership that starts later, after the current one. */
  upcoming?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-pill px-2.5 py-1 text-[0.6875rem] font-medium ring-1 ring-inset",
        upcoming ? STATUS_TONE.pending : (STATUS_TONE[status] ?? STATUS_TONE.expired),
      )}
    >
      {upcoming ? "Upcoming" : (MEMBERSHIP_STATUS_LABELS[status] ?? status)}
    </span>
  );
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** The programme's headline benefits, from the most generous of its plans. */
function highlights(plans: MembershipPlan[]) {
  const items: { icon: typeof Truck; title: string; text: string }[] = [];
  const delivery = plans.filter((plan) => plan.freeDelivery);
  if (delivery.length) {
    const unlimited = delivery.some((plan) => plan.freeDeliveriesPerMonth === null);
    items.push({
      icon: Truck,
      title: "Free delivery",
      text: unlimited
        ? "Standard delivery on us, on every order."
        : "Standard delivery on us, every month.",
    });
  }
  const discount = Math.max(0, ...plans.map((plan) => plan.memberDiscountPercent));
  if (discount > 0) {
    items.push({
      icon: Percent,
      title: `Up to ${percent(discount)}% off`,
      text: "An extra saving on every order, applied automatically at checkout.",
    });
  }
  const returnDays = Math.max(0, ...plans.map((plan) => plan.extraReturnDays));
  if (returnDays > 0) {
    items.push({
      icon: RotateCcw,
      title: "Longer returns",
      text: `Up to ${returnDays} extra days to decide.`,
    });
  }
  if (plans.some((plan) => plan.earlyAccess)) {
    items.push({
      icon: Sparkles,
      title: "Early access",
      text: "Shop every sale before it opens to everyone else.",
    });
  }
  if (plans.some((plan) => plan.prioritySupport)) {
    items.push({
      icon: Headphones,
      title: "Priority care",
      text: "Your questions go to the front of the queue.",
    });
  }
  return items;
}

/* --------------------------------------------------------------------- view */

const SIGN_IN_HREF = `/account?next=${encodeURIComponent("/membership")}`;

/**
 * The membership page.
 *
 * Plans come from the store, and so does the programme's name — an
 * administrator can rename it, so nothing here spells it out. A member sees
 * their own membership first and can extend it; buying again adds the new
 * plan's time after the current one ends.
 */
export function MembershipView() {
  const { isSignedIn, isPending } = useCustomerStatus();
  const [overview, setOverview] = useState<MembershipOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // State is set only once the answer arrives, never synchronously.
  const load = useCallback(
    () =>
      getMembershipOverview().then(
        (value) => {
          setOverview(value);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [],
  );

  // Wait for the session check, so a member's own membership is included.
  useEffect(() => {
    if (isPending) return;
    void load();
  }, [isPending, isSignedIn, load]);

  const join = async (plan: MembershipPlan) => {
    if (!overview || buying) return;
    const name = overview.name;
    setBuying(plan.id);
    setStatus(`Preparing your ${plan.name} plan…`);

    let membershipId: string | null = null;
    try {
      const checkout = await startMembershipCheckout(plan.id);
      membershipId = checkout.membershipId;

      if (!checkout.gateway) {
        setStatus(`Welcome to ${name}.`);
        toast.success(`Welcome to ${name}!`);
        await load();
        return;
      }

      setStatus("Complete your payment in the secure window.");
      const outcome = await openRazorpayCheckout(checkout.gateway, {});

      if (outcome.status === "completed") {
        setStatus("Confirming your payment…");
        try {
          await verifyMembershipPayment(checkout.membershipId, outcome.response);
          setStatus(`Welcome to ${name}.`);
          toast.success(`Welcome to ${name}!`);
          await load();
        } catch (error) {
          setStatus("");
          toast.error(
            messageOf(
              error,
              "We couldn't confirm your payment just yet. If money has left your account, it will be credited back or your membership activated shortly.",
            ),
          );
        }
        return;
      }

      await abandonMembershipCheckout(checkout.membershipId).catch(() => undefined);
      setStatus("");
      if (outcome.status === "failed") {
        toast.error(`${outcome.reason} You can try again whenever you're ready.`);
      } else {
        toast.info("Payment not completed — no money has been taken. You can join whenever you're ready.");
      }
    } catch (error) {
      if (membershipId) await abandonMembershipCheckout(membershipId).catch(() => undefined);
      setStatus("");
      toast.error(messageOf(error, "We couldn't start your membership just now. Please try again."));
    } finally {
      setBuying(null);
    }
  };

  /* ------------------------------------------------------------ loading */

  if (failed && !overview) {
    return (
      <div className="page-shell py-10">
        <ErrorState
          description="We couldn't load membership plans just now. Please try again."
          onRetry={() => void load()}
        />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="page-shell py-10 sm:py-14" aria-busy="true">
        <Skeleton className="mx-auto h-4 w-28" />
        <Skeleton className="mx-auto mt-5 h-10 w-72 max-w-full" />
        <Skeleton className="mx-auto mt-4 h-4 w-96 max-w-full" />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-96 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const { name, tagline, plans, membership } = overview;
  const open = overview.enabled && plans.length > 0;
  const perks = highlights(plans);
  const isMember = membership?.status === "active";

  return (
    <div>
      {/* ------------------------------------------------------------- hero */}
      <section className="border-b border-ink-100 bg-cream-deep">
        <div className="page-shell py-12 text-center sm:py-16 lg:py-20">
          <p className="label-wide text-copper-600">Membership</p>
          <h1 className="mt-4 font-display text-[2rem] leading-tight text-ink sm:text-4xl lg:text-5xl">
            {name}
          </h1>
          {tagline ? (
            <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-ink-600 sm:text-base">
              {tagline}
            </p>
          ) : null}
          {open && !isMember ? (
            <div className="mt-8 flex justify-center">
              <ButtonLink href="#plans" variant="primary" className="gap-2">
                See the plans
                <ArrowRight className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
              </ButtonLink>
            </div>
          ) : null}
        </div>
      </section>

      <div className="page-shell py-10 sm:py-14">
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>

        {membership ? <MemberCard membership={membership} programmeName={name} /> : null}

        {!open ? (
          <EmptyState
            title="Membership opens soon"
            description={`We're putting the finishing touches to ${name}. Check back shortly for plans made for the way you shop.`}
            action={{ label: "Continue shopping", href: "/shop" }}
            className={membership ? "mt-6" : undefined}
          />
        ) : (
          <>
            {/* ------------------------------------------------- highlights */}
            {perks.length > 0 && !isMember ? (
              <section aria-labelledby="membership-benefits">
                <h2 id="membership-benefits" className="sr-only">
                  What you get
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
                  {perks.map(({ icon: Icon, title, text }) => (
                    <li key={title} className="flex gap-3.5 rounded-card border border-ink-100 bg-shell p-5">
                      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-copper-50">
                        <Icon className="h-[1.125rem] w-[1.125rem] text-copper-600" strokeWidth={1.5} aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block font-display text-base text-ink">{title}</span>
                        <span className="mt-1 block text-[0.8125rem] leading-relaxed text-ink-500">
                          {text}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* ------------------------------------------------------ plans */}
            <section
              id="plans"
              aria-labelledby="membership-plans"
              className={cn("scroll-mt-24", (perks.length > 0 && !isMember) || membership ? "mt-12 sm:mt-16" : undefined)}
            >
              <div className="text-center">
                <h2 id="membership-plans" className="font-display text-2xl text-ink sm:text-[1.75rem]">
                  {isMember ? "Extend your membership" : "Choose your plan"}
                </h2>
                <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-ink-500">
                  {isMember
                    ? "Any plan you choose is added on after your current membership ends, so you never lose a day."
                    : "One simple payment, no automatic renewals. Your benefits begin the moment you join."}
                </p>
              </div>

              <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {plans.map((plan) => (
                  <li key={plan.id} className="min-w-0">
                    <PlanCard
                      plan={plan}
                      isMember={isMember}
                      signedIn={isSignedIn}
                      pending={isPending}
                      busy={buying === plan.id}
                      disabled={buying !== null && buying !== plan.id}
                      onJoin={() => void join(plan)}
                    />
                  </li>
                ))}
              </ul>

              {!isSignedIn && !isPending ? (
                <p className="mt-8 text-center text-sm text-ink-500">
                  Already have an account?{" "}
                  <Link href={SIGN_IN_HREF} className="text-copper-700 underline underline-offset-4 hover:text-copper-600">
                    Sign in
                  </Link>{" "}
                  to join.
                </p>
              ) : null}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- plan card */

function PlanCard({
  plan,
  isMember,
  signedIn,
  pending,
  busy,
  disabled,
  onJoin,
}: {
  plan: MembershipPlan;
  isMember: boolean;
  signedIn: boolean;
  pending: boolean;
  busy: boolean;
  disabled: boolean;
  onJoin: () => void;
}) {
  const lines = benefitLines(plan);
  const featured = Boolean(plan.badge);
  const showCompare = plan.compareAtPrice !== null && plan.compareAtPrice > plan.price;
  const actionLabel = isMember ? `Extend with ${plan.name}` : `Join ${plan.name}`;

  return (
    <article
      className={cn(
        "relative flex h-full flex-col rounded-card border bg-shell p-6 sm:p-7",
        featured ? "border-ink shadow-raised" : "border-ink-200",
      )}
    >
      {plan.badge ? (
        <span className="absolute -top-3 left-6 inline-flex items-center rounded-pill bg-ink px-3 py-1 label-wide text-cream sm:left-7">
          {plan.badge}
        </span>
      ) : null}

      <header>
        <h3 className="font-display text-xl text-ink">{plan.name}</h3>
        <p className="mt-1 text-xs uppercase tracking-[0.14em] text-ink-400">
          {durationLabel(plan.durationMonths)}
        </p>
      </header>

      <div className="mt-5">
        <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="font-display text-[2rem] leading-none text-ink">{formatPrice(plan.price)}</span>
          {showCompare ? (
            <span className="text-sm text-ink-400 line-through">
              <span className="sr-only">Usually </span>
              {formatPrice(plan.compareAtPrice!)}
            </span>
          ) : null}
        </p>
        {plan.durationMonths > 1 ? (
          <p className="mt-1.5 text-[0.8125rem] text-ink-500">
            That&rsquo;s {formatPrice(plan.pricePerMonth)} a month
          </p>
        ) : (
          <p className="mt-1.5 text-[0.8125rem] text-ink-500">Billed once, no renewal</p>
        )}
      </div>

      {plan.description ? (
        <p className="mt-4 text-sm leading-relaxed text-ink-600">{plan.description}</p>
      ) : null}

      {lines.length > 0 ? (
        <ul className="mt-5 flex flex-col gap-2.5 border-t border-ink-100 pt-5">
          {lines.map((line) => (
            <li key={line} className="flex gap-2.5 text-sm leading-snug text-ink-700">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-sage-600" strokeWidth={2} aria-hidden="true" />
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-auto pt-7">
        {!signedIn && !pending ? (
          <ButtonLink
            href={SIGN_IN_HREF}
            variant={featured ? "primary" : "outline"}
            fullWidth
            aria-label={`Sign in to join ${plan.name}`}
          >
            Join
          </ButtonLink>
        ) : (
          <Button
            variant={featured ? "primary" : "outline"}
            fullWidth
            onClick={onJoin}
            disabled={pending || busy || disabled}
            aria-busy={busy || undefined}
            aria-label={actionLabel}
          >
            {busy ? "Just a moment…" : isMember ? "Extend" : "Join"}
          </Button>
        )}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------- member card */

function MemberCard({
  membership,
  programmeName,
}: {
  membership: MembershipSummary;
  programmeName: string;
}) {
  const active = membership.status === "active";
  const left = membership.freeDeliveriesLeftThisMonth;

  return (
    <section
      aria-labelledby="your-membership"
      className="rounded-card border border-copper-200 bg-copper-50 p-5 sm:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label-wide text-copper-700">Your {programmeName}</p>
          <h2 id="your-membership" className="mt-2.5 font-display text-xl text-ink sm:text-2xl">
            {membership.planName}
          </h2>
          <p className="mt-1.5 text-sm text-ink-600">
            {active
              ? `Your benefits run until ${formatDate(membership.endsAt)}.`
              : `Ended ${formatDate(membership.endsAt)}.`}
          </p>
        </div>
        <MembershipStatusPill status={membership.status} />
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-copper-200 pt-5 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-500">Saved so far</dt>
          <dd className="mt-1 font-display text-lg text-ink">{formatPrice(membership.savedOnOrders)}</dd>
        </div>
        {membership.benefits.freeDelivery ? (
          <div>
            <dt className="text-xs text-ink-500">Orders delivered free</dt>
            <dd className="mt-1 font-display text-lg text-ink">{membership.freeDeliveryOrders}</dd>
          </div>
        ) : null}
        {active && left !== null ? (
          <div>
            <dt className="text-xs text-ink-500">Free deliveries left this month</dt>
            <dd className="mt-1 font-display text-lg text-ink">{left}</dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-5">
        <Link
          href="/account/membership"
          className="inline-flex items-center gap-1.5 text-sm text-copper-700 underline-offset-4 hover:underline"
        >
          View membership details
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
