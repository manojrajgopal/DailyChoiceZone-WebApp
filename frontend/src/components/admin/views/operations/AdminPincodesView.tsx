"use client";

import { useRef, useState } from "react";
import { Download, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminToggle } from "@/components/admin/ui/AdminForm";
import { FilterSelect, LogFooter, LogSearch, StatusTabs, downloadCsv, useUrlFilters } from "@/components/admin/ui/LogPage";
import { DeliveryEstimateSettings } from "@/components/admin/views/discovery/DeliveryEstimateSettings";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";
import {
  createPincode,
  deletePincode,
  exportPincodes,
  importPincodes,
  listPincodes,
  saveDeliverySettings,
  updatePincode,
  type PincodeImportResult,
  type PincodeInput,
  type PincodeRow,
} from "@/services/admin/operationsAdminService";
import { toast } from "@/store/toastStore";

import { Badge, TD, TH, TableState, problem } from "./shared";

const KEYS = ["q", "state", "active", "serviceable", "cod"] as const;

const BLANK: PincodeInput = {
  pincode: "",
  city: "",
  district: "",
  state: "",
  serviceable: true,
  codAvailable: true,
  expressAvailable: true,
  minDays: null,
  maxDays: null,
  deliveryFee: null,
  courier: "",
  notes: "",
  active: true,
};

const TEMPLATE = "pincode,city,district,state,serviceable,codAvailable,expressAvailable,minDays,maxDays,deliveryFee,courier,active,notes\n";

/**
 * The pincodes the store delivers to, on what terms. Checked by the product
 * page and checkout, and enforced by the server when an order is placed.
 */
export function AdminPincodesView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const [editing, setEditing] = useState<{ id: number | null; value: PincodeInput } | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<PincodeRow | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<PincodeImportResult | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const list = useAdminResource(() => listPincodes({ ...filters, page, pageSize }), [filters, page, pageSize]);
  const data = list.data;
  const filtered = Object.values(filters).some(Boolean);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      if (editing.id === null) await createPincode(editing.value);
      else await updatePincode(editing.id, editing.value);
      toast.success(editing.id === null ? `${editing.value.pincode} added.` : `${editing.value.pincode} saved.`);
      setEditing(null);
      await list.reload();
    } catch (error) {
      toast.error(problem(error, "The pincode wasn't saved."));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setSaving(true);
    try {
      await deletePincode(removing.id);
      toast.success(`${removing.pincode} removed.`);
      setRemoving(null);
      await list.reload();
    } catch (error) {
      toast.error(problem(error, "The pincode wasn't removed."));
    } finally {
      setSaving(false);
    }
  };

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    if (!chosen) return;
    if (chosen.size > 2_000_000) {
      toast.error("That file is too large. Import up to 5,000 rows at a time.");
      return;
    }
    setImporting(true);
    try {
      const result = await importPincodes(await chosen.text());
      setImported(result);
      if (result.errorCount) toast.error(`Nothing was imported — ${result.errorCount} rows need fixing.`);
      else toast.success(`Imported: ${result.created} added, ${result.updated} updated.`);
      await list.reload();
    } catch (error) {
      toast.error(problem(error, "The import didn't work."));
    } finally {
      setImporting(false);
    }
  };

  const exportAll = async () => {
    try {
      const { items, columns } = await exportPincodes();
      downloadCsv(
        `pincodes-${new Date().toISOString().slice(0, 10)}.csv`,
        columns,
        items.map((row) => columns.map((column) => {
          const value = row[column];
          return typeof value === "boolean" ? (value ? "yes" : "no") : (value as string | number | null);
        })),
      );
    } catch (error) {
      toast.error(problem(error, "The export didn't work."));
    }
  };

  const toggleRestrict = async (restrictToListed: boolean) => {
    try {
      await saveDeliverySettings({ restrictToListed });
      toast.success(restrictToListed ? "Only listed pincodes can be ordered to now." : "Unlisted pincodes can be ordered to again.");
      await list.reload();
    } catch (error) {
      toast.error(problem(error, "The setting wasn't saved."));
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="Delivery pincodes"
        description="Where you deliver, whether cash on delivery and express are offered there, how long it takes and what it costs."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Delivery pincodes" }]}
        actions={
          <>
            <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
              {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Refresh
            </AdminButton>
            <AdminButton size="sm" onClick={() => void exportAll()} disabled={!data || data.pagination.total === 0}>
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Export CSV
            </AdminButton>
            <AdminButton size="sm" onClick={() => file.current?.click()} loading={importing}>
              {importing ? null : <Upload className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Import CSV
            </AdminButton>
            <input ref={file} type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => void onFile(event)} />
            <AdminButton size="sm" variant="primary" onClick={() => setEditing({ id: null, value: { ...BLANK } })}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Add pincode
            </AdminButton>
          </>
        }
      />

      <AdminCard className="mb-5">
        <AdminToggle
          label="Deliver only to listed pincodes"
          description={
            data?.settings.restrictToListed
              ? "On: checkout refuses any pincode not listed below (and active)."
              : "Off: pincodes not listed are delivered to at the standard terms. Listed ones use their own terms, and those marked not serviceable are refused."
          }
          checked={Boolean(data?.settings.restrictToListed)}
          disabled={!data}
          onChange={(value) => void toggleRestrict(value)}
        />
      </AdminCard>

      <DeliveryEstimateSettings />

      {imported && imported.errorCount ? (
        <AdminCard title="Import problems" description="Fix these rows and import the file again. Nothing was changed." className="mb-5" action={
          <AdminButton size="sm" variant="ghost" onClick={() => setImported(null)} aria-label="Dismiss import problems">
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          </AdminButton>
        }>
          <ul className="flex flex-col gap-1 text-xs">
            {imported.errors.map((row) => (
              <li key={`${row.line}-${row.pincode}`}>
                <span className="font-medium text-admin-ink">Line {row.line}</span>
                {row.pincode ? ` (${row.pincode})` : ""}: <span className="text-[#a12b2b]">{row.error}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-admin-muted">
            Columns: <code>{TEMPLATE.trim()}</code>. Only <code>pincode</code> is required; yes/no for the flags, fee in rupees.
          </p>
        </AdminCard>
      ) : null}

      <StatusTabs
        label="Filter by state"
        value={filters.active}
        onChange={(active) => setFilters({ active })}
        tabs={[
          { value: "", label: "All" },
          { value: "yes", label: "Active", count: data?.counts.active },
          { value: "no", label: "Disabled", count: data?.counts.inactive },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch label="Search pincodes" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Pincode, city, district or state" />
        <FilterSelect
          label="State"
          value={filters.state}
          onChange={(state) => setFilters({ state })}
          options={[{ value: "", label: "All states" }, ...(data?.states ?? []).map((state) => ({ value: state, label: state }))]}
        />
        <FilterSelect
          label="Serviceable"
          value={filters.serviceable}
          onChange={(serviceable) => setFilters({ serviceable })}
          options={[
            { value: "", label: "Serviceable or not" },
            { value: "yes", label: "Delivered to" },
            { value: "no", label: "Not delivered to" },
          ]}
        />
        <FilterSelect
          label="Cash on delivery"
          value={filters.cod}
          onChange={(cod) => setFilters({ cod })}
          options={[
            { value: "", label: "Any payment" },
            { value: "yes", label: "COD available" },
            { value: "no", label: "No COD" },
          ]}
        />
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[56rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Pincode</th>
                <th className={TH}>Place</th>
                <th className={TH}>Delivery</th>
                <th className={TH}>COD</th>
                <th className={TH}>Express</th>
                <th className={TH}>Days</th>
                <th className={cn(TH, "text-right")}>Fee</th>
                <th className={TH}>Courier</th>
                <th className={cn(TH, "text-right")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={9}
                loading={list.isLoading && !data}
                failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void list.reload()}
                title={filtered ? "No pincodes match" : "No pincodes listed yet"}
                hint={filtered ? "Try a different filter or search." : "Add pincodes one at a time or import a CSV."}
              />
              {data?.items.map((row) => (
                <tr key={row.id} className={cn("align-top hover:bg-admin-raised", !row.active && "opacity-60")}>
                  <td className={cn(TD, "font-medium tabular-nums text-admin-ink")}>
                    {row.pincode}
                    {!row.active ? <span className="block text-[0.625rem] font-normal text-admin-faint">Disabled</span> : null}
                  </td>
                  <td className={cn(TD, "text-admin-muted")}>{[row.city, row.district, row.state].filter(Boolean).join(", ") || "—"}</td>
                  <td className={TD}>
                    <Badge tone={row.serviceable ? "green" : "red"}>{row.serviceable ? "Delivered" : "Not delivered"}</Badge>
                  </td>
                  <td className={TD}>{row.serviceable ? (row.codAvailable ? "Yes" : "No") : "—"}</td>
                  <td className={TD}>{row.serviceable ? (row.expressAvailable ? "Yes" : "No") : "—"}</td>
                  <td className={cn(TD, "tabular-nums")}>
                    {row.minDays !== null || row.maxDays !== null ? `${row.minDays ?? "?"}–${row.maxDays ?? "?"}` : "Standard"}
                  </td>
                  <td className={cn(TD, "text-right tabular-nums")}>{row.deliveryFee !== null ? formatPrice(row.deliveryFee) : "Standard"}</td>
                  <td className={cn(TD, "text-admin-muted")}>{row.courier || "—"}</td>
                  <td className={cn(TD, "whitespace-nowrap text-right")}>
                    <AdminButton
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing({ id: row.id, value: { ...row } })}
                      aria-label={`Edit ${row.pincode}`}
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    </AdminButton>
                    <AdminButton size="sm" variant="ghost" onClick={() => setRemoving(row)} aria-label={`Remove ${row.pincode}`}>
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    </AdminButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {data ? (
        <LogFooter
          page={data.pagination.page}
          pageSize={pageSize}
          total={data.pagination.total}
          totalPages={data.pagination.total_pages}
          onPage={setPage}
          onPageSize={setPageSize}
        />
      ) : null}

      <Modal
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.id === null ? "Add a pincode" : `Edit ${editing?.value.pincode ?? ""}`}
        className="max-w-xl"
      >
        {editing ? (
          <PincodeForm value={editing.value} onChange={(value) => setEditing({ ...editing, value })} onSave={() => void save()} saving={saving} />
        ) : null}
      </Modal>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.pincode ?? "this pincode"}?`}
        message="Orders already placed aren't affected. New orders to it follow the setting for unlisted pincodes. To stop delivering there, mark it not serviceable instead."
        confirmLabel="Remove"
        loading={saving}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function PincodeForm({
  value,
  onChange,
  onSave,
  saving,
}: {
  value: PincodeInput;
  onChange: (value: PincodeInput) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const set = <K extends keyof PincodeInput>(key: K, next: PincodeInput[K]) => onChange({ ...value, [key]: next });
  const number = (text: string) => (text.trim() === "" ? null : Number(text));
  const validPin = /^[1-9]\d{5}$/.test(value.pincode);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <AdminInput
          label="Pincode"
          inputMode="numeric"
          maxLength={6}
          value={value.pincode}
          onChange={(event) => set("pincode", event.target.value.replace(/\D/g, ""))}
          error={value.pincode && !validPin ? "Six digits, not starting with 0." : undefined}
          required
        />
        <AdminInput label="City" value={value.city} onChange={(event) => set("city", event.target.value)} maxLength={120} />
        <AdminInput label="District" value={value.district} onChange={(event) => set("district", event.target.value)} maxLength={120} />
        <AdminInput label="State" value={value.state} onChange={(event) => set("state", event.target.value)} maxLength={120} />
      </div>
      <AdminCheckbox label="We deliver here" checked={value.serviceable} onChange={(event) => set("serviceable", event.target.checked)} />
      {value.serviceable ? (
        <>
          <div className="flex flex-wrap gap-5">
            <AdminCheckbox label="Cash on delivery" checked={value.codAvailable} onChange={(event) => set("codAvailable", event.target.checked)} />
            <AdminCheckbox label="Express delivery" checked={value.expressAvailable} onChange={(event) => set("expressAvailable", event.target.checked)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <AdminInput
              label="Fastest (days)"
              type="number"
              min={0}
              max={60}
              value={value.minDays ?? ""}
              onChange={(event) => set("minDays", number(event.target.value))}
              hint="Blank: store default"
            />
            <AdminInput
              label="Slowest (days)"
              type="number"
              min={0}
              max={60}
              value={value.maxDays ?? ""}
              onChange={(event) => set("maxDays", number(event.target.value))}
            />
            <AdminInput
              label="Delivery fee"
              type="number"
              min={0}
              step="0.01"
              prefix="₹"
              value={value.deliveryFee ?? ""}
              onChange={(event) => set("deliveryFee", number(event.target.value))}
              hint="Blank: standard fee"
            />
          </div>
          <AdminInput label="Courier" value={value.courier} onChange={(event) => set("courier", event.target.value)} maxLength={60} />
        </>
      ) : null}
      <AdminInput label="Notes (internal)" value={value.notes} onChange={(event) => set("notes", event.target.value)} maxLength={255} />
      <AdminCheckbox
        label="Active"
        description="A disabled entry is ignored, as if it weren't listed."
        checked={value.active}
        onChange={(event) => set("active", event.target.checked)}
      />
      <div>
        <AdminButton type="submit" variant="primary" loading={saving} disabled={!validPin}>
          Save pincode
        </AdminButton>
      </div>
    </form>
  );
}
