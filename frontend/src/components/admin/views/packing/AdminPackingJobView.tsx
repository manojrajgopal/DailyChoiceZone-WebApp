"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Eye, PackageCheck, Pencil, Plus, Printer, Trash2 } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea } from "@/components/admin/ui/AdminForm";
import { IdSelector } from "@/components/common/IdSelector";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import * as packing from "@/services/admin/packingAdminService";
import type { PackageInput, PackingJob, PackingLineView, PackingPriority, PickException } from "@/types/packing";
import { EXCEPTION_LABELS } from "@/types/packing";
import { toast } from "@/store/toastStore";

import { PackageForm } from "./PackageForm";
import { PackingStatusBadge, agingLabel, dimensionsLabel, weightLabel } from "./shared";

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

type Ask =
  | { kind: "exception"; line: PackingLineView }
  | { kind: "damaged"; line: PackingLineView }
  | { kind: "pick-override" }
  | { kind: "pack-confirm" }
  | { kind: "reopen" }
  | { kind: "remove-package"; packageId: number; packageNumber: string }
  | null;

/**
 * One order, picked and packed: what to pick and how many, problems with a
 * line, the parcels it goes in (one or several), the checks before it is
 * packed, the packing slip, and every step taken — who, when, from what to
 * what. Every action is checked by the server, which also writes the audit
 * trail; the page only offers what the job's `actions` allow.
 */
export function AdminPackingJobView() {
  const params = useSearchParams();
  const id = Number(params?.get("id") ?? "");
  const loaded = useAdminResource(() => packing.getPackingJob(id), [id], { enabled: Number.isInteger(id) && id > 0 });
  // What an action returned, until the job is loaded again (or another one is opened).
  const [latest, setLatest] = useState<PackingJob | null>(null);
  const job = latest?.id === id ? latest : (loaded.data ?? null);
  const setJob = setLatest;
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAskState] = useState<Ask>(null);
  // A fresh dialog (empty note, quantity 1) each time one is opened.
  const [askKey, setAskKey] = useState(0);
  const setAsk = (next: Ask) => {
    if (next) setAskKey((value) => value + 1);
    setAskState(next);
  };
  const [editing, setEditing] = useState<number | "new" | null>(null);

  const run = async (key: string, work: () => Promise<PackingJob>, done?: string): Promise<boolean> => {
    setBusy(key);
    try {
      setJob(await work());
      if (done) toast.success(done);
      return true;
    } catch (error) {
      toast.error(message(error, "That didn't save. Please try again."));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const file = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await work();
    } catch (error) {
      toast.error(message(error, "The packing slip couldn't be made."));
    } finally {
      setBusy(null);
    }
  };

  if (!job) {
    return (
      <div>
        <AdminPageHeader title="Packing" breadcrumbs={[{ label: "Packing", href: "/admin/packing" }, { label: "Order" }]} />
        {loaded.error ? (
          <AdminCard><p role="alert" className="text-sm text-admin-ink">{message(loaded.error, "This packing job didn't load.")}</p></AdminCard>
        ) : (
          <AdminCard><span aria-busy="true" aria-label="Loading packing job" className="block h-48 animate-pulse rounded-[2px] bg-admin-border" /></AdminCard>
        )}
      </div>
    );
  }

  const a = job.actions;
  const order = job.order;
  const editingPackage = typeof editing === "number" ? job.packages.find((p) => p.id === editing) : undefined;

  const completePicking = async () => {
    setBusy("complete-picking");
    try {
      setJob(await packing.completePicking(job.id));
      toast.success("Picking complete.");
    } catch (error) {
      if (error instanceof ApiError && error.code === "PICK_EXCEPTIONS") setAsk({ kind: "pick-override" });
      else toast.error(message(error, "Picking couldn't be completed."));
    } finally {
      setBusy(null);
    }
  };

  const markPacked = () => {
    if (job.validation.critical.length) {
      setAsk({ kind: "pack-confirm" });
      return;
    }
    void run("packed", () => packing.markPacked(job.id), "Packed.");
  };

  return (
    <div>
      <AdminPageHeader
        title={order ? `Pack order #${order.orderNumber}` : "Packing job"}
        description={order ? `${order.customer.name} · placed ${formatDate(order.placedAt)} · ${order.itemCount} item(s) · ${formatPrice(order.total)}` : undefined}
        breadcrumbs={[{ label: "Packing", href: "/admin/packing" }, { label: order ? `#${order.orderNumber}` : `Job ${job.id}` }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PackingStatusBadge status={job.status} label={job.statusLabel} />
            {job.aging ? (
              <span className={job.aging.overdue ? "text-xs font-medium text-[#a12b2b]" : "text-xs text-admin-muted"}>
                {job.aging.overdue ? "Overdue · " : ""}waiting {agingLabel(job.aging.hours)}
              </span>
            ) : null}
          </div>
        }
      />

      {/* ------------------------------------------------------- next steps */}
      <AdminCard className="mb-5">
        <div className="flex flex-wrap items-end gap-3">
          {/* Who packs it: an Admin user ID (docs/id-lookup.md); the server accepts only staff who can pack. */}
          {a.assign && busy === null ? (
            <IdSelector
              entity="admin_user"
              label="Assigned to (Admin user ID)"
              value={job.assignedTo?.id ?? null}
              onChange={(id) => void run("assign", () => packing.assignPacking(job.id, id), id ? "Assigned." : "Unassigned.")}
              hint="Someone who can pack."
              compact
              className="min-w-[14rem]"
            />
          ) : (
            <div className="flex min-w-[12rem] flex-col gap-1.5">
              <span className="text-xs font-medium text-admin-ink">Assigned to</span>
              <span className="text-[0.8125rem] text-admin-ink">
                {job.assignedTo ? (
                  <>
                    {job.assignedTo.name} <span className="font-mono text-admin-muted">{job.assignedTo.id}</span>
                  </>
                ) : (
                  <span className="text-admin-muted">Unassigned</span>
                )}
              </span>
            </div>
          )}
          <AdminSelect
            label="Priority"
            value={job.priority}
            disabled={job.status === "cancelled" || busy !== null}
            onChange={(event) => void run("priority", () =>
              packing.setPackingPriority(job.id, event.target.value as PackingPriority), "Priority saved.")}
            options={[{ value: "normal", label: "Normal" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" }]}
            className="min-w-[9rem]"
          />
          <div className="ml-auto flex flex-wrap gap-2">
            {a.startPicking ? (
              <AdminButton variant="primary" loading={busy === "start-picking"}
                onClick={() => void run("start-picking", () => packing.startPicking(job.id), "Picking started.")}>
                Start picking
              </AdminButton>
            ) : null}
            {a.completePicking ? (
              <AdminButton variant="primary" loading={busy === "complete-picking"} onClick={() => void completePicking()}>
                Picking complete
              </AdminButton>
            ) : null}
            {a.startPacking ? (
              <AdminButton variant="primary" loading={busy === "start-packing"}
                onClick={() => void run("start-packing", () => packing.startPacking(job.id), "Packing started.")}>
                Start packing
              </AdminButton>
            ) : null}
            {job.status === "packing" ? (
              <AdminButton variant="primary" disabled={!a.markPacked} loading={busy === "packed"} onClick={markPacked}>
                <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" /> Mark packed
              </AdminButton>
            ) : null}
            {a.ready ? (
              <AdminButton variant="primary" loading={busy === "ready"}
                onClick={() => void run("ready", () => packing.markReady(job.id), "Ready to ship.")}>
                Ready to ship
              </AdminButton>
            ) : null}
            {a.reopen ? (
              <AdminButton onClick={() => setAsk({ kind: "reopen" })} disabled={busy !== null}>Reopen…</AdminButton>
            ) : null}
          </div>
        </div>
        {job.status === "packing" && !a.markPacked && job.validation.errors.length ? (
          <p className="mt-3 text-xs text-admin-muted">Fix the checks below to mark it packed.</p>
        ) : null}
      </AdminCard>

      <div className="grid items-start gap-5 xl:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-5">
          {/* ---------------------------------------------------- picking */}
          <AdminCard
            title="Pick list"
            description="Count what you take off the shelf. Recording a problem keeps the line visible until it's cleared."
            action={a.pick ? (
              <AdminButton size="sm" loading={busy === "pick-all"}
                onClick={() => void run("pick-all", () => packing.pickAll(job.id), "Everything picked.")}>
                Pick everything
              </AdminButton>
            ) : null}
            padded={false}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-xs">
                <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-3 py-2 font-medium">SKU</th>
                    <th className="px-3 py-2 text-right font-medium">Ordered</th>
                    <th className="px-3 py-2 text-right font-medium">Picked</th>
                    <th className="px-3 py-2 text-right font-medium">Left</th>
                    <th className="px-3 py-2 text-right font-medium">Packed</th>
                    <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-admin-border">
                  {job.lines.map((line) => (
                    <PickRow key={`${line.id}-${line.pickedQty}`} line={line} canPick={a.pick} busy={busy}
                      onPick={(quantity) => void run(`pick-${line.id}`, () => packing.pickLine(job.id, line.id, quantity))}
                      onProblem={() => setAsk({ kind: "exception", line })}
                      onClear={() => void run(`clear-${line.id}`, () => packing.clearException(job.id, line.id), "Problem cleared.")}
                      onDamaged={() => setAsk({ kind: "damaged", line })}
                      canDamaged={["picking", "picked", "packing"].includes(job.status)} />
                  ))}
                </tbody>
              </table>
            </div>
          </AdminCard>

          {/* --------------------------------------------------- packages */}
          <AdminCard
            title={`Packages (${job.packages.length})`}
            description="One order can go in one parcel or several. Each needs its weight and size for the label."
            action={a.editPackages && editing === null ? (
              <AdminButton size="sm" onClick={() => setEditing("new")}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add package
              </AdminButton>
            ) : null}
          >
            <div className="flex flex-col gap-3">
              {editing === "new" ? (
                <PackageForm lines={job.lines} defaults={job.defaultPackage} divisor={job.volumetricDivisor}
                  busy={busy === "package"} onCancel={() => setEditing(null)}
                  onSave={(input: PackageInput) => void run("package", () => packing.addPackage(job.id, input), "Package added.")
                    .then((saved) => saved && setEditing(null))} />
              ) : null}
              {job.packages.length === 0 && editing !== "new" ? (
                <p className="text-xs text-admin-muted">
                  {a.editPackages ? "No packages yet. Add one once the items are picked." : "Packages are added once picking is done."}
                </p>
              ) : null}
              {job.packages.map((pkg) => (
                editing === pkg.id && editingPackage ? (
                  <PackageForm key={pkg.id} lines={job.lines} existing={editingPackage} defaults={null}
                    divisor={job.volumetricDivisor} busy={busy === "package"} onCancel={() => setEditing(null)}
                    onSave={(input) => void run("package", () => packing.updatePackage(job.id, pkg.id, input), "Package saved.")
                      .then((saved) => saved && setEditing(null))} />
                ) : (
                  <div key={pkg.id} className="rounded-[3px] border border-admin-border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-admin-ink">{pkg.packageNumber}
                          <span className="ml-2 text-xs font-normal capitalize text-admin-muted">{pkg.type}</span></p>
                        <p className="mt-0.5 text-xs text-admin-muted">
                          {weightLabel(pkg.weightGrams)} · {dimensionsLabel(pkg.lengthCm, pkg.widthCm, pkg.heightCm)}
                          {pkg.volumetricWeightKg ? ` · volumetric ${pkg.volumetricWeightKg} kg` : ""}
                        </p>
                      </div>
                      {a.editPackages ? (
                        <div className="flex gap-1">
                          <AdminButton size="sm" variant="ghost" aria-label={`Edit ${pkg.packageNumber}`} onClick={() => setEditing(pkg.id)}>
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </AdminButton>
                          <AdminButton size="sm" variant="ghost" aria-label={`Remove ${pkg.packageNumber}`}
                            onClick={() => setAsk({ kind: "remove-package", packageId: pkg.id, packageNumber: pkg.packageNumber })}>
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </AdminButton>
                        </div>
                      ) : null}
                    </div>
                    <ul className="mt-2 text-xs text-admin-ink">
                      {pkg.items.map((item) => (
                        <li key={item.lineId}>{item.quantity} × {item.name}
                          <span className="text-admin-muted"> ({item.sku}{item.size ? `, ${item.size}` : ""}{item.color ? `, ${item.color}` : ""})</span></li>
                      ))}
                    </ul>
                    {pkg.notes ? <p className="mt-1 text-xs text-admin-muted">{pkg.notes}</p> : null}
                  </div>
                )
              ))}
            </div>
          </AdminCard>

          {/* ---------------------------------------------------- history */}
          <AdminCard title="History">
            {job.events.length === 0 ? (
              <p className="text-xs text-admin-muted">Nothing has happened yet.</p>
            ) : (
              <ol className="flex flex-col gap-2 text-xs">
                {[...job.events].reverse().map((event) => (
                  <li key={event.id} className="flex gap-3">
                    <span className="w-32 shrink-0 text-admin-muted">{formatDate(event.at)}</span>
                    <span className="min-w-0 text-admin-ink">
                      <span className="font-medium">{event.actorName}</span> · {event.action.replace(/-/g, " ")}
                      {event.fromStatus && event.toStatus && event.fromStatus !== event.toStatus
                        ? <span className="text-admin-muted"> ({event.fromStatus} → {event.toStatus})</span> : null}
                      {event.note ? <span className="block text-admin-muted">{event.note}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </AdminCard>
        </div>

        {/* ------------------------------------------------------- side */}
        <div className="flex flex-col gap-5">
          <AdminCard title="Checks before packing">
            {job.validation.errors.length === 0 && job.validation.critical.length === 0 ? (
              <p className="flex items-center gap-1.5 text-xs text-[#0a6b0a]">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Everything checks out.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-xs">
                {job.validation.errors.map((issue, index) => (
                  <li key={`e-${index}`} className="flex gap-1.5 text-[#a12b2b]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{issue.message}
                  </li>
                ))}
                {job.validation.critical.map((issue, index) => (
                  <li key={`c-${index}`} className="flex gap-1.5 text-[#8a5a12]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{issue.message} <span className="text-admin-muted">(needs confirmation)</span></span>
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>

          <AdminCard title="Packing slip">
            <div className="flex flex-wrap gap-2">
              <AdminButton size="sm" disabled={!a.slip} loading={busy === "slip-open"}
                onClick={() => void file("slip-open", () => packing.openPdf(packing.packingSlipPath(job.id)))}>
                <Eye className="h-3.5 w-3.5" aria-hidden="true" /> Preview
              </AdminButton>
              <AdminButton size="sm" disabled={!a.slip} loading={busy === "slip-print"}
                onClick={() => void file("slip-print", () => packing.printPdf(packing.packingSlipPath(job.id)))}>
                <Printer className="h-3.5 w-3.5" aria-hidden="true" /> Print
              </AdminButton>
              <AdminButton size="sm" disabled={!a.slip} loading={busy === "slip-download"}
                onClick={() => void file("slip-download", () => packing.downloadPackingSlip(job.id))}>
                <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download
              </AdminButton>
            </div>
            <p className="mt-2 text-[0.6875rem] text-admin-muted">
              Prices are {job.slipShowPrices ? "shown" : "hidden"} on the slip by default (Settings → Couriers).
            </p>
          </AdminCard>

          {order ? (
            <AdminCard title="Delivery">
              <p className="text-xs text-admin-ink">{order.customer.name}</p>
              <p className="text-xs text-admin-muted">{Object.values(order.shippingAddress ?? {}).filter(Boolean).join(", ")}</p>
              <p className="mt-2 text-xs text-admin-muted">
                {order.deliveryMethod} delivery · {order.paymentStatus === "cod-pending" ? "cash on delivery" : order.paymentStatus}
              </p>
              <Link href={`/admin/orders/detail?id=${encodeURIComponent(order.id)}`} className="mt-2 inline-block text-xs text-copper-700 underline">
                Open the order
              </Link>
            </AdminCard>
          ) : null}

          <AdminCard title="Shipment">
            {job.shipment ? (
              <div className="text-xs">
                <Link href={`/admin/shipments/detail?id=${job.shipment.id}`} className="font-medium text-admin-ink hover:text-copper-700">
                  {job.shipment.shipmentNumber}
                </Link>
                <p className="text-admin-muted">{job.shipment.courierName || "Courier not chosen"}{job.shipment.awb ? ` · AWB ${job.shipment.awb}` : ""}</p>
                <p className="text-admin-muted">{job.shipment.linked ? "Packages handed over." : "Not yet linked to these packages."}</p>
              </div>
            ) : (
              <p className="text-xs text-admin-muted">
                No shipment yet. Once packed, create one from the order&rsquo;s page — it takes these packages&rsquo; weight and size.
              </p>
            )}
          </AdminCard>
        </div>
      </div>

      <AskDialogs key={askKey} job={job} ask={ask} setAsk={setAsk} busy={busy} run={run} />
    </div>
  );
}

function PickRow({
  line, canPick, canDamaged, busy, onPick, onProblem, onClear, onDamaged,
}: {
  line: PackingLineView;
  canPick: boolean;
  canDamaged: boolean;
  busy: string | null;
  onPick: (quantity: number) => void;
  onProblem: () => void;
  onClear: () => void;
  onDamaged: () => void;
}) {
  // Keyed on the saved count, so a new count from the server starts the field again.
  const [value, setValue] = useState(String(line.pickedQty));
  const n = Number(value);
  const valid = value !== "" && Number.isInteger(n) && n >= 0 && n <= line.quantity;

  return (
    <tr className="align-top">
      <td className="px-3 py-2.5">
        <span className="text-admin-ink">{line.name}</span>
        {line.size || line.color ? <span className="block text-admin-muted">{[line.size, line.color].filter(Boolean).join(" · ")}</span> : null}
        {line.exception ? (
          <span className="mt-1 block text-[#a12b2b]">
            {line.exception.label} × {line.exception.quantity}: {line.exception.note}
          </span>
        ) : null}
        {line.damagedRecordedQty ? (
          <span className="block text-[0.625rem] text-admin-muted">{line.damagedRecordedQty} written off as damaged</span>
        ) : null}
      </td>
      <td className="px-3 py-2.5 font-mono text-[0.6875rem] text-admin-muted">{line.sku || "—"}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{line.quantity}</td>
      <td className="px-3 py-2.5 text-right">
        {canPick ? (
          <form onSubmit={(event) => { event.preventDefault(); if (valid) onPick(n); }} className="inline-flex items-center gap-1">
            <input aria-label={`Picked quantity of ${line.name}`} inputMode="numeric" value={value}
              onChange={(event) => setValue(event.target.value.replace(/\D/g, ""))}
              aria-invalid={!valid}
              className="h-7 w-14 rounded-[3px] border border-admin-border px-1.5 text-right tabular-nums" />
            <AdminButton size="sm" type="submit" disabled={!valid || n === line.pickedQty || busy !== null}
              loading={busy === `pick-${line.id}`}>Save</AdminButton>
          </form>
        ) : (
          <span className="tabular-nums">{line.pickedQty}</span>
        )}
      </td>
      <td className={line.remainingQty ? "px-3 py-2.5 text-right tabular-nums text-[#8a5a12]" : "px-3 py-2.5 text-right tabular-nums text-admin-muted"}>
        {line.remainingQty}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-admin-muted">{line.allocatedQty}</td>
      <td className="px-3 py-2.5 text-right">
        <div className="flex justify-end gap-1">
          {line.exception ? (
            <AdminButton size="sm" variant="ghost" disabled={busy !== null} onClick={onClear}>Clear problem</AdminButton>
          ) : canPick ? (
            <AdminButton size="sm" variant="ghost" disabled={busy !== null} onClick={onProblem}>Problem…</AdminButton>
          ) : null}
          {canDamaged && line.damagedRecordedQty < line.quantity ? (
            <AdminButton size="sm" variant="ghost" disabled={busy !== null} onClick={onDamaged}>Damaged stock…</AdminButton>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function AskDialogs({
  job, ask, setAsk, busy, run,
}: {
  job: PackingJob;
  ask: Ask;
  setAsk: (ask: Ask) => void;
  busy: string | null;
  run: (key: string, work: () => Promise<PackingJob>, done?: string) => Promise<boolean>;
}) {
  const [type, setType] = useState<PickException>("missing-stock");
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [target, setTarget] = useState<"picking" | "packing">(job.status === "packed" ? "packing" : "picking");

  const close = () => setAsk(null);
  const finish = (ok: boolean) => ok && close();
  const reasonOk = note.trim().length >= 3;
  const q = Number(quantity);

  if (ask?.kind === "remove-package") {
    return (
      <ConfirmDialog open onOpenChange={(open) => !open && close()} title={`Remove ${ask.packageNumber}?`}
        message="Its items go back to being unpacked. This is recorded in the history." confirmLabel="Remove package"
        loading={busy === "remove"}
        onConfirm={() => void run("remove", () => packing.removePackage(job.id, ask.packageId), "Package removed.").then(finish)} />
    );
  }

  const title = ask?.kind === "exception" ? `Problem with ${ask.line.name}`
    : ask?.kind === "damaged" ? `Write off damaged ${ask.line.name}`
      : ask?.kind === "pick-override" ? "Finish picking with problems recorded?"
        : ask?.kind === "pack-confirm" ? "Mark packed despite warnings?"
          : "Reopen this job";

  return (
    <Modal open={ask !== null} onOpenChange={(open) => !open && close()} title={title} className="max-w-md">
      <div className="flex flex-col gap-3">
        {ask?.kind === "exception" ? (
          <>
            <AdminSelect label="What's wrong" value={type} onChange={(e) => setType(e.target.value as PickException)}
              options={Object.entries(EXCEPTION_LABELS).map(([value, label]) => ({ value, label }))} />
            <AdminInput label={`How many (of ${ask.line.quantity})`} inputMode="numeric" value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))} />
          </>
        ) : null}
        {ask?.kind === "damaged" ? (
          <>
            <p className="text-xs text-admin-muted">
              Removes the broken units from stock through the stock ledger (reason &ldquo;damaged&rdquo;). The units this
              order needs were already taken when it was sold.
            </p>
            <AdminInput label={`Units to write off (up to ${ask.line.quantity - ask.line.damagedRecordedQty})`}
              inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))} />
          </>
        ) : null}
        {ask?.kind === "pack-confirm" ? (
          <ul className="flex flex-col gap-1 text-xs text-[#8a5a12]">
            {job.validation.critical.map((issue, index) => <li key={index}>{issue.message}</li>)}
          </ul>
        ) : null}
        {ask?.kind === "reopen" ? (
          <AdminSelect label="Back to" value={target} onChange={(e) => setTarget(e.target.value as "picking" | "packing")}
            options={[{ value: "picking", label: "Picking" }, ...(job.status === "packed" ? [{ value: "packing", label: "Packing" }] : [])]} />
        ) : null}
        <AdminTextarea label={ask?.kind === "exception" || ask?.kind === "damaged" ? "Note" : "Reason"} rows={3}
          value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
          hint="At least 3 characters. Kept in the history." required />
        <div className="flex justify-end gap-2">
          <AdminButton onClick={close} disabled={busy !== null}>Cancel</AdminButton>
          <AdminButton variant="primary" disabled={!reasonOk || ((ask?.kind === "exception" || ask?.kind === "damaged") && !(q >= 1))}
            loading={busy === "ask"}
            onClick={() => {
              if (!ask) return;
              const work = ask.kind === "exception" ? () => packing.recordException(job.id, ask.line.id, { type, quantity: q, note: note.trim() })
                : ask.kind === "damaged" ? () => packing.recordDamaged(job.id, ask.line.id, { quantity: q, note: note.trim() })
                  : ask.kind === "pick-override" ? () => packing.completePicking(job.id, note.trim())
                    : ask.kind === "pack-confirm" ? () => packing.markPacked(job.id, { confirm: true, overrideReason: note.trim() })
                      : () => packing.reopenPacking(job.id, target, note.trim());
              void run("ask", work, "Saved.").then(finish);
            }}>
            Confirm
          </AdminButton>
        </div>
      </div>
    </Modal>
  );
}
