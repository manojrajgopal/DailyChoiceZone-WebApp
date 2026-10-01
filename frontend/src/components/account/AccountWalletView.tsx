"use client";

import { useCallback, useEffect, useState } from "react";
import { Gift, Wallet } from "lucide-react";

import { AccountShell } from "@/components/account/AccountShell";
import { ErrorState } from "@/components/common/States";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { useConfirmedCustomer } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import {
  checkGiftCard,
  getMyGiftCards,
  getStoreCredit,
  type GiftCardCheck,
  type GiftCardSummary,
  type StoreCreditPage,
} from "@/services/walletService";

const rupees = (value: number) =>
  `₹${value.toLocaleString("en-IN", { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const CARD_STATUS: Record<string, string> = {
  active: "Active", "partially-used": "Partly used", used: "Used up", expired: "Expired", disabled: "Cancelled",
  refunded: "Refunded", pending: "Awaiting payment", cancelled: "Cancelled",
};

/** Store credit, gift cards you've bought, and a balance check for one you've received. */
export function AccountWalletView() {
  const signedIn = useConfirmedCustomer();
  const [credit, setCredit] = useState<StoreCreditPage | null>(null);
  const [cards, setCards] = useState<GiftCardSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);

  const load = useCallback(
    (next: number) =>
      Promise.all([getStoreCredit(next), getMyGiftCards()]).then(
        ([creditPage, mine]) => {
          setCredit(creditPage);
          setCards(mine);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [],
  );

  useEffect(() => {
    if (signedIn) void load(page);
  }, [signedIn, load, page]);

  return (
    <AccountShell title="Gift cards & credit" description="Your store credit, the gift cards you've sent, and a balance check.">
      {failed ? (
        <ErrorState onRetry={() => void load(page)} />
      ) : !credit || !cards ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          {/* --------------------------------------------- store credit */}
          <section aria-labelledby="credit-heading">
            <div className="flex flex-wrap items-end justify-between gap-4 rounded-card border border-ink-200 bg-shell p-5">
              <div>
                <h2 id="credit-heading" className="flex items-center gap-2 label-wide text-ink-500">
                  <Wallet className="h-4 w-4 text-copper-600" strokeWidth={1.5} aria-hidden="true" /> Store credit
                </h2>
                <p className="mt-2 font-display text-3xl text-ink tabular-nums">{rupees(credit.balance)}</p>
                <p className="mt-1 text-xs text-ink-500">Use it at checkout. It has no cash value.</p>
              </div>
              <ButtonLink href="/shop" variant="outline" size="sm">Shop now</ButtonLink>
            </div>
            {credit.items.length > 0 ? (
              <div className="mt-4 overflow-x-auto rounded-card border border-ink-200">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <thead className="bg-cream-deep text-xs text-ink-500">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Date</th>
                      <th className="px-4 py-2.5 font-medium">What</th>
                      <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                      <th className="px-4 py-2.5 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {credit.items.map((entry) => (
                      <tr key={entry.id}>
                        <td className="whitespace-nowrap px-4 py-3 text-ink-500">{formatDate(entry.createdAt)}</td>
                        <td className="px-4 py-3">
                          <span className="block text-ink">{entry.label}</span>
                          {entry.reason ? <span className="block text-xs text-ink-500">{entry.reason}</span> : null}
                        </td>
                        <td className={cn("px-4 py-3 text-right tabular-nums", entry.amount > 0 ? "text-sage-600" : "text-ink")}>
                          {entry.amount > 0 ? "+" : "−"}{rupees(Math.abs(entry.amount))}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-700">{rupees(entry.balanceAfter)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-500">No store credit activity yet.</p>
            )}
            {credit.pagination.total_pages > 1 ? (
              <Pagination page={page} totalPages={credit.pagination.total_pages} onPageChange={setPage} className="mt-4" />
            ) : null}
          </section>

          {/* --------------------------------------------- balance check */}
          <BalanceCheck />

          {/* --------------------------------------------- cards sent */}
          <section aria-labelledby="cards-heading">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="cards-heading" className="flex items-center gap-2 font-display text-lg text-ink">
                <Gift className="h-4 w-4 text-copper-600" strokeWidth={1.5} aria-hidden="true" /> Gift cards you&rsquo;ve sent
              </h2>
              <ButtonLink href="/gift-cards" size="sm">Send a gift card</ButtonLink>
            </div>
            {cards.length === 0 ? (
              <p className="mt-3 text-sm text-ink-500">You haven&rsquo;t sent any gift cards yet.</p>
            ) : (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {cards.map((card) => (
                  <li key={card.id} className="rounded-card border border-ink-200 bg-shell p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-display text-xl text-ink tabular-nums">{rupees(card.initialAmount)}</p>
                      <span className="rounded-pill bg-cream-deep px-2 py-0.5 text-[0.6875rem] text-ink-600">
                        {CARD_STATUS[card.status] ?? card.status}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink-700">To {card.recipientName}</p>
                    <p className="text-xs text-ink-500 break-all">{card.recipientEmail}</p>
                    <p className="mt-2 text-xs text-ink-500">
                      {card.last4 !== "----" ? `Ends in ${card.last4} · ` : ""}Balance {rupees(card.balance)}
                      {card.expiresAt ? ` · until ${formatDate(card.expiresAt)}` : ""}
                    </p>
                    <p className="text-xs text-ink-400">Sent {formatDate(card.deliveredAt ?? card.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AccountShell>
  );
}

function BalanceCheck() {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<GiftCardCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await checkGiftCard(code.trim()));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "We couldn't check that code just now.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="check-heading" className="rounded-card border border-ink-200 bg-shell p-5">
      <h2 id="check-heading" className="font-display text-lg text-ink">Received a gift card?</h2>
      <p className="mt-1 text-sm text-ink-500">Check its balance here, then enter the code at checkout.</p>
      <form onSubmit={check} className="mt-4 flex flex-wrap items-start gap-2">
        <Input
          label="Gift card code"
          className="min-w-0 flex-1 [&_label]:sr-only"
          placeholder="DCZG-XXXX-XXXX-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" variant="outline" className="h-11" disabled={busy || !code.trim()}>
          {busy ? "Checking…" : "Check balance"}
        </Button>
      </form>
      {result ? (
        <p className="mt-3 text-sm" role="status">
          {result.valid ? (
            <>
              Card ending {result.last4}: <strong className="text-ink">{rupees(result.balance ?? 0)}</strong> left
              {result.expiresAt ? `, usable until ${formatDate(result.expiresAt)}` : ""}.
              {result.reason ? <span className="block text-danger">{result.reason}</span> : null}
            </>
          ) : (
            <span className="text-danger">{result.reason}</span>
          )}
        </p>
      ) : null}
    </section>
  );
}
