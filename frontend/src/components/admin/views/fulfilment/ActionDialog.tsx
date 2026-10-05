"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminTextarea } from "@/components/admin/ui/AdminForm";
import { Modal } from "@/components/ui/Dialog";

/**
 * Confirm a fulfilment step before it is sent. Steps that move backwards, end
 * the order or record an exception ask for a reason, which is stored with the
 * change and shown in the history. The server checks the reason again.
 *
 * Mount it only while it is open, so every opening starts with an empty reason.
 */
export function ActionDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  requiresReason,
  reasonPlaceholder,
  saving,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
  requiresReason: boolean;
  reasonPlaceholder?: string;
  saving: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);

  const tooShort = requiresReason && reason.trim().length < 3;

  return (
    <Modal open={open} onOpenChange={(next) => !next && !saving && onCancel()} title={title} className="max-w-md">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!tooShort) onConfirm(reason.trim());
        }}
      >
        <div className="flex items-start gap-3">
          {destructive ? (
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] bg-[#fdf3dd]">
              <AlertTriangle className="h-4 w-4 text-[#8a5d00]" strokeWidth={1.75} aria-hidden="true" />
            </span>
          ) : null}
          <p className="text-sm leading-relaxed text-admin-muted">{description}</p>
        </div>

        {error ? (
          <p role="alert" className="rounded-[3px] bg-[#fbeaea] px-3 py-2 text-xs text-[#a12b2b]">
            {error}
          </p>
        ) : null}

        {requiresReason ? (
          <AdminTextarea
            label="Reason"
            required
            rows={3}
            value={reason}
            placeholder={reasonPlaceholder ?? "e.g. Package damaged and needs repacking"}
            error={touched && tooShort ? "Give a short reason (at least 3 characters)." : undefined}
            hint="Saved with the change and shown in the order history."
            onChange={(event) => setReason(event.target.value)}
          />
        ) : null}

        <div className="flex justify-end gap-2">
          <AdminButton variant="secondary" onClick={onCancel} disabled={saving}>
            Back
          </AdminButton>
          <AdminButton type="submit" variant={destructive ? "danger" : "primary"} loading={saving}>
            {confirmLabel}
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}
