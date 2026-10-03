"use client";

import { CheckCircle2, Loader2 } from "lucide-react";

import type { Stage } from "@/hooks/useGatewayPayment";

import { Button } from "@/components/ui/Button";

/**
 * What the shopper sees while a payment is under way — a QR to scan, "waiting
 * for your UPI app or bank", "confirming" — in our own interface, wherever a
 * payment is taken (checkout, membership, gift cards).
 */
export function PaymentProgress({
  stage,
  qr,
  message,
  tapToOpen,
  amount,
  exits,
}: {
  stage: Stage;
  qr: string | null;
  message: string;
  tapToOpen: { appName: string; open: () => void } | null;
  /** Formatted, e.g. "₹1,299". */
  amount: string;
  /** "Pay another way" / "Cancel", shown unless the payment is being confirmed. */
  exits?: React.ReactNode;
}) {
  if (stage !== "qr" && stage !== "waiting" && stage !== "confirming") return null;

  return (
    <div className="max-w-2xl rounded-card border border-ink-200 bg-shell p-6 text-center">
      {qr ? (
        <>
          <p className="text-sm font-medium text-ink">Scan to pay {amount}</p>
          <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-ink-500">
            Open any UPI app on your phone, scan this code, and approve the payment.
            This page will update automatically.
          </p>

          {/*
            Rendered at its natural size, and never scaled down: a QR is a grid
            of hard edges, and resampling it can make it unreadable. The
            optimiser must not resample or cache a single-use payment artefact.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qr}
            alt={`QR code to pay ${amount}`}
            decoding="sync"
            className="mx-auto mt-5 block h-auto w-auto max-w-full rounded-card border border-ink-200 bg-white [image-rendering:pixelated]"
          />

          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-ink-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            Waiting for your payment
          </p>
        </>
      ) : (
        <>
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-copper-600" strokeWidth={1.75} aria-hidden="true" />
          <p className="mt-4 text-sm font-medium text-ink">
            {stage === "confirming" ? "Confirming your payment…" : "Waiting for you"}
          </p>
        </>
      )}

      <p className="mt-4 text-xs leading-relaxed text-ink-500" role="status">
        {message}
      </p>

      {tapToOpen ? (
        <Button onClick={tapToOpen.open} className="mt-4" size="lg">
          Open {tapToOpen.appName}
        </Button>
      ) : null}

      {stage === "confirming" ? (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-ink-400">
          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          Do not close this page
        </p>
      ) : (
        exits
      )}
    </div>
  );
}
