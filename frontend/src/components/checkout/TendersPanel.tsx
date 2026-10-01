"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Award, Gift, Wallet, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Checkbox, Input } from "@/components/ui/Field";
import { formatMoney } from "@/lib/money";

/** Whole rupees when whole, paise when not — a gift card can hold ₹999.50. */
const money = (minor: number) => formatMoney(minor, { showDecimals: minor % 100 !== 0 });
import { ApiError } from "@/services/api/client";
import { previewTenders, type TenderPreview } from "@/services/walletService";

export interface TenderSelection {
  giftCardCodes: string[];
  useStoreCredit: boolean;
  points: number;
}

export const NO_TENDERS: TenderSelection = { giftCardCodes: [], useStoreCredit: false, points: 0 };

/**
 * Gift cards, store credit and reward points at checkout.
 *
 * Everything shown here is the server's arithmetic: the panel sends what the
 * shopper chose and shows what each would actually pay, and the order is
 * placed with the same choices — the server works it out again then, under
 * locks, so a balance spent in another tab in between can't be spent twice.
 *
 * Gift card codes stay in this page's memory only; they're never written to
 * the browser's storage.
 */
export function TendersPanel({
  couponCode,
  deliveryMethod,
  placeOfSupply,
  pincode,
  onChange,
  disabled,
}: {
  couponCode: string | null;
  deliveryMethod: string;
  placeOfSupply: string | null;
  pincode: string | null;
  onChange: (selection: TenderSelection, preview: TenderPreview | null) => void;
  disabled?: boolean;
}) {
  const [selection, setSelection] = useState<TenderSelection>(NO_TENDERS);
  const [preview, setPreview] = useState<TenderPreview | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [pointsInput, setPointsInput] = useState("");
  const [loading, setLoading] = useState(false);
  const report = useRef(onChange);
  useEffect(() => {
    report.current = onChange;
  });

  useEffect(() => {
    let live = true;
    setLoading(true);
    previewTenders({ couponCode, deliveryMethod, placeOfSupply, pincode, ...selection })
      .then((data) => {
        if (!live) return;
        setPreview(data);
        // Codes the server refused are dropped from what will be sent, with their reason shown.
        const refused = data.giftCards.filter((card) => card.error);
        const first = refused[0];
        if (first) {
          setCodeError(`Gift card ending ${first.last4}: ${first.error}`);
          const keep = selection.giftCardCodes.filter((entry) => !refused.some((card) => entry.replace(/[^A-Za-z0-9]/g, "").toUpperCase().endsWith(card.last4)));
          if (keep.length !== selection.giftCardCodes.length) {
            setSelection((current) => ({ ...current, giftCardCodes: keep }));
            return;
          }
        }
        report.current(selection, data);
      })
      .catch((error) => {
        if (!live) return;
        setPreview(null);
        setCodeError(error instanceof ApiError ? error.message : "We couldn't check that just now.");
        report.current(NO_TENDERS, null);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [selection, couponCode, deliveryMethod, placeOfSupply, pincode]);

  const addCode = (event: React.FormEvent) => {
    event.preventDefault();
    const entry = code.trim();
    if (!entry) return;
    setCodeError(null);
    setSelection((current) =>
      current.giftCardCodes.includes(entry) ? current : { ...current, giftCardCodes: [...current.giftCardCodes, entry] },
    );
    setCode("");
  };

  const points = preview?.points;
  const canUsePoints = Boolean(points && points.enabled && points.maxPoints > 0);
  const hasCredit = (preview?.storeCredit.available ?? 0) > 0;

  return (
    <section aria-labelledby="tenders-heading" className="mb-6 rounded-card border border-ink-200 bg-shell p-4 sm:p-5">
      <h2 id="tenders-heading" className="label-wide text-ink-700">Gift cards, credit &amp; points</h2>

      {/* ------------------------------------------------------- gift cards */}
      <div className="mt-4">
        <p className="flex items-center gap-2 text-sm text-ink">
          <Gift className="h-4 w-4 text-copper-600" strokeWidth={1.5} aria-hidden="true" /> Gift card
        </p>
        {preview?.giftCards.filter((card) => !card.error).map((card) => (
          <div key={card.last4} className="mt-2 flex items-center justify-between gap-3 rounded-control bg-cream-deep px-3 py-2 text-sm">
            <span className="text-ink-700">
              Card ending {card.last4} · {money(card.applied)} applied
              <span className="text-ink-400"> (balance {money(card.balance)})</span>
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                setSelection((current) => ({
                  ...current,
                  giftCardCodes: current.giftCardCodes.filter(
                    (entry) => !entry.replace(/[^A-Za-z0-9]/g, "").toUpperCase().endsWith(card.last4),
                  ),
                }))
              }
              aria-label={`Remove gift card ending ${card.last4}`}
              className="text-ink-400 hover:text-ink"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        ))}
        <form onSubmit={addCode} className="mt-2 flex items-start gap-2">
          <Input
            label="Gift card code"
            className="flex-1 [&_label]:sr-only"
            placeholder="DCZG-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            error={codeError ?? undefined}
            disabled={disabled}
            maxLength={40}
          />
          <Button type="submit" variant="outline" disabled={disabled || !code.trim()} className="h-11">
            Apply
          </Button>
        </form>
      </div>

      {/* ----------------------------------------------------- store credit */}
      {hasCredit ? (
        <div className="mt-4 border-t border-ink-100 pt-4">
          <Checkbox
            label={
              <span className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
                Use store credit ({money(preview?.storeCredit.available ?? 0)} available)
              </span>
            }
            checked={selection.useStoreCredit}
            disabled={disabled}
            onChange={(event) => setSelection((current) => ({ ...current, useStoreCredit: event.target.checked }))}
          />
          {selection.useStoreCredit && preview ? (
            <p className="mt-1 pl-7 text-xs text-ink-500">{money(preview.storeCredit.applied)} applied</p>
          ) : null}
        </div>
      ) : null}

      {/* ----------------------------------------------------------- points */}
      {points && points.enabled && points.available > 0 ? (
        <div className="mt-4 border-t border-ink-100 pt-4">
          <p className="flex items-center gap-2 text-sm text-ink">
            <Award className="h-4 w-4 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
            Reward points — {points.available.toLocaleString("en-IN")} available
          </p>
          {canUsePoints ? (
            <>
              <p className="mt-1 text-xs text-ink-500">
                {points.redeemPoints.toLocaleString("en-IN")} points = ₹{points.redeemValue}. Up to{" "}
                {points.maxPoints.toLocaleString("en-IN")} on this order (minimum {points.minRedeemPoints.toLocaleString("en-IN")}).
              </p>
              <div className="mt-2 flex flex-wrap items-start gap-2">
                <Input
                  label="Points to use"
                  className="w-36 [&_label]:sr-only"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={points.maxPoints}
                  value={pointsInput}
                  onChange={(event) => setPointsInput(event.target.value)}
                  disabled={disabled}
                />
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={disabled}
                  onClick={() => setSelection((current) => ({ ...current, points: Math.max(0, Math.floor(Number(pointsInput) || 0)) }))}
                >
                  Apply
                </Button>
                <Button
                  variant="ghost"
                  className="h-11"
                  disabled={disabled}
                  onClick={() => {
                    setPointsInput(String(points.maxPoints));
                    setSelection((current) => ({ ...current, points: points.maxPoints }));
                  }}
                >
                  Use maximum
                </Button>
              </div>
              {selection.points > 0 ? (
                <p className="mt-1.5 text-xs text-ink-600">
                  {points.applied.toLocaleString("en-IN")} points applied — {money(points.value)} off what you pay.{" "}
                  <button type="button" className="underline underline-offset-2" disabled={disabled}
                    onClick={() => { setPointsInput(""); setSelection((current) => ({ ...current, points: 0 })); }}>
                    Remove
                  </button>
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-1 text-xs text-ink-500">{points.reason}</p>
          )}
        </div>
      ) : null}

      {preview && preview.tenderTotal > 0 ? (
        <dl className="mt-4 flex flex-col gap-1 border-t border-ink-100 pt-4 text-sm" aria-live="polite">
          <div className="flex justify-between"><dt className="text-ink-500">Order total</dt><dd className="tabular-nums">{money(preview.grandTotal)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-500">Paid with cards, credit &amp; points</dt><dd className="tabular-nums">− {money(preview.tenderTotal)}</dd></div>
          <div className="flex justify-between font-medium text-ink"><dt>Left to pay</dt><dd className="tabular-nums">{money(preview.amountDue)}</dd></div>
        </dl>
      ) : null}
      {preview?.messages.filter(Boolean).map((note) => (
        <p key={note} className="mt-2 text-xs text-ink-500">{note}</p>
      ))}
      {loading ? <p className="mt-2 text-xs text-ink-400" role="status">Checking…</p> : null}
      <p className="mt-3 text-xs text-ink-400">
        No gift card yet? <Link href="/gift-cards" className="underline underline-offset-2 hover:text-ink">Send one</Link>.
      </p>
    </section>
  );
}
