"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Banknote,
  CreditCard,
  Landmark,
  Loader2,
  QrCode,
  Smartphone,
  Wallet as WalletIcon,
} from "lucide-react";

import type { PaymentMethodId } from "@/types";

import { Button } from "@/components/ui/Button";
import { Radio } from "@/components/ui/Field";
import { cn } from "@/lib/utils/cn";
import { getPaymentMethods, type AvailableMethods } from "@/services/payments/paymentGatewayService";
import { UPI_APPS, supportsUpiIntent, isAndroid } from "@/services/payments/razorpayCustom";

/**
 * Choosing how to pay, in our own interface.
 *
 * Every rail the gateway supports is offered here as a panel of this page —
 * no modal, no iframe, no other company's branding. What the shopper is
 * looking at is this store, right up to the moment their own bank or their own
 * UPI app asks them to authorise, which is the only place that can happen.
 *
 * ## What is offered is what will work
 *
 * The list comes from `GET /api/payments/methods`, which intersects the
 * methods the store has switched on with the ones the Razorpay account can
 * actually take. Offering UPI on an account with UPI disabled produces a
 * method a shopper picks and the gateway then refuses — a failure after the
 * decision, which is the worst place for one.
 *
 * ## Why the UPI options differ by device
 *
 * A `upi://` intent is a handoff to an installed app. On a phone that opens
 * Google Pay or PhonePe; on a laptop it opens nothing and looks broken. So a
 * phone gets the app buttons and a desktop gets a QR code to scan with the
 * phone already in their hand — the same rail, addressed the way the device
 * can actually reach it.
 */

export type Choice =
  | { kind: "upi-intent"; app?: string; tappedAt?: number }
  | { kind: "upi-qr" }
  | { kind: "upi-vpa"; vpa: string }
  /**
   * `container` is the element the processor's card field is drawn into, so
   * the card step is part of this page rather than a window over it.
   */
  | { kind: "card"; container?: string }
  | { kind: "netbanking"; bank: string }
  | { kind: "wallet"; wallet: string }
  | { kind: "cod" };

/** The order-level method a choice maps to, which is what the order records. */
export function methodFor(choice: Choice): PaymentMethodId {
  switch (choice.kind) {
    case "upi-intent":
    case "upi-qr":
    case "upi-vpa":
      return "upi" as PaymentMethodId;
    case "card":
      return "card" as PaymentMethodId;
    case "netbanking":
      return "netbanking" as PaymentMethodId;
    case "wallet":
      return "wallet" as PaymentMethodId;
    case "cod":
      return "cod" as PaymentMethodId;
  }
}

/** A readable summary, for the confirm button and the order summary. */
export function describe(choice: Choice, methods: AvailableMethods | null): string {
  switch (choice.kind) {
    case "upi-intent":
      return UPI_APPS.find((app) => app.code === choice.app)?.name ?? "UPI app";
    case "upi-qr":
      return "Scan to pay";
    case "upi-vpa":
      return choice.vpa || "UPI ID";
    case "card":
      return "Card";
    case "netbanking":
      return (
        methods?.netbanking.find((bank) => bank.code === choice.bank)?.name ?? "Net banking"
      );
    case "wallet":
      return methods?.wallet.find((w) => w.code === choice.wallet)?.name ?? "Wallet";
    case "cod":
      return "Cash on delivery";
  }
}

/**
 * What the UPI panel promises, which depends on what it can deliver.
 *
 * A subtitle offering a QR code on an account that cannot produce one is the
 * same failure as a button that does not work, arriving one step earlier.
 */
function upiSubtitle(onPhone: boolean, methods: AvailableMethods): string {
  if (onPhone && methods.upiIntent) return "Google Pay, PhonePe, Paytm and any other UPI app";
  if (methods.upiQr) return "Scan a QR code with any UPI app";
  if (methods.upiIntent) return "Available when you pay from a phone";
  return "Not available at the moment";
}

export function PaymentMethods({
  onPay,
  isPaying,
  total,
  cardContainer,
  codUnavailable = false,
}: {
  onPay: (choice: Choice) => void;
  isPaying: boolean;
  /** Formatted, for the button. */
  total: string;
  /**
   * A CSS selector the processor's card field is drawn into.
   *
   * Passing one is what keeps the card step inside the page instead of a
   * floating window; without it Checkout falls back to its modal, which is
   * what a screen too narrow to embed actually wants.
   */
  cardContainer?: string;
  /** The delivery pincode doesn't offer cash on delivery (the server refuses it too). */
  codUnavailable?: boolean;
}) {
  const [methods, setMethods] = useState<AvailableMethods | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getPaymentMethods()
      .then((result) => {
        if (active) setMethods(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  /**
   * Settled once, on mount.
   *
   * Reading the user agent during render would differ between the server and
   * the browser and produce a hydration mismatch, so the desktop layout is
   * rendered first and corrected on the first paint.
   */
  const [onPhone, setOnPhone] = useState(false);
  const [onAndroid, setOnAndroid] = useState(false);
  useEffect(() => {
    setOnPhone(supportsUpiIntent());
    setOnAndroid(isAndroid());
  }, []);

  const [open, setOpen] = useState<string | null>(null);
  const [bank, setBank] = useState("");
  const [wallet, setWallet] = useState("");
  const [bankQuery, setBankQuery] = useState("");

  const available = useMemo(() => new Set(methods?.methods ?? []), [methods]);

  const banks = useMemo(() => {
    const all = methods?.netbanking ?? [];
    const query = bankQuery.trim().toLowerCase();
    return query ? all.filter((entry) => entry.name.toLowerCase().includes(query)) : all;
  }, [methods, bankQuery]);

  if (failed) {
    return (
      <p className="rounded-card border border-clay-200 bg-clay-50 p-4 text-sm text-ink-700">
        We could not load the payment options. Please refresh the page.
      </p>
    );
  }

  if (!methods) {
    return (
      <div className="flex flex-col gap-2.5" aria-busy="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-16 animate-pulse rounded-card bg-ink-100" />
        ))}
      </div>
    );
  }

  if (available.size === 0) {
    return (
      <p className="rounded-card border border-clay-200 bg-clay-50 p-4 text-sm text-ink-700">
        No payment method is available at the moment. Please contact us and we will take
        the order for you.
      </p>
    );
  }

  const pay = (choice: Choice) => onPay(choice);

  return (
    <div className="flex flex-col gap-3">
      {/* ------------------------------------------------------------- UPI */}
      {available.has("upi") ? (
        <Panel
          id="upi"
          open={open}
          setOpen={setOpen}
          icon={<Smartphone className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
          title="UPI"
          subtitle={upiSubtitle(onPhone, methods)}
        >
          {/*
            On a phone, the apps. `app` is omitted for "any UPI app", which
            lets the system offer whatever is installed rather than guessing.
          */}
          {onPhone && methods.upiIntent ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {UPI_APPS.map((app) => (
                  <button
                    key={app.code}
                    type="button"
                    disabled={isPaying}
                    onClick={() => pay({ kind: "upi-intent", app: app.code, tappedAt: performance.now() })}
                    className="rounded-control border border-ink-200 px-3 py-2.5 text-xs font-medium text-ink transition-colors hover:border-copper-400 hover:bg-copper-50 disabled:opacity-50"
                  >
                    {app.name}
                  </button>
                ))}
              </div>

              {/* The phone's own app picker exists on Android only. */}
              {onAndroid ? (
                <Button
                  variant="outline"
                  fullWidth
                  disabled={isPaying}
                  onClick={() => pay({ kind: "upi-intent", tappedAt: performance.now() })}
                  className="mt-2"
                >
                  Any other UPI app
                </Button>
              ) : null}
            </>
          ) : null}

          {/* A QR needs the collect rail, which an intent-only account lacks. */}
          {!onPhone && methods.upiQr ? (
            <Button
              fullWidth
              disabled={isPaying}
              onClick={() => pay({ kind: "upi-qr" })}
              className="gap-2"
            >
              <QrCode className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              Show a QR code to scan
            </Button>
          ) : null}

          {/*
            No "enter your UPI ID" option: UPI collect requests were withdrawn
            on 28 February 2026, and Razorpay no longer completes them.
          */}

          {/*
            Nothing to offer. Which of the two reasons it is matters to the
            shopper: one of them is fixed by picking up their phone, and the
            other is not fixable by them at all.
          */}
          {!methods.upiQr && !(onPhone && methods.upiIntent) ? (
            <p className="text-xs leading-relaxed text-ink-500">
              {methods.upiIntent
                ? "UPI apps can be used when you pay from your phone. On a computer, " +
                  "please choose another payment method."
                : "UPI isn't available right now. Please choose another payment " +
                  "method below."}
            </p>
          ) : null}
        </Panel>
      ) : null}

      {/* --------------------------------------------------------- scan to pay */}
      {available.has("qr") && methods.qrCodes ? (
        <Panel
          id="qr"
          open={open}
          setOpen={setOpen}
          icon={<QrCode className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
          title="Scan to pay"
          subtitle="Google Pay, PhonePe, Paytm — any UPI app"
        >
          <p className="text-xs leading-relaxed text-ink-500">
            We will show a QR code on this page. Scan it with any UPI app and the page
            updates automatically — there is nothing to type.
          </p>

          <Button
            fullWidth
            disabled={isPaying}
            onClick={() => pay({ kind: "upi-qr" })}
            className="mt-3 gap-2"
          >
            <QrCode className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            Show QR code · Pay {total}
          </Button>
        </Panel>
      ) : null}

      {/* ------------------------------------------------------------ card */}
      {available.has("card") ? (
        <Panel
          id="card"
          open={open}
          setOpen={setOpen}
          icon={<CreditCard className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
          title="Credit or debit card"
          subtitle="Visa, Mastercard, RuPay and Amex"
        >
          <p className="text-xs leading-relaxed text-ink-500">
            Your card details are entered securely with our payment partner and are never stored by us.
          </p>
          <Button
            fullWidth
            disabled={isPaying}
            onClick={() => pay({ kind: "card", container: cardContainer })}
            className="mt-3"
          >
            Continue to secure card entry
          </Button>
        </Panel>
      ) : null}

      {/* ----------------------------------------------------- net banking */}
      {available.has("netbanking") ? (
        <Panel
          id="netbanking"
          open={open}
          setOpen={setOpen}
          icon={<Landmark className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
          title="Net banking"
          subtitle={`${methods.netbanking.length} banks`}
        >
          <input
            value={bankQuery}
            onChange={(event) => setBankQuery(event.target.value)}
            placeholder="Search for your bank"
            aria-label="Search for your bank"
            className="w-full rounded-control border border-ink-200 bg-shell px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-300 focus:border-copper-500"
          />

          <div className="mt-3 max-h-60 overflow-y-auto pr-1">
            <div className="flex flex-col gap-1.5">
              {banks.map((entry) => (
                <Radio
                  key={entry.code}
                  name="bank"
                  value={entry.code}
                  checked={bank === entry.code}
                  onChange={() => setBank(entry.code)}
                  label={entry.name}
                />
              ))}
              {banks.length === 0 ? (
                <p className="py-4 text-center text-xs text-ink-400">
                  No bank matches “{bankQuery}”.
                </p>
              ) : null}
            </div>
          </div>

          <Button
            fullWidth
            disabled={isPaying || !bank}
            onClick={() => pay({ kind: "netbanking", bank })}
            className="mt-3"
          >
            Pay {total} at your bank
          </Button>
        </Panel>
      ) : null}

      {/* ---------------------------------------------------------- wallet */}
      {available.has("wallet") ? (
        <Panel
          id="wallet"
          open={open}
          setOpen={setOpen}
          icon={<WalletIcon className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
          title="Wallet"
          subtitle={methods.wallet.map((entry) => entry.name).join(", ")}
        >
          <div className="flex flex-col gap-1.5">
            {methods.wallet.map((entry) => (
              <Radio
                key={entry.code}
                name="wallet"
                value={entry.code}
                checked={wallet === entry.code}
                onChange={() => setWallet(entry.code)}
                label={entry.name}
              />
            ))}
          </div>

          <Button
            fullWidth
            disabled={isPaying || !wallet}
            onClick={() => pay({ kind: "wallet", wallet })}
            className="mt-3"
          >
            Pay {total} with your wallet
          </Button>
        </Panel>
      ) : null}

      {/* ------------------------------------------------ cash on delivery */}
      {available.has("cod") && codUnavailable ? (
        <p className="rounded-card border border-ink-200 bg-shell px-4 py-3 text-xs leading-relaxed text-ink-500">
          Cash on delivery isn&rsquo;t available for your delivery PIN code. Please choose another way to pay.
        </p>
      ) : available.has("cod") ? (
        <Panel
          id="cod"
          open={open}
          setOpen={setOpen}
          icon={<Banknote className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
          title="Cash on delivery"
          subtitle="Pay the courier when it arrives"
        >
          <p className="text-xs leading-relaxed text-ink-500">
            Nothing is charged now. Please have the exact amount ready for the courier.
          </p>
          <Button
            fullWidth
            disabled={isPaying}
            onClick={() => pay({ kind: "cod" })}
            className="mt-3"
          >
            {isPaying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                Placing order…
              </>
            ) : (
              <>Place order · {total}</>
            )}
          </Button>
        </Panel>
      ) : null}
    </div>
  );
}

/**
 * One collapsible method.
 *
 * An accordion rather than a list of radios followed by one button: each rail
 * needs different things from the shopper — a bank, a wallet, a UPI ID,
 * nothing at all — and putting those inputs inside the option they belong to
 * is what stops the page asking for a bank while "UPI" is selected.
 */
function Panel({
  id,
  open,
  setOpen,
  icon,
  title,
  subtitle,
  children,
}: {
  id: string;
  open: string | null;
  setOpen: (id: string | null) => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const isOpen = open === id;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-card border transition-colors",
        isOpen ? "border-copper-400 bg-copper-50/40" : "border-ink-200 bg-shell",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(isOpen ? null : id)}
        aria-expanded={isOpen}
        aria-controls={`${id}-panel`}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-copper-50/60"
      >
        <span
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-pill transition-colors",
            isOpen ? "bg-copper-100 text-copper-700" : "bg-ink-100 text-ink-500",
          )}
        >
          {icon}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">{title}</span>
          <span className="block truncate text-xs text-ink-500">{subtitle}</span>
        </span>

        <span
          aria-hidden="true"
          className={cn(
            "shrink-0 text-ink-400 transition-transform",
            isOpen && "rotate-180",
          )}
        >
          ▾
        </span>
      </button>

      {isOpen ? (
        <div id={`${id}-panel`} className="border-t border-ink-100 px-4 py-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}
