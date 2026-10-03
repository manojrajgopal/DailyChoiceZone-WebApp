"use client";

import { useState } from "react";
import { Download, Printer, Tag, X } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import * as packing from "@/services/admin/packingAdminService";
import { toast } from "@/store/toastStore";
import type { BulkLabelResult } from "@/types/packing";

export const BULK_LABEL_LIMIT = 100;

/**
 * Labels for many shipments at once: generate (each one on its own — one
 * failure never stops the rest), download them as a ZIP, or print them as one
 * PDF. Shipments without a printable label are skipped, and the page says
 * how many.
 */
export function BulkLabelBar({
  selected,
  labels,
  onClear,
  onDone,
}: {
  selected: number[];
  labels: Record<number, string>;
  onClear: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<"generate" | "zip" | "print" | null>(null);
  const [result, setResult] = useState<BulkLabelResult | null>(null);

  if (selected.length === 0) return null;
  const over = selected.length > BULK_LABEL_LIMIT;

  const generate = async () => {
    setBusy("generate");
    try {
      const next = await packing.bulkGenerateLabels(selected);
      setResult(next);
      if (next.failed === 0) toast.success(`${next.succeeded} label${next.succeeded === 1 ? "" : "s"} ready.`);
      onDone();
    } catch (error) {
      toast.error(problem(error, "The labels weren't generated. Please try again."));
    } finally {
      setBusy(null);
    }
  };

  const print = async () => {
    setBusy("print");
    try {
      const { skipped } = await packing.printPdf(packing.bulkLabelPath(selected, "merged"));
      if (skipped) toast.info(`Skipped (no label yet): ${skipped.split(",").length} shipment(s).`);
    } catch (error) {
      toast.error(problem(error, "The labels couldn't be printed."));
    } finally {
      setBusy(null);
    }
  };

  const zip = async () => {
    setBusy("zip");
    try {
      await packing.downloadLabelsZip(selected);
    } catch (error) {
      toast.error(problem(error, "The labels couldn't be downloaded."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div role="region" aria-label="Selected shipments"
        className="mb-3 flex flex-wrap items-center gap-2 rounded-[3px] border border-admin-border bg-admin-raised px-3 py-2 text-xs">
        <span className="font-medium text-admin-ink">{selected.length} selected</span>
        {over ? <span role="alert" className="text-[#a12b2b]">Up to {BULK_LABEL_LIMIT} at a time.</span> : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <AdminButton size="sm" variant="primary" disabled={over || busy !== null} loading={busy === "generate"}
            onClick={() => void generate()}>
            <Tag className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Generate labels
          </AdminButton>
          <AdminButton size="sm" disabled={over || busy !== null} loading={busy === "print"} onClick={() => void print()}>
            <Printer className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Print labels
          </AdminButton>
          <AdminButton size="sm" disabled={over || busy !== null} loading={busy === "zip"} onClick={() => void zip()}>
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Download ZIP
          </AdminButton>
          <AdminButton size="sm" variant="ghost" disabled={busy !== null} onClick={onClear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Clear
          </AdminButton>
        </div>
      </div>

      <Modal open={result !== null && result.failed > 0} onOpenChange={(open) => !open && setResult(null)}
        title="Some labels weren't made" className="max-w-lg">
        {result ? (
          <div className="flex flex-col gap-3 text-xs">
            <p className="text-admin-ink">{result.succeeded} ready, {result.failed} not made.</p>
            <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
              {result.results.filter((row) => !row.ok).map((row) => (
                <li key={row.shipmentId}>
                  <span className="font-medium text-admin-ink">{labels[row.shipmentId] ?? `Shipment ${row.shipmentId}`}</span>
                  {"error" in row ? <span className="block text-[#a12b2b]">{row.error.message}</span> : null}
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <AdminButton onClick={() => setResult(null)}>Close</AdminButton>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
