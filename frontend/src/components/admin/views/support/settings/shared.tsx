"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import {
  deleteConfigRow,
  reason,
  saveConfigRow,
  type ConfigList,
  type SupportConfiguration,
} from "@/services/supportService";

import { AdminButton, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { Modal } from "@/components/ui/Dialog";
import { ApiError } from "@/services/api/client";
import { toast } from "@/store/toastStore";

/** What every configuration tab receives. */
export interface TabProps {
  config: SupportConfiguration;
  reload: () => Promise<void>;
}

/**
 * Save a row, then re-read the configuration so the page shows what the
 * database now holds. Returns the error message for the form, or null.
 */
export async function saveRow(
  list: ConfigList,
  payload: object,
  id: number | null,
  reload: () => Promise<void>,
  what: string,
): Promise<string | null> {
  try {
    await saveConfigRow(list, payload, id);
    toast.success(`${what} ${id ? "saved" : "added"}.`);
    await reload();
    return null;
  } catch (cause) {
    return reason(cause, "That couldn't be saved. Please try again.");
  }
}

/** A modal form: title, fields, a server error line, and Save / Cancel. */
export function EditModal({
  open,
  onOpenChange,
  title,
  description,
  onSave,
  children,
  wide = false,
  saveLabel = "Save",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Resolve an error message to keep the modal open, or null to close it. */
  onSave: () => Promise<string | null>;
  children: React.ReactNode;
  wide?: boolean;
  saveLabel?: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      title={title}
      description={description}
      className={wide ? "max-w-3xl" : "max-w-xl"}
    >
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          const problem = await onSave();
          setSaving(false);
          setError(problem);
          if (!problem) onOpenChange(false);
        }}
      >
        <div className="flex flex-col gap-4">{children}</div>
        {error ? (
          <p role="alert" className="mt-4 rounded-[3px] bg-[#fbeaea] px-3 py-2 text-xs text-[#a32424]">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <AdminButton onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving}>
            {saveLabel}
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Delete with a confirmation. A row that tickets or other rows depend on is
 * refused by the API ("switch it off instead") — that answer is shown as is.
 */
export function DeleteButton({
  list,
  id,
  name,
  reload,
}: {
  list: ConfigList;
  id: number;
  name: string;
  reload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[3px] p-1.5 text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424]"
        aria-label={`Delete ${name}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${name}?`}
        message="This can't be undone. Anything still in use can't be deleted — switch it off instead, and its history stays intact."
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await deleteConfigRow(list, id);
            toast.success(`${name} deleted.`);
            setOpen(false);
            await reload();
          } catch (cause) {
            toast.error(cause instanceof ApiError && cause.code === "IN_USE" ? cause.message : reason(cause));
            setOpen(false);
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

export function EditButton({ onClick, name }: { onClick: () => void; name: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[3px] p-1.5 text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
      aria-label={`Edit ${name}`}
    >
      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <AdminButton size="sm" variant="primary" onClick={onClick}>
      <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      {children}
    </AdminButton>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  return <StatusBadge tone={active ? "good" : "neutral"}>{active ? "Active" : "Off"}</StatusBadge>;
}

/** The table shell every list in the setup uses. */
export function ConfigTable({
  headers,
  children,
  empty,
  minWidth = "40rem",
}: {
  headers: { label: string; align?: "right" }[];
  children: React.ReactNode;
  empty?: string;
  minWidth?: string;
}) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-admin-border bg-admin-raised">
            {headers.map((header) => (
              <th
                key={header.label}
                scope="col"
                className={`px-3 py-2.5 font-medium text-admin-muted ${header.align === "right" ? "text-right" : ""}`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-admin-border">{children}</tbody>
      </table>
      {empty ? <p className="px-4 py-10 text-center text-xs text-admin-muted">{empty}</p> : null}
    </div>
  );
}

/** "round-robin" → "Round robin". */
export function words(value: string): string {
  const spaced = value.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
