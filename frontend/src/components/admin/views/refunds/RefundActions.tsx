"use client";

import { useState } from "react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminTextarea } from "@/components/admin/ui/AdminForm";
import { Badge } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { ApiError } from "@/services/api/client";
import { approveRefund, cancelRefund, rejectRefund, retryRefund } from "@/services/admin/refundsAdminService";
import { toast } from "@/store/toastStore";
import type { RefundRecord, RefundState } from "@/types/refunds";

const TONE: Record<RefundState, "green" | "amber" | "red" | "grey"> = {
  requested: "amber", processing: "amber", completed: "green", failed: "red", cancelled: "grey", rejected: "grey",
};

export function RefundStatusBadge({ refund }: { refund: Pick<RefundRecord, "status" | "statusLabel"> }) {
  return <Badge tone={TONE[refund.status] ?? "grey"}>{refund.statusLabel || refund.status}</Badge>;
}

/**
 * The steps a refund allows next — approve or reject one waiting for
 * approval, retry a failed one or check a processing one with the gateway,
 * cancel one not yet sent — exactly as the server's `can*` flags say. Reject
 * and cancel ask for a note. No money moves without the server's say-so, and
 * every step is audited there.
 */
export function RefundActions({ refund, onChanged }: { refund: RefundRecord; onChanged: (next: RefundRecord) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<"reject" | "cancel" | null>(null);
  const [note, setNote] = useState("");

  if (!refund.canApprove && !refund.canRetry && !refund.canCancel) return null;

  const act = async (key: string, work: () => Promise<RefundRecord>, done: (next: RefundRecord) => string) => {
    setBusy(key);
    try {
      const next = await work();
      (next.status === "failed" ? toast.error : toast.success)(done(next));
      setAsk(null);
      onChanged(next);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "That didn't work. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {refund.canApprove ? (
        <>
          <AdminButton size="sm" variant="primary" loading={busy === "approve"} disabled={busy !== null}
            onClick={() => void act("approve", () => approveRefund(refund.id),
              (next) => next.status === "failed" ? "Approved, but the gateway declined it." : `${next.refundNumber} approved.`)}>
            Approve
          </AdminButton>
          <AdminButton size="sm" disabled={busy !== null} onClick={() => { setNote(""); setAsk("reject"); }}>Reject…</AdminButton>
        </>
      ) : null}
      {refund.canRetry ? (
        <AdminButton size="sm" loading={busy === "retry"} disabled={busy !== null}
          onClick={() => void act("retry", () => retryRefund(refund.id),
            (next) => next.status === "completed" ? `${next.refundNumber} completed.`
              : next.status === "failed" ? "The payment gateway declined it again." : "Checked with the gateway.")}>
          {refund.status === "processing" ? "Check status" : "Retry"}
        </AdminButton>
      ) : null}
      {refund.canCancel ? (
        <AdminButton size="sm" variant="ghost" disabled={busy !== null} onClick={() => { setNote(""); setAsk("cancel"); }}>
          Cancel…
        </AdminButton>
      ) : null}

      <Modal open={ask !== null} onOpenChange={(open) => !open && busy === null && setAsk(null)}
        title={ask === "reject" ? `Reject ${refund.refundNumber}?` : `Cancel ${refund.refundNumber}?`} className="max-w-md">
        <div className="flex flex-col gap-3 text-xs">
          <p className="text-admin-muted">No money moves. It stays in the history with your note.</p>
          <AdminTextarea label="Note" rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          <div className="flex justify-end gap-2">
            <AdminButton disabled={busy !== null} onClick={() => setAsk(null)}>Back</AdminButton>
            <AdminButton variant="danger" loading={busy === "ask"}
              onClick={() => void act("ask", () => ask === "reject"
                ? rejectRefund(refund.id, note.trim()) : cancelRefund(refund.id, note.trim()),
              (next) => `${next.refundNumber} ${ask === "reject" ? "rejected" : "cancelled"}.`)}>
              {ask === "reject" ? "Reject refund" : "Cancel refund"}
            </AdminButton>
          </div>
        </div>
      </Modal>
    </div>
  );
}
