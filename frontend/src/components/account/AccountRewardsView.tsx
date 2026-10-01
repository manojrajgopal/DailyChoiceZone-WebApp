"use client";

import { useCallback, useEffect, useState } from "react";
import { Award, Clock, Sparkles } from "lucide-react";

import { AccountShell } from "@/components/account/AccountShell";
import { ErrorState } from "@/components/common/States";
import { ButtonLink } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { useConfirmedCustomer } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { getRewards, type RewardsPage } from "@/services/walletService";

const points = (value: number) => value.toLocaleString("en-IN");

/**
 * Reward points: what can be spent now, what is on its way, when points
 * expire, how they are earned and spent, and every movement.
 */
export function AccountRewardsView() {
  const signedIn = useConfirmedCustomer();
  const [data, setData] = useState<RewardsPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);

  const load = useCallback(
    (next: number) =>
      getRewards(next).then(
        (value) => {
          setData(value);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [],
  );

  useEffect(() => {
    if (signedIn) void load(page);
  }, [signedIn, load, page]);

  const rules = data?.rules;

  return (
    <AccountShell title="Reward points" description="Earn points on what you buy, and spend them at checkout.">
      {failed ? (
        <ErrorState onRetry={() => void load(page)} />
      ) : !data || !rules ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          {!data.enabled ? (
            <p className="rounded-card border border-ink-200 bg-shell p-4 text-sm text-ink-600">
              Reward points are paused right now. Points you have are kept safe.
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <Tile icon={<Award className="h-4 w-4" />} label="Ready to spend" value={points(data.available)}
              hint={`Worth ₹${data.availableValue.toLocaleString("en-IN")}`} strong />
            <Tile icon={<Clock className="h-4 w-4" />} label="On their way" value={points(data.pending)}
              hint={data.nextReleaseAt ? `Next batch ready ${formatDate(data.nextReleaseAt)}` : "Points from delivered orders"} />
            <Tile icon={<Sparkles className="h-4 w-4" />} label="Earned so far" value={points(data.lifetimeEarned)}
              hint={`${points(data.lifetimeRedeemed)} spent · ${points(data.lifetimeExpired)} expired`} />
          </div>

          {data.debt > 0 ? (
            <p className="rounded-card border border-copper-200 bg-copper-50 p-4 text-sm text-ink-700">
              {points(data.debt)} points from a returned order had already been spent. They&rsquo;ll be taken from
              the next points you earn before those can be used.
            </p>
          ) : null}
          {data.nextExpiry ? (
            <p className="text-sm text-ink-600">
              {points(data.nextExpiry.points)} points expire on <strong>{formatDate(data.nextExpiry.at)}</strong>.
            </p>
          ) : null}

          <section aria-labelledby="rules-heading" className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-card border border-ink-200 bg-shell p-5">
              <h2 id="rules-heading" className="font-display text-lg text-ink">How you earn</h2>
              <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink-600">
                <li>{rules.pointsPer100} points for every ₹100 you spend{rules.excludeTax ? " (before tax)" : ""}.</li>
                {rules.memberMultiplier > 1 ? <li>Members earn {rules.memberMultiplier}× points.</li> : null}
                <li>Points are added when your order is delivered and can be spent once its return window has closed{rules.pendingDays !== null ? ` (${rules.pendingDays} days)` : ""}.</li>
                {rules.excludeTenderPaid ? <li>What you pay with gift cards, store credit or points doesn&rsquo;t earn points.</li> : null}
                {rules.excludeDiscountedItems ? <li>Discounted items don&rsquo;t earn points.</li> : null}
                <li>Delivery charges never earn points. If an order is returned or refunded, its points go back too.</li>
              </ul>
            </div>
            <div className="rounded-card border border-ink-200 bg-shell p-5">
              <h2 className="font-display text-lg text-ink">How you spend</h2>
              <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink-600">
                <li>{points(rules.redeemPoints)} points = ₹{rules.redeemValue} off at checkout.</li>
                <li>Spend from {points(rules.minRedeemPoints)} points, on up to {rules.maxOrderPercent}% of an order{rules.maxPointsPerOrder ? ` (at most ${points(rules.maxPointsPerOrder)} points)` : ""}.</li>
                {rules.expiryMonths ? <li>Points expire {rules.expiryMonths} months after they&rsquo;re ready to spend.</li> : <li>Points don&rsquo;t expire.</li>}
                {!rules.allowWithCoupons ? <li>Points can&rsquo;t be combined with a coupon.</li> : null}
                <li>Cancel an order and the points you spent come back.</li>
              </ul>
              <ButtonLink href="/shop" size="sm" variant="outline" className="mt-4">Start shopping</ButtonLink>
            </div>
          </section>

          <section aria-labelledby="history-heading">
            <h2 id="history-heading" className="font-display text-lg text-ink">History</h2>
            {data.items.length === 0 ? (
              <p className="mt-3 text-sm text-ink-500">No points yet — they&rsquo;re added when an order is delivered.</p>
            ) : (
              <div className="mt-4 overflow-x-auto rounded-card border border-ink-200">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <thead className="bg-cream-deep text-xs text-ink-500">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Date</th>
                      <th className="px-4 py-2.5 font-medium">What</th>
                      <th className="px-4 py-2.5 text-right font-medium">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {data.items.map((entry) => (
                      <tr key={entry.id}>
                        <td className="whitespace-nowrap px-4 py-3 text-ink-500">{formatDate(entry.createdAt)}</td>
                        <td className="px-4 py-3">
                          <span className="block text-ink">{entry.label}</span>
                          <span className="block text-xs text-ink-500">
                            {entry.reason}
                            {entry.kind === "earned" && entry.availableAt ? ` · ready ${formatDate(entry.availableAt)}` : ""}
                          </span>
                        </td>
                        <td className={cn("px-4 py-3 text-right tabular-nums", entry.points > 0 ? "text-sage-600" : "text-ink")}>
                          {entry.points > 0 ? "+" : "−"}{points(Math.abs(entry.points))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination page={page} totalPages={data.pagination.total_pages} onPageChange={setPage} className="mt-4" />
          </section>
        </div>
      )}
    </AccountShell>
  );
}

function Tile({ icon, label, value, hint, strong }: { icon: React.ReactNode; label: string; value: string; hint: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-card border p-5", strong ? "border-ink bg-ink text-cream" : "border-ink-200 bg-shell")}>
      <p className={cn("flex items-center gap-2 label-wide", strong ? "text-cream/80" : "text-ink-500")}>
        <span aria-hidden="true">{icon}</span>
        {label}
      </p>
      <p className="mt-2 font-display text-3xl tabular-nums">{value}</p>
      <p className={cn("mt-1 text-xs", strong ? "text-cream/80" : "text-ink-500")}>{hint}</p>
    </div>
  );
}
