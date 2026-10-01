"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CheckCircle2, Gift } from "lucide-react";

import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { openRazorpayCheckout } from "@/services/payments/razorpayCheckout";
import {
  abandonGiftCard,
  buyGiftCard,
  getGiftCardOptions,
  verifyGiftCardPayment,
  type GiftCardOptions,
} from "@/services/walletService";
import { toast } from "@/store/toastStore";

/**
 * Buy a gift card for someone.
 *
 * The card's code is created only once the payment is confirmed, and emailed
 * straight to the recipient — it never passes through this page.
 */
export function GiftCardPurchaseView() {
  const { user, isSignedIn, isLoading } = useSession();
  const [options, setOptions] = useState<GiftCardOptions | null>(null);
  const [failed, setFailed] = useState(false);
  const [amount, setAmount] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  // Blank until typed: the signed-in name is used, and shown as the default.
  const [senderName, setSenderName] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ name: string; email: string; amount: number } | null>(null);

  useEffect(() => {
    getGiftCardOptions()
      .then((data) => {
        setOptions(data);
        setAmount(data.denominations[1] ?? data.denominations[0] ?? null);
      })
      .catch(() => setFailed(true));
  }, []);

  const fromName = senderName ?? (user ? `${user.firstName} ${user.lastName}`.trim() : "");

  const chosen = custom ? Number(custom) : amount;

  const validate = () => {
    const next: Record<string, string> = {};
    if (!options) return next;
    if (!chosen || !Number.isInteger(chosen) || chosen < options.minAmount || chosen > options.maxAmount) {
      next.amount = `Choose a whole amount from ${formatPrice(options.minAmount)} to ${formatPrice(options.maxAmount)}.`;
    }
    if (!recipientName.trim()) next.recipientName = "Who is it for?";
    if (!/^\S+@\S+\.\S+$/.test(recipientEmail.trim())) next.recipientEmail = "Enter a valid email address.";
    return next;
  };

  const buy = async (event: React.FormEvent) => {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0 || !chosen) return;
    setBusy(true);
    let cardId: number | null = null;
    try {
      const started = await buyGiftCard({
        amount: chosen, recipientName: recipientName.trim(), recipientEmail: recipientEmail.trim(),
        senderName: fromName.trim(), message: message.trim(),
      });
      cardId = started.giftCard.id;
      if (started.gateway) {
        const outcome = await openRazorpayCheckout(started.gateway, {});
        if (outcome.status !== "completed") {
          await abandonGiftCard(started.giftCard.id).catch(() => undefined);
          if (outcome.status === "failed") toast.error(`${outcome.reason} No gift card was sent.`);
          else toast.info("Payment not completed — no money has been taken.");
          return;
        }
        await verifyGiftCardPayment(started.giftCard.id, outcome.response as unknown as Record<string, string>);
      }
      setSent({ name: recipientName.trim(), email: recipientEmail.trim(), amount: chosen });
      toast.success("Gift card sent!");
    } catch (error) {
      if (cardId !== null && error instanceof ApiError && error.code !== "PAYMENT_UNVERIFIED") {
        await abandonGiftCard(cardId).catch(() => undefined);
      }
      toast.error(error instanceof ApiError ? error.message : "We couldn't complete the purchase. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-shell py-8 sm:py-10">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Gift cards" }]} />
      <div className="mt-4 grid gap-10 lg:grid-cols-[1fr_24rem] lg:gap-14">
        <div>
          <h1 className="font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">Gift cards</h1>
          <p className="mt-2.5 max-w-xl text-sm leading-relaxed text-ink-500">
            Let them choose. We email the gift card straight to them with its code, ready to use at checkout
            {options?.validityMonths ? ` for ${options.validityMonths} months` : ""}. Any amount left after an
            order stays on the card for next time.
          </p>

          {failed ? (
            <p className="mt-8 text-sm text-ink-500">Gift cards couldn&rsquo;t load. Please refresh the page.</p>
          ) : !options || isLoading ? (
            <div className="mt-8 flex flex-col gap-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : !options.enabled ? (
            <p className="mt-8 rounded-card border border-ink-200 bg-shell p-5 text-sm text-ink-600">
              Gift cards aren&rsquo;t available right now. Please check back soon.
            </p>
          ) : sent ? (
            <div className="mt-8 rounded-card border border-sage-200 bg-sage-50 p-6" role="status">
              <CheckCircle2 className="h-6 w-6 text-sage-600" strokeWidth={1.5} aria-hidden="true" />
              <p className="mt-3 font-display text-xl text-ink">Sent to {sent.name}</p>
              <p className="mt-1.5 text-sm text-ink-600">
                A {formatPrice(sent.amount)} gift card is on its way to {sent.email}. You&rsquo;ll find it under
                Gift cards &amp; credit in your account.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <ButtonLink href="/account/wallet" variant="outline" size="sm">View my gift cards</ButtonLink>
                <Button size="sm" variant="ghost" onClick={() => { setSent(null); setRecipientName(""); setRecipientEmail(""); setMessage(""); }}>
                  Send another
                </Button>
              </div>
            </div>
          ) : !isSignedIn ? (
            <div className="mt-8 rounded-card border border-ink-200 bg-shell p-6">
              <p className="text-sm text-ink-700">Sign in to buy a gift card — we&rsquo;ll keep a record of it in your account.</p>
              <ButtonLink href={`/account?next=${encodeURIComponent("/gift-cards")}`} className="mt-4">Sign in</ButtonLink>
            </div>
          ) : (
            <form onSubmit={buy} className="mt-8 flex max-w-xl flex-col gap-6" noValidate>
              <fieldset>
                <legend className="label-wide mb-3 text-ink-700">Amount</legend>
                <div className="flex flex-wrap gap-2">
                  {options.denominations.map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={!custom && amount === value}
                      onClick={() => { setAmount(value); setCustom(""); }}
                      className={cn(
                        "min-w-[5.5rem] rounded-card border px-4 py-2.5 text-sm tabular-nums transition-colors",
                        !custom && amount === value ? "border-ink bg-ink text-cream" : "border-ink-200 bg-shell text-ink hover:border-ink-400",
                      )}
                    >
                      {formatPrice(value)}
                    </button>
                  ))}
                </div>
                {options.allowCustomAmount ? (
                  <Input
                    className="mt-3 max-w-xs"
                    label="Or another amount (₹)"
                    type="number"
                    inputMode="numeric"
                    min={options.minAmount}
                    max={options.maxAmount}
                    step={1}
                    value={custom}
                    onChange={(event) => setCustom(event.target.value)}
                    hint={`${formatPrice(options.minAmount)} to ${formatPrice(options.maxAmount)}`}
                  />
                ) : null}
                {errors.amount ? <p role="alert" className="mt-2 text-xs text-danger">{errors.amount}</p> : null}
              </fieldset>

              <div className="grid gap-5 sm:grid-cols-2">
                <Input label="Their name" value={recipientName} onChange={(event) => setRecipientName(event.target.value)}
                  error={errors.recipientName} maxLength={120} required />
                <Input label="Their email" type="email" value={recipientEmail}
                  onChange={(event) => setRecipientEmail(event.target.value)} error={errors.recipientEmail}
                  maxLength={255} required />
                <Input label="From" value={fromName} onChange={(event) => setSenderName(event.target.value)}
                  maxLength={120} className="sm:col-span-2" />
                <Textarea label="Message (optional)" value={message} rows={3} className="sm:col-span-2"
                  onChange={(event) => setMessage(event.target.value.slice(0, 300))} hint={`${message.length}/300`} />
              </div>

              <Button type="submit" size="lg" disabled={busy} className="sm:w-auto">
                <Gift className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                {busy ? "Please wait…" : `Buy ${chosen ? formatPrice(chosen) : ""} gift card`}
              </Button>
            </form>
          )}
        </div>

        <aside className="h-fit rounded-card border border-ink-200 bg-shell p-6">
          <p className="label-wide text-ink-500">Good to know</p>
          <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-ink-600">
            <li>Use the code at checkout; it can pay all of an order or part of it.</li>
            <li>Whatever isn&rsquo;t spent stays on the card.</li>
            <li>If an order paid with it is cancelled or returned, the money goes back to the card.</li>
            <li>Keep the code private — anyone who has it can spend the card.</li>
          </ul>
          <p className="mt-4 text-sm text-ink-600">
            Got one? <Link href="/account/wallet" className="underline underline-offset-4 hover:text-copper-700">Check its balance</Link>.
          </p>
        </aside>
      </div>
    </div>
  );
}
