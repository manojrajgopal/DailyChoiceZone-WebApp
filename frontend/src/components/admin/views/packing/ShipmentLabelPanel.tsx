"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Download, Eye, Printer, RotateCcw, Tag, X } from "lucide-react";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { AdminSelect, AdminTextarea } from "@/components/admin/ui/AdminForm";
import { problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { formatDateTime } from "@/lib/support/format";
import * as packing from "@/services/admin/packingAdminService";
import { toast } from "@/store/toastStore";
import type { LabelOverview } from "@/types/packing";

import { LabelStatusBadge } from "./shared";

type Busy = "load" | "generate" | "preview" | "print" | "download" | "reason" | null;

/**
 * The store's own shipping label for a shipment (a PDF the API draws: from,
 * to, AWB barcode, order, packages, COD). Separate from the courier's label,
 * which the courier makes; when the courier has one, it is linked here too.
 * Every version is kept — a regenerated or cancelled label stays in the
 * history with who did it and why.
 */
export function ShipmentLabelPanel({ shipmentId, refreshKey = 0 }: { shipmentId: number; refreshKey?: number }) {
  const [overview, setOverview] = useState<LabelOverview | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState<Busy>("load");
  const [format, setFormat] = useState("");
  const [ask, setAsk] = useState<"regenerate" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    packing.getShipmentLabels(shipmentId)
      .then((next) => {
        if (!live) return;
        setOverview(next);
        setFormat((current) => current || next.current?.format || next.defaultFormat);
        setFailed("");
      })
      .catch((error: unknown) => live && setFailed(problem(error, "The label details didn't load.")))
      .finally(() => live && setBusy(null));
    return () => {
      live = false;
    };
  }, [shipmentId, refreshKey, attempt]);

  const act = async (key: Busy, work: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      const next = await work();
      if (next && typeof next === "object" && "shipmentId" in next) setOverview(next as LabelOverview);
      if (done) toast.success(done);
      return true;
    } catch (error) {
      toast.error(problem(error, "That didn't work. Please try again."));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!overview) {
    return (
      <AdminCard title="Shipping label">
        {failed ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-xs text-[#a12b2b]">{failed}</p>
            <AdminButton size="sm" onClick={() => { setBusy("load"); setAttempt((n) => n + 1); }}>Try again</AdminButton>
          </div>
        ) : (
          <span aria-busy="true" aria-label="Loading label" className="block h-16 animate-pulse rounded-[2px] bg-admin-border" />
        )}
      </AdminCard>
    );
  }

  const current = overview.current;
  const printable = Boolean(current?.printable);
  const disabled = busy !== null;
  const past = overview.history.filter((version) => !version.current);

  return (
    <AdminCard title="Shipping label" action={<LabelStatusBadge status={overview.status} />}>
      {current ? (
        <p className="mb-3 text-xs text-admin-muted">
          Version {current.version} · {current.formatName}
          {current.generatedAt ? ` · ${formatDateTime(current.generatedAt)}` : ""}
          {current.generatedBy ? ` · ${current.generatedBy}` : ""}
        </p>
      ) : (
        <p className="mb-3 text-xs text-admin-muted">No label yet.</p>
      )}

      {current?.status === "failed" && current.errorMessage ? (
        <p role="alert" className="mb-3 text-xs text-[#a12b2b]">{current.errorMessage}</p>
      ) : null}

      {overview.problems.length ? (
        <ul aria-label="What the label still needs" className="mb-3 flex flex-col gap-1 text-xs text-[#8a5a12]">
          {overview.problems.map((issue, index) => (
            <li key={index} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      {overview.formats.length > 1 ? (
        <AdminSelect label="Label size" value={format} onChange={(event) => setFormat(event.target.value)}
          disabled={disabled} className="mb-3"
          options={overview.formats.map((f) => ({ value: f.key, label: `${f.name} (${f.widthMm} × ${f.heightMm} mm)` }))} />
      ) : null}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Label actions">
        {!printable && overview.canGenerate ? (
          <AdminButton size="sm" variant="primary" loading={busy === "generate"} disabled={disabled}
            onClick={() => void act("generate", () => packing.generateShipmentLabel(shipmentId, format || undefined), "Label generated.")}>
            <Tag className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Generate label
          </AdminButton>
        ) : null}
        {printable && current ? (
          <>
            <AdminButton size="sm" loading={busy === "preview"} disabled={disabled}
              onClick={() => void act("preview", () => packing.openPdf(packing.labelPreviewPath(current.id)))}>
              <Eye className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Preview
            </AdminButton>
            <AdminButton size="sm" loading={busy === "print"} disabled={disabled}
              onClick={() => void act("print", () => packing.printPdf(packing.labelPreviewPath(current.id)))}>
              <Printer className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Print
            </AdminButton>
            <AdminButton size="sm" loading={busy === "download"} disabled={disabled}
              onClick={() => void act("download", () => packing.downloadLabel(current.id))}>
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Download
            </AdminButton>
          </>
        ) : null}
        {current && current.status !== "cancelled" && overview.canGenerate ? (
          <AdminButton size="sm" disabled={disabled} onClick={() => { setReason(""); setAsk("regenerate"); }}>
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Regenerate…
          </AdminButton>
        ) : null}
        {printable ? (
          <AdminButton size="sm" variant="ghost" disabled={disabled} onClick={() => { setReason(""); setAsk("cancel"); }}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Cancel label
          </AdminButton>
        ) : null}
      </div>

      {overview.courierLabelUrl ? (
        <a href={overview.courierLabelUrl} target="_blank" rel="noopener noreferrer"
          className="mt-3 inline-block text-xs text-copper-700 underline">
          The courier&rsquo;s own label
        </a>
      ) : null}

      {past.length ? (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-admin-muted">Earlier versions ({past.length})</summary>
          <ol className="mt-2 flex flex-col gap-1.5">
            {past.map((version) => (
              <li key={version.id} className="text-admin-ink">
                v{version.version} · {version.statusLabel} · {formatDateTime(version.createdAt)}
                {version.generatedBy ? ` · ${version.generatedBy}` : ""}
                {version.cancelReason || version.reason ? (
                  <span className="block text-admin-muted">{version.cancelReason || version.reason}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <Modal open={ask !== null} onOpenChange={(open) => !open && busy !== "reason" && setAsk(null)}
        title={ask === "cancel" ? "Cancel this label?" : "Make a new label?"} className="max-w-md">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-admin-muted">
            {ask === "cancel"
              ? "The label can't be printed any more. It stays in the history; generate a new one when it's needed."
              : "The current label is replaced and kept in the history. Throw away any printed copies of it."}
          </p>
          <AdminTextarea label="Reason" required rows={2} maxLength={300} value={reason}
            onChange={(event) => setReason(event.target.value)} hint="At least 3 characters. Kept in the history." />
          <div className="flex justify-end gap-2">
            <AdminButton disabled={busy === "reason"} onClick={() => setAsk(null)}>Back</AdminButton>
            <AdminButton variant={ask === "cancel" ? "danger" : "primary"} disabled={reason.trim().length < 3}
              loading={busy === "reason"}
              onClick={() => void act("reason", () => ask === "cancel"
                ? packing.cancelShipmentLabel(shipmentId, reason.trim())
                : packing.regenerateShipmentLabel(shipmentId, reason.trim(), format || undefined),
              ask === "cancel" ? "Label cancelled." : "New label generated.").then((ok) => ok && setAsk(null))}>
              {ask === "cancel" ? "Cancel label" : "Regenerate"}
            </AdminButton>
          </div>
        </div>
      </Modal>
    </AdminCard>
  );
}
