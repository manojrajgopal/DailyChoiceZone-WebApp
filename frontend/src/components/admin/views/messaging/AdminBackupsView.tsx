"use client";

import { useEffect, useState } from "react";
import { Download, HardDrive, Play, RefreshCw } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { LogFooter, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Badge, TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatAgo, formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { apiUrl } from "@/services/api/client";
import {
  type BackupRow,
  type BackupSettings,
  backupDownloadLink,
  getBackups,
  runBackup,
  saveBackupSettings,
} from "@/services/admin/messagingAdminService";
import { toast } from "@/store/toastStore";

const STATUS: Record<BackupRow["status"], { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  succeeded: { label: "Verified", tone: "green" }, running: { label: "Running", tone: "amber" },
  failed: { label: "Failed", tone: "red" }, deleted: { label: "Expired", tone: "grey" },
};
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const KEYS = ["status"] as const;

function size(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Settings → Backups. Automatic MySQL backups: each one encrypted, stored
 * privately and verified by reading it back. Downloads use a link that works
 * for five minutes; restoring is done on a new database, never here.
 */
export function AdminBackupsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize } = useUrlFilters(KEYS);
  const data = useAdminResource(() => getBackups({ status: filters.status, page, pageSize }), [filters, page, pageSize]);
  const page_ = data.data;
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (page_) setSettings(page_.settings);
  }, [page_]);

  const run = async () => {
    setBusy("run");
    try {
      const row = await runBackup();
      toast.success(`Backup ${row.reference} complete and verified.`);
    } catch (error) {
      toast.error(problem(error, "The backup failed."));
    } finally {
      setBusy("");
      void data.reload();
    }
  };

  const save = async () => {
    if (!settings) return;
    setBusy("save");
    try {
      setSettings(await saveBackupSettings(settings));
      toast.success("Backup settings saved.");
      void data.reload();
    } catch (error) {
      toast.error(problem(error, "The settings weren't saved."));
    } finally {
      setBusy("");
    }
  };

  const download = async (row: BackupRow) => {
    setBusy(`dl-${row.id}`);
    try {
      const link = await backupDownloadLink(row.id);
      // A direct storage link (S3) opens as is; the API's own link needs its origin.
      const href = link.url.startsWith("http") ? link.url : apiUrl(link.url.replace(/^\/api/, ""));
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = link.fileName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      toast.success("Download started. The link works for five minutes.");
    } catch (error) {
      toast.error(problem(error, "The download link couldn't be made."));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <AdminPageHeader title="Backups"
        description="Automatic database backups — encrypted, stored privately, and checked by reading each one back."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Settings" }, { label: "Backups" }]}
        actions={
          <div className="flex gap-2">
            <AdminButton size="sm" onClick={() => void data.reload()} loading={data.isRefreshing}>
              {data.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
            </AdminButton>
            <AdminButton size="sm" variant="primary" onClick={() => void run()} loading={busy === "run"}>
              {busy === "run" ? null : <Play className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Back up now
            </AdminButton>
          </div>
        } />

      {!page_ ? <p className="py-10 text-center text-sm text-admin-muted">{data.error ? problem(data.error, "Backups didn't load.") : "Loading…"}</p> : (
        <div className="flex flex-col gap-4">
          {page_.warnings.map((w) => <p key={w} role="alert" className="rounded-[3px] bg-[#fdf3e3] p-3 text-xs text-[#8a5a12]">{w}</p>)}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Tile label="Status" value={page_.running ? "Running" : page_.lastSuccess && (!page_.lastFailure || page_.lastFailure.startedAt < page_.lastSuccess.startedAt) ? "Healthy" : page_.lastFailure ? "Last run failed" : "No backups yet"}
              tone={page_.running ? "warn" : page_.lastFailure && (!page_.lastSuccess || page_.lastFailure.startedAt > page_.lastSuccess.startedAt) ? "bad" : page_.lastSuccess ? "good" : "warn"} />
            <Tile label="Last good backup" value={page_.lastSuccess ? formatAgo(page_.lastSuccess.completedAt ?? page_.lastSuccess.startedAt) : "—"} hint={page_.lastSuccess ? size(page_.lastSuccess.sizeBytes) : undefined} />
            <Tile label="Last failure" value={page_.lastFailure ? formatAgo(page_.lastFailure.startedAt) : "None"} />
            <Tile label="Next backup" value={page_.nextRun ? formatDateTime(page_.nextRun) : "Off"} />
            <Tile label="Kept" value={`${page_.kept} · ${size(page_.keptBytes)}`} hint={page_.storage.freeBytes ? `${size(page_.storage.freeBytes)} free` : page_.storage.location} />
          </div>

          {settings ? (
            <AdminCard title="Schedule and retention" description="Times are India time. Older backups are deleted automatically by these rules; the newest verified backup is always kept."
              action={<AdminButton size="sm" variant="primary" onClick={() => void save()} loading={busy === "save"} disabled={JSON.stringify(settings) === JSON.stringify(page_.settings)}>Save</AdminButton>}>
              <AdminToggle label="Back up automatically" checked={settings.enabled} onChange={(enabled) => setSettings({ ...settings, enabled })} />
              <FormGrid>
                <AdminSelect label="How often" value={settings.frequency} onChange={(e) => setSettings({ ...settings, frequency: e.target.value as BackupSettings["frequency"] })}
                  options={[{ value: "6h", label: "Every 6 hours" }, { value: "12h", label: "Every 12 hours" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }]} />
                {settings.frequency === "daily" || settings.frequency === "weekly" ? (
                  <AdminSelect label="At" value={String(settings.hour)} onChange={(e) => setSettings({ ...settings, hour: Number(e.target.value) })}
                    options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }))} />
                ) : null}
                <AdminSelect label={settings.frequency === "weekly" ? "On" : "Weekly copy kept from"} value={String(settings.weekday)}
                  onChange={(e) => setSettings({ ...settings, weekday: Number(e.target.value) })}
                  options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />
                <AdminInput label="Keep daily backups (days)" type="number" min={1} max={365} value={settings.keepDailyDays} onChange={(e) => setSettings({ ...settings, keepDailyDays: Number(e.target.value) })} />
                <AdminInput label="Keep weekly backups (weeks)" type="number" min={0} max={104} value={settings.keepWeeklyWeeks} onChange={(e) => setSettings({ ...settings, keepWeeklyWeeks: Number(e.target.value) })} />
                <AdminInput label="Keep manual backups" type="number" min={1} max={100} value={settings.keepManual} onChange={(e) => setSettings({ ...settings, keepManual: Number(e.target.value) })} />
              </FormGrid>
              <p className="mt-3 flex items-center gap-2 text-[0.6875rem] text-admin-muted">
                <HardDrive className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Stored in: {page_.storage.location || page_.storage.storage}{page_.encrypted ? " · encrypted with AES-256" : " · not encrypted"}
              </p>
            </AdminCard>
          ) : null}

          <StatusTabs label="Which backups" value={filters.status} onChange={(status) => setFilters({ status })}
            tabs={[{ value: "", label: "All" }, ...(["succeeded", "failed", "running", "deleted"] as const).map((s) => ({ value: s, label: STATUS[s].label, count: page_.counts[s] }))]} />
          <AdminCard padded={false}>
            <div className="overflow-x-auto">
              <table className={cn("w-full min-w-[60rem] text-left text-xs", data.isRefreshing && "opacity-60")}>
                <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                  <tr><th className={TH}>Backup</th><th className={TH}>Status</th><th className={TH}>Started</th><th className={TH}>Took</th>
                    <th className={cn(TH, "text-right")}>Size</th><th className={TH}>Contents</th><th className={TH}>Checksum (SHA-256)</th><th className={TH}><span className="sr-only">Download</span></th></tr>
                </thead>
                <tbody className="divide-y divide-admin-border">
                  <TableState columns={8} loading={data.isLoading && !page_} failed={false} empty={page_.items.length === 0} onRetry={() => void data.reload()}
                    title="No backups yet" hint="The first runs on schedule, or press Back up now." />
                  {page_.items.map((row) => (
                    <tr key={row.id} className="align-top">
                      <td className={TD}><span className="font-mono text-admin-ink">{row.reference}</span>
                        <span className="block text-admin-muted">{row.tier} · {row.trigger} · {row.databaseName} · {row.storage}</span></td>
                      <td className={TD}><Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                        {row.error ? <span className="mt-1 block max-w-xs text-[#a32424]">{row.error}</span> : null}</td>
                      <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.startedAt)}</td>
                      <td className={cn(TD, "text-admin-muted")}>{row.durationSeconds !== null ? `${row.durationSeconds}s` : "—"}</td>
                      <td className={cn(TD, "text-right tabular-nums")}>{size(row.sizeBytes)}</td>
                      <td className={cn(TD, "text-admin-muted")}>{row.tables ? `${row.tables} tables · ${row.rows.toLocaleString("en-IN")} rows` : "—"}{row.encrypted ? <span className="block">Encrypted</span> : null}</td>
                      <td className={cn(TD, "max-w-[10rem] truncate font-mono text-admin-muted")} title={row.checksum}>{row.checksum ? `${row.checksum.slice(0, 16)}…` : "—"}</td>
                      <td className={cn(TD, "text-right")}>{row.status === "succeeded" ? (
                        <AdminButton size="sm" variant="ghost" loading={busy === `dl-${row.id}`} onClick={() => void download(row)}>
                          {busy === `dl-${row.id}` ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Download
                        </AdminButton>) : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminCard>
          <LogFooter page={page_.pagination.page} pageSize={pageSize} total={page_.pagination.total}
            totalPages={page_.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} />
          <AdminCard title="Restoring a backup">
            <ol className="list-decimal pl-5 text-xs leading-relaxed text-admin-muted">
              <li>Download the backup. Keep it somewhere private — it holds every customer&rsquo;s details.</li>
              <li>On a trusted machine with the API code: <code className="font-mono text-admin-ink">python -m app.tools.backup verify &lt;file&gt;</code>, then <code className="font-mono text-admin-ink">python -m app.tools.backup decrypt &lt;file&gt; restore.sql</code> (needs the same BACKUP_ENCRYPTION_KEY).</li>
              <li>Load it into a <strong>new, empty</strong> database and check it there. Never load it over the live database.</li>
              <li>Switch the API&rsquo;s DATABASE_NAME to the restored database only once it&rsquo;s checked. Full steps: docs/messaging-and-backups.md.</li>
            </ol>
          </AdminCard>
        </div>
      )}
    </div>
  );
}
