"use client";

import { useState } from "react";
import { Play, RefreshCw } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { HealthBadge, utc } from "@/components/admin/views/growth/shared";
import { TD, TH, Tile, problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatAgo, formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { type HealthReport, getHealth, runHealth } from "@/services/admin/growthAdminService";
import { toast } from "@/store/toastStore";

const ORDER = ["database", "migrations", "payments", "email", "jobs", "storage", "disk", "application"];
const DOT: Record<string, string> = { healthy: "bg-[#2f9e44]", degraded: "bg-[#d99a1e]", unhealthy: "bg-[#c23434]", unknown: "bg-admin-border" };

const FACT_LABELS: Record<string, string> = {
  provider: "Provider", failedWebhooks24h: "Failed webhooks (24 h)", lastWebhookAt: "Last webhook", mode: "Mode",
  webhookSecretSet: "Webhook secret set", sent24h: "Sent (24 h)", failed24h: "Failed (24 h)", bounced24h: "Bounced (24 h)",
  freePercent: "Free", freeGb: "Free (GB)", version: "Version", environment: "Environment", python: "Python",
  uptimeSeconds: "Up for", startedAt: "Started",
};

function fact(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (key === "uptimeSeconds") {
    const s = Number(value);
    return s > 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  }
  if (key === "freePercent") return `${value}%`;
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)) return formatDateTime(value);
  return String(value);
}

/** System health: each part of the shop checked, with history. Detail only an administrator with access sees. */
export function AdminHealthView() {
  const health = useAdminResource(() => getHealth(24), []);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [running, setRunning] = useState(false);
  const data = report ?? health.data;

  const run = async () => {
    setRunning(true);
    try {
      setReport(await runHealth());
      toast.success("Every check ran, including Razorpay and storage.");
    } catch (error) {
      toast.error(problem(error, "The checks didn't run."));
    } finally {
      setRunning(false);
    }
  };

  const jobs = data?.checks.jobs?.jobs ?? [];

  return (
    <div>
      <AdminPageHeader
        title="System health"
        description="Database, payments, email, file storage, background jobs and the server — checked every five minutes. Nothing secret is shown here."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "System health" }]}
        actions={
          <div className="flex gap-2">
            <AdminButton size="sm" onClick={() => { setReport(null); void health.reload(); }} loading={health.isRefreshing}>
              {health.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
            </AdminButton>
            <AdminButton size="sm" variant="primary" onClick={() => void run()} loading={running}>
              {running ? null : <Play className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Run full check
            </AdminButton>
          </div>
        }
      />

      {!data ? (
        health.error ? (
          <div className="py-10 text-center">
            <p className="text-sm text-admin-ink">{problem(health.error, "The health checks didn't load.")}</p>
            <AdminButton size="sm" className="mt-3" onClick={() => void health.reload()}>Try again</AdminButton>
          </div>
        ) : <p className="py-10 text-center text-sm text-admin-muted">Checking…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <AdminCard>
              <p className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">Overall</p>
              <HealthBadge status={data.status} className="mt-2 text-sm" />
              <p className="mt-1 text-[0.6875rem] text-admin-muted">Checked {formatAgo(data.checkedAt)}{data.deep ? " (full)" : ""}</p>
            </AdminCard>
            <Tile label="Up (7 days)" value={data.uptime7d === null ? "—" : `${data.uptime7d}%`} hint="Share of checks not unhealthy" />
            <Tile label="Checks with a problem" value={String(Object.values(data.checks).filter((c) => c.status === "degraded" || c.status === "unhealthy").length)} />
            <Tile label="Check took" value={`${data.durationMs} ms`} />
          </div>

          <AdminCard>
            <h2 className="mb-2 text-sm font-semibold text-admin-ink">Last 24 hours</h2>
            {data.history.length ? (
              <div className="flex h-8 items-end gap-px" role="img" aria-label={`${data.history.length} checks in the last 24 hours`}>
                {data.history.map((h) => (
                  <span key={h.checkedAt} title={`${formatDateTime(h.checkedAt)}: ${h.status}${Object.keys(h.problems).length ? ` — ${Object.entries(h.problems).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`}
                    className={cn("h-full min-w-[3px] flex-1 rounded-[1px]", DOT[h.status] ?? DOT.unknown)} />
                ))}
              </div>
            ) : <p className="text-xs text-admin-muted">No history yet: the server keeps a check every five minutes once it has been running a while.</p>}
          </AdminCard>

          <div className="grid gap-3 md:grid-cols-2">
            {ORDER.filter((name) => data.checks[name]).map((name) => {
              const check = data.checks[name]!;
              return (
                <AdminCard key={name}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-admin-ink">{check.label}</h3>
                      <p className="mt-1 text-xs text-admin-muted">{check.message}</p>
                    </div>
                    <HealthBadge status={check.status} />
                  </div>
                  {check.latencyMs !== undefined || check.facts ? (
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[0.6875rem]">
                      {check.latencyMs !== undefined ? <><dt className="text-admin-muted">Response</dt><dd className="text-admin-ink">{check.latencyMs} ms</dd></> : null}
                      {Object.entries(check.facts ?? {}).map(([key, value]) => (
                        <div key={key} className="contents"><dt className="text-admin-muted">{FACT_LABELS[key] ?? key}</dt><dd className="text-admin-ink">{fact(key, value)}</dd></div>
                      ))}
                    </dl>
                  ) : null}
                </AdminCard>
              );
            })}
          </div>

          <AdminCard padded={false}>
            <h2 className="px-4 pt-4 text-sm font-semibold text-admin-ink">Background jobs</h2>
            <div className="overflow-x-auto">
              <table className="mt-2 w-full min-w-[48rem] text-left text-xs">
                <thead className="border-y border-admin-border bg-admin-raised text-admin-muted">
                  <tr><th className={TH}>Job</th><th className={TH}>Status</th><th className={TH}>Last success</th><th className={cn(TH, "text-right")}>Runs</th><th className={cn(TH, "text-right")}>Failed</th><th className={TH}>Last error</th></tr>
                </thead>
                <tbody className="divide-y divide-admin-border">
                  {jobs.map((job) => (
                    <tr key={job.name}>
                      <td className={TD}><span className="font-medium text-admin-ink">{job.label}</span><span className="block text-admin-muted">{job.intervalSeconds ? `Every ${job.intervalSeconds >= 60 ? `${Math.round(job.intervalSeconds / 60)} min` : `${job.intervalSeconds} s`}` : job.message}</span></td>
                      <td className={TD}><HealthBadge status={job.status} /><span className="block text-admin-muted">{job.message}</span></td>
                      <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{job.lastSuccessAt ? formatAgo(utc(job.lastSuccessAt).toISOString()) : "—"}</td>
                      <td className={cn(TD, "text-right tabular-nums")}>{job.runs}</td>
                      <td className={cn(TD, "text-right tabular-nums")}>{job.failures}</td>
                      <td className={cn(TD, "max-w-xs break-words text-admin-muted")}>{job.lastError ? `${job.lastError}${job.lastErrorAt ? ` (${formatDateTime(job.lastErrorAt)})` : ""}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminCard>
        </div>
      )}
    </div>
  );
}
