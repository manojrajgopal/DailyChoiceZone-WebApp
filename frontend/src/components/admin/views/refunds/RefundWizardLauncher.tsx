"use client";

import { useEffect, useState } from "react";

import { ApiError } from "@/services/api/client";
import { getOrderRefunds } from "@/services/admin/refundsAdminService";
import { toast } from "@/store/toastStore";
import type { RefundBreakdown } from "@/types/refunds";

import { RefundWizard } from "./RefundWizard";

/**
 * Opens the refund wizard for an order from anywhere (an invoice, a
 * payment): reads what is left to refund first, so the wizard always starts
 * from the server's figures.
 */
export function RefundWizardLauncher({
  orderId,
  open,
  onClose,
  onDone,
}: {
  orderId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [initial, setInitial] = useState<RefundBreakdown | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    getOrderRefunds(orderId)
      .then((data) => live && setInitial(data.breakdown))
      .catch((error: unknown) => {
        if (!live) return;
        toast.error(error instanceof ApiError ? error.message : "The refund couldn't be started.");
        onClose();
      });
    return () => {
      live = false;
      setInitial(null);
    };
    // `onClose` is a callback prop; reading the order again only when it or `open` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, open]);

  if (!open || !initial) return null;
  return (
    <RefundWizard orderId={orderId} initial={initial} onClose={onClose}
      onDone={() => {
        onClose();
        onDone();
      }} />
  );
}
