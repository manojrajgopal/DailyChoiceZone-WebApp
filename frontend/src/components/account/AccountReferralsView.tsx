"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Gift, Share2, Users } from "lucide-react";

import { AccountShell } from "@/components/account/AccountShell";
import { ErrorState } from "@/components/common/States";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useConfirmedCustomer } from "@/hooks/useSession";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { type MyReferrals, getMyReferrals } from "@/services/growthService";
import { toast } from "@/store/toastStore";

/**
 * Refer a friend: your code and link, how the rewards work, and the friends
 * who joined with it. Rewards are worked out and paid by the store's server.
 */
export function AccountReferralsView() {
  const signedIn = useConfirmedCustomer();
  const [data, setData] = useState<MyReferrals | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => getMyReferrals().then((value) => { setData(value); setFailed(false); }, () => setFailed(true)), []);
  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  const rules = data?.rules;
  const reward = (amount: number) => (rules?.rewardType === "points" ? `${amount.toLocaleString("en-IN")} reward points` : `${formatPrice(amount)} store credit`);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("Couldn't copy — select it and copy it yourself.");
    }
  };

  const share = async () => {
    if (!data?.shareUrl) return;
    const text = `Join me at Daily Choice Zone — sign up with my code ${data.code}.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Daily Choice Zone", text, url: data.shareUrl });
        return;
      } catch {
        /* closed the share sheet: fall through to copying */
      }
    }
    await copy(data.shareUrl, "Link");
  };

  return (
    <AccountShell title="Refer a friend" description="Invite friends to shop with us. You both get a reward after their first order.">
      {failed ? <ErrorState onRetry={() => void load()} /> : !data || !rules ? (
        <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full" />)}</div>
      ) : (
        <div className="flex flex-col gap-10">
          {!rules.enabled ? (
            <p className="rounded-card border border-ink-200 bg-shell p-4 text-sm text-ink-600">
              The referral programme is paused right now. Rewards already earned are yours to keep.
            </p>
          ) : data.codeDisabled ? (
            <p className="rounded-card border border-ink-200 bg-shell p-4 text-sm text-ink-600">
              Your referral code has been switched off. Contact us if you think that&rsquo;s a mistake.
            </p>
          ) : data.code ? (
            <section className="rounded-card border border-copper-200 bg-copper-50 p-5">
              <p className="label-wide text-copper-700">Your code</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="font-display text-3xl tracking-wider text-ink">{data.code}</span>
                <Button size="sm" variant="secondary" onClick={() => void copy(data.code!, "Code")}>
                  <Copy className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Copy code
                </Button>
                <Button size="sm" onClick={() => void share()}>
                  <Share2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Share link
                </Button>
              </div>
              {data.shareUrl ? <p className="mt-3 break-all text-xs text-ink-500">{data.shareUrl}</p> : null}
            </section>
          ) : null}

          <section aria-labelledby="how-heading">
            <h2 id="how-heading" className="font-display text-xl text-ink">How it works</h2>
            <ol className="mt-4 grid gap-4 sm:grid-cols-3">
              <li className="rounded-card border border-ink-200 p-4 text-sm text-ink-600">
                <Users className="mb-2 h-5 w-5 text-copper-700" strokeWidth={1.5} aria-hidden="true" />
                Your friend signs up with your code or link.
              </li>
              <li className="rounded-card border border-ink-200 p-4 text-sm text-ink-600">
                <Gift className="mb-2 h-5 w-5 text-copper-700" strokeWidth={1.5} aria-hidden="true" />
                Their first order of {formatPrice(rules.minOrderAmount)} or more is {rules.rewardOn === "delivered" ? "delivered" : "paid for"} within {rules.windowDays} days.
              </li>
              <li className="rounded-card border border-ink-200 p-4 text-sm text-ink-600">
                <Share2 className="mb-2 h-5 w-5 text-copper-700" strokeWidth={1.5} aria-hidden="true" />
                You get {reward(rules.referrerReward)}{rules.refereeReward ? `, and they get ${reward(rules.refereeReward)}` : ""}.
              </li>
            </ol>
            <p className="mt-3 text-xs text-ink-400">Rewards are taken back if that order is cancelled, returned or refunded. Your own accounts don&rsquo;t count.</p>
          </section>

          <section aria-labelledby="friends-heading">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 id="friends-heading" className="font-display text-xl text-ink">Friends who joined</h2>
              <p className="text-sm text-ink-500">
                {data.stats.invited} joined · {data.stats.rewarded} rewarded
                {data.stats.earnedCredit ? ` · ${formatPrice(data.stats.earnedCredit)} earned` : ""}
                {data.stats.earnedPoints ? ` · ${data.stats.earnedPoints.toLocaleString("en-IN")} points earned` : ""}
              </p>
            </div>
            {data.referrals.length === 0 ? (
              <p className="mt-4 text-sm text-ink-500">No one has joined with your code yet.</p>
            ) : (
              <ul className="mt-4 divide-y divide-ink-100 border-y border-ink-200">
                {data.referrals.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <span className="text-ink">{r.name}<span className="block text-xs text-ink-400">Joined {formatDate(r.joinedAt)}</span></span>
                    <span className="text-right text-ink-600">
                      {r.statusLabel}
                      {r.reward ? <span className="block text-xs text-sage-600">{r.reward}</span> : null}
                      {r.expiresAt ? <span className="block text-xs text-ink-400">Order by {formatDate(r.expiresAt)}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.joinedWith ? (
            <p className="text-sm text-ink-500">
              You joined with a friend&rsquo;s code: {data.joinedWith.statusLabel.toLowerCase()}
              {data.joinedWith.reward ? ` — ${data.joinedWith.reward} added to your account.` : "."}
            </p>
          ) : null}
        </div>
      )}
    </AccountShell>
  );
}
