"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, RotateCcw, Send, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea, AdminToggle } from "@/components/admin/ui/AdminForm";
import { FilterSelect, LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Badge, Detail, JsonBlock, TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import {
  CHANNEL_LABELS,
  type Channel,
  type DeliveryRow,
  type NotificationOverview,
  type NotificationTemplate,
  type TemplatePreview,
  getDelivery,
  getNotificationOverview,
  listDeliveries,
  listTemplates,
  previewTemplate,
  resetTemplate,
  retryDelivery,
  saveChannelRouting,
  saveTemplate,
  testTemplate,
} from "@/services/admin/messagingAdminService";
import { toast } from "@/store/toastStore";

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "grey"> = {
  sent: "green", delivered: "green", read: "green", queued: "grey", sending: "grey", failed: "amber", dead: "red",
  skipped: "grey",
};
const STATUS_LABEL: Record<string, string> = {
  sent: "Sent", delivered: "Delivered", read: "Read", queued: "Queued", sending: "Sending", failed: "Retrying",
  dead: "Failed", skipped: "Not sent",
};
const KEYS = ["tab", "channel", "status", "event", "q", "from", "to"] as const;

/**
 * Notifications: every message to customers on every channel — what was sent,
 * what failed and why, the wording for each event, and which events also go by
 * SMS and WhatsApp. Provider credentials are never shown here.
 */
export function AdminNotificationsView() {
  const { filters, setFilters } = useUrlFilters(KEYS);
  const tab = filters.tab || "overview";
  const overview = useAdminResource(() => getNotificationOverview(), []);

  return (
    <div>
      <AdminPageHeader
        title="Notifications"
        description="Emails, SMS, WhatsApp and in-app messages to customers: delivery, failures, retries and wording."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Notifications" }]}
        actions={
          <AdminButton size="sm" onClick={() => void overview.reload()} loading={overview.isRefreshing}>
            {overview.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
          </AdminButton>
        }
      />
      <StatusTabs label="Section" value={tab} onChange={(value) => setFilters({ tab: value === "overview" ? "" : value })}
        tabs={[{ value: "overview", label: "Overview & channels" }, { value: "history", label: "Delivery history" },
          { value: "templates", label: "Templates" }]} />
      {tab === "history" ? <History events={overview.data?.events ?? []} />
        : tab === "templates" ? <Templates />
        : <Overview data={overview.data} error={overview.error} onSaved={() => void overview.reload()} />}
    </div>
  );
}

/* --------------------------------------------------------------- overview */

function Overview({ data, error, onSaved }: { data: NotificationOverview | null; error: Error | null; onSaved: () => void }) {
  const [routing, setRouting] = useState<NotificationOverview["routing"] | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setRouting(data.routing);
  }, [data]);

  if (!data || !routing) return <p className="py-10 text-center text-sm text-admin-muted">{error ? problem(error, "This didn't load.") : "Loading…"}</p>;

  const transactional = data.events.filter((e) => e.category === "transactional" && !["email_verification", "password_reset"].includes(e.key));
  const dirty = JSON.stringify(routing) !== JSON.stringify(data.routing);

  const save = async () => {
    setSaving(true);
    try {
      await saveChannelRouting(routing);
      toast.success("Channels saved.");
      onSaved();
    } catch (err) {
      toast.error(problem(err, "The channels weren't saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(Object.keys(CHANNEL_LABELS) as Channel[]).map((channel) => {
          const state = data.channels[channel];
          const week = data.byChannel[channel] ?? { total: 0 };
          return (
            <AdminCard key={channel}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-admin-ink">{CHANNEL_LABELS[channel]}</p>
                <Badge tone={state.configured ? (channel === "sms" || channel === "whatsapp" ? (state.enabled ? "green" : "amber") : "green") : "red"}>
                  {state.configured ? (channel === "sms" || channel === "whatsapp" ? (state.enabled ? "On" : "Ready, off") : "Ready") : "Not configured"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-admin-muted">{state.configured ? `Provider: ${state.provider}` : state.reason}</p>
              <p className="mt-3 text-[0.6875rem] text-admin-muted">Last {data.days} days</p>
              <p className="text-xs text-admin-ink tabular-nums">
                {week.total} messages · {(week.sent ?? 0) + (week.delivered ?? 0) + (week.read ?? 0)} sent · {(week.dead ?? 0)} failed
              </p>
            </AdminCard>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Waiting to retry" value={String(data.retrying)} tone={data.retrying ? "warn" : undefined} />
        <Tile label={`Gave up (${data.days} days)`} value={String(data.gaveUp)} tone={data.gaveUp ? "bad" : undefined} hint="After every retry" />
      </div>

      <AdminCard title="SMS and WhatsApp" description="Email goes for every event the store sends. Choose which events also go by text. Customers can turn these off in their account; WhatsApp needs their opt-in and an approved template (set it on the Templates tab)."
        action={<AdminButton size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>Save</AdminButton>}>
        <div className="grid gap-6 md:grid-cols-2">
          {(["sms", "whatsapp"] as const).map((channel) => (
            <div key={channel}>
              <AdminToggle label={`Send by ${CHANNEL_LABELS[channel]}`} checked={routing[channel].enabled}
                disabled={!data.channels[channel].configured}
                description={data.channels[channel].configured ? undefined : data.channels[channel].reason}
                onChange={(enabled) => setRouting({ ...routing, [channel]: { ...routing[channel], enabled } })} />
              <fieldset className="mt-2 grid gap-1 sm:grid-cols-2" disabled={!routing[channel].enabled}>
                <legend className="sr-only">Events sent by {CHANNEL_LABELS[channel]}</legend>
                {transactional.map((event) => (
                  <label key={event.key} className={cn("flex items-center gap-2 text-xs", routing[channel].enabled ? "text-admin-ink" : "text-admin-faint")}>
                    <input type="checkbox" checked={routing[channel].events.includes(event.key)}
                      onChange={(e) => setRouting({ ...routing, [channel]: { ...routing[channel], events: e.target.checked
                        ? [...routing[channel].events, event.key] : routing[channel].events.filter((k) => k !== event.key) } })} />
                    {event.label}
                  </label>
                ))}
              </fieldset>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[0.6875rem] text-admin-muted">Verification and password-reset links are always sent by email only.</p>
      </AdminCard>
    </div>
  );
}

/* ---------------------------------------------------------------- history */

function History({ events }: { events: { key: string; label: string }[] }) {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const list = useAdminResource(() => listDeliveries({ channel: filters.channel, status: filters.status, event: filters.event,
    q: filters.q, from: filters.from, to: filters.to, page, pageSize }), [filters, page, pageSize]);
  const [openId, setOpenId] = useState<number | null>(null);
  const data = list.data;
  const filtered = ["channel", "status", "event", "q", "from", "to"].some((k) => filters[k as keyof typeof filters]);

  return (
    <div>
      <StatusTabs label="Status" value={filters.status} onChange={(status) => setFilters({ status })}
        tabs={[{ value: "", label: "All" }, ...["sent", "delivered", "queued", "failed", "dead", "skipped"].map((s) => ({
          value: s, label: STATUS_LABEL[s] ?? s, count: data?.counts[s] }))]} />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <LogSearch label="Search" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Customer, reference or provider id" />
        <FilterSelect label="Channel" value={filters.channel} onChange={(channel) => setFilters({ channel })}
          options={[{ value: "", label: "Every channel" }, ...(Object.keys(CHANNEL_LABELS) as Channel[]).map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))]} />
        <FilterSelect label="Event" value={filters.event} onChange={(event) => setFilters({ event })}
          options={[{ value: "", label: "Every event" }, { value: "campaign_message", label: "Marketing campaign" }, ...events.filter((e) => e.key !== "campaign_message").map((e) => ({ value: e.key, label: e.label }))]} />
        <div className="w-36"><AdminInput label="From" type="date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })} /></div>
        <div className="w-36"><AdminInput label="To" type="date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })} /></div>
        {filtered ? <AdminButton size="sm" variant="ghost" onClick={() => { clear(); setFilters({ tab: "history" }); }}><X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Clear</AdminButton> : null}
      </div>
      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[60rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr><th className={TH}>Created</th><th className={TH}>Customer</th><th className={TH}>Event</th><th className={TH}>Channel</th>
                <th className={TH}>Status</th><th className={TH}>Attempts</th><th className={TH}>Reason</th><th className={TH}><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={8} loading={list.isLoading && !data} failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)} onRetry={() => void list.reload()}
                title={filtered ? "Nothing matches" : "No messages yet"} hint={filtered ? "Try fewer filters." : "Messages to customers appear here as they're sent."} />
              {data?.items.map((row) => (
                <tr key={row.id} className="cursor-pointer hover:bg-admin-raised" onClick={() => setOpenId(row.id)}>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.createdAt)}</td>
                  <td className={TD}>{row.customer ? <span className="text-admin-ink">{row.customer.name}</span> : <span className="text-admin-muted">—</span>}
                    <span className="block text-admin-muted">{row.recipient}</span></td>
                  <td className={TD}><span className="text-admin-ink">{row.eventLabel}</span>{row.category === "marketing" ? <span className="block text-admin-muted">Marketing</span> : null}</td>
                  <td className={TD}>{CHANNEL_LABELS[row.channel]}</td>
                  <td className={TD}><Badge tone={STATUS_TONE[row.status] ?? "grey"}>{STATUS_LABEL[row.status] ?? row.status}</Badge></td>
                  <td className={cn(TD, "tabular-nums")}>{row.attempts}/{row.maxAttempts}</td>
                  <td className={cn(TD, "max-w-xs truncate text-admin-muted")} title={row.lastError}>{row.lastError || "—"}</td>
                  <td className={cn(TD, "text-right")} onClick={(e) => e.stopPropagation()}>
                    {row.retryable ? <RetryButton id={row.id} onDone={() => void list.reload()} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
      {data ? <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
        totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} /> : null}
      <DeliveryDialog id={openId} onClose={() => setOpenId(null)} onRetried={() => void list.reload()} />
    </div>
  );
}

function RetryButton({ id, onDone }: { id: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <AdminButton size="sm" variant="ghost" loading={busy} onClick={async () => {
      setBusy(true);
      try {
        const row = await retryDelivery(id);
        toast.success(row.status === "sent" ? "Sent." : `Queued again (${STATUS_LABEL[row.status] ?? row.status}).`);
        onDone();
      } catch (error) {
        toast.error(problem(error, "It couldn't be retried."));
      } finally {
        setBusy(false);
      }
    }}>
      {busy ? null : <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Retry
    </AdminButton>
  );
}

function DeliveryDialog({ id, onClose, onRetried }: { id: number | null; onClose: () => void; onRetried: () => void }) {
  const detail = useAdminResource(() => getDelivery(id ?? 0), [id], { enabled: id !== null });
  const row: DeliveryRow | null = detail.data;
  return (
    <Modal open={id !== null} onOpenChange={(open) => !open && onClose()} title={row ? `${row.eventLabel} · ${CHANNEL_LABELS[row.channel]}` : "Message"} className="max-w-2xl">
      {!row ? <p className="text-sm text-admin-muted">{detail.error ? problem(detail.error, "This didn't load.") : "Loading…"}</p> : (
        <div className="flex flex-col gap-4 text-xs">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="Status">{STATUS_LABEL[row.status] ?? row.status}</Detail>
            <Detail label="Recipient">{row.recipient || "—"}{row.customer ? ` · ${row.customer.name}` : ""}</Detail>
            <Detail label="Template">{row.template || "—"}</Detail>
            <Detail label="Provider">{row.provider || "—"}</Detail>
            <Detail label="Created">{formatDateTime(row.createdAt)}</Detail>
            <Detail label="Sent">{row.sentAt ? formatDateTime(row.sentAt) : "—"}</Detail>
            <Detail label="Delivered">{row.deliveredAt ? formatDateTime(row.deliveredAt) : row.channel === "email" ? "Not reported for email" : "—"}</Detail>
            <Detail label="Attempts">{row.attempts} of {row.maxAttempts}{row.nextAttemptAt ? ` · next ${formatDateTime(row.nextAttemptAt)}` : ""}</Detail>
            <Detail label="Provider reference" wide><span className="font-mono">{row.providerMessageId || "—"}</span></Detail>
            {row.lastError ? <Detail label="Reason" wide><span className="text-[#a32424]">{row.lastError}</span></Detail> : null}
            <Detail label="Reference">{row.reference || "—"}</Detail>
          </dl>
          {row.content && Object.keys(row.content).length ? <div><p className="mb-1 font-medium text-admin-ink">Content</p><JsonBlock value={row.content} /></div> : null}
          {row.retryable ? <div className="flex justify-end"><RetryButton id={row.id} onDone={() => { onRetried(); void detail.reload(); }} /></div> : null}
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------- templates */

function Templates() {
  const list = useAdminResource(() => listTemplates(), []);
  const [open, setOpen] = useState<NotificationTemplate | null>(null);
  const groups = useMemo(() => {
    const out = new Map<string, NotificationTemplate[]>();
    for (const t of list.data ?? []) out.set(t.group, [...(out.get(t.group) ?? []), t]);
    return [...out.entries()];
  }, [list.data]);

  if (!list.data) return <p className="py-10 text-center text-sm text-admin-muted">{list.error ? problem(list.error, "Templates didn't load.") : "Loading…"}</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-admin-muted">Every message uses the store&rsquo;s branded email design. Change the wording here, preview it on each channel and send yourself a test. Messages that keep accounts secure can be reworded but not switched off.</p>
      {groups.map(([group, templates]) => (
        <AdminCard key={group} title={group} padded={false}>
          <table className="w-full text-left text-xs">
            <tbody className="divide-y divide-admin-border">
              {templates.map((t) => (
                <tr key={t.key} className="cursor-pointer hover:bg-admin-raised" onClick={() => setOpen(t)}>
                  <td className={TD}><span className="font-medium text-admin-ink">{t.label}</span><span className="block text-admin-muted">{t.subject}</span></td>
                  <td className={TD}>{t.enabled ? <Badge tone="green">On</Badge> : <Badge tone="grey">Off</Badge>}{t.locked ? <span className="ml-2 text-admin-muted">Always on</span> : null}</td>
                  <td className={TD}>{t.customised ? <Badge tone="amber">Your wording</Badge> : <span className="text-admin-muted">Built-in wording</span>}</td>
                  <td className={cn(TD, "text-admin-muted")}>{t.updatedAt ? `${formatDateTime(t.updatedAt)}${t.updatedBy ? ` · ${t.updatedBy}` : ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AdminCard>
      ))}
      <TemplateEditor template={open} onClose={() => setOpen(null)} onSaved={() => void list.reload()} />
    </div>
  );
}

function TemplateEditor({ template, onClose, onSaved }: { template: NotificationTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<NotificationTemplate | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [view, setView] = useState<"email" | "sms" | "whatsapp" | "in_app">("email");
  const [busy, setBusy] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testChannel, setTestChannel] = useState<Channel>("email");

  useEffect(() => {
    setDraft(template);
    setPreview(null);
  }, [template]);

  useEffect(() => {
    if (!draft) return;
    const timer = setTimeout(() => {
      previewTemplate(draft.key, draft).then(setPreview).catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [draft]);

  if (!draft) return null;
  const set = (patch: Partial<NotificationTemplate>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    setBusy("save");
    try {
      const saved = await saveTemplate(draft.key, draft);
      setDraft(saved);
      toast.success("Template saved.");
      onSaved();
    } catch (error) {
      toast.error(problem(error, "The template wasn't saved."));
    } finally {
      setBusy("");
    }
  };

  const reset = async () => {
    setBusy("reset");
    try {
      setDraft(await resetTemplate(draft.key));
      toast.success("Back to the built-in wording.");
      onSaved();
    } catch (error) {
      toast.error(problem(error, "It wasn't reset."));
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const result = await testTemplate(draft.key, testChannel, testTo);
      toast.success(`Test sent to ${result.sentTo}.`);
    } catch (error) {
      toast.error(problem(error, "The test wasn't sent."));
    } finally {
      setBusy("");
    }
  };

  return (
    <Modal open={template !== null} onOpenChange={(open) => !open && onClose()} title={draft.label} className="max-w-5xl">
      <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col gap-3">
          <AdminToggle label="Send this notification" checked={draft.enabled} disabled={draft.locked}
            description={draft.locked ? "Keeps accounts secure, so it's always sent." : undefined} onChange={(enabled) => set({ enabled })} />
          <AdminInput label="Email subject" value={draft.subject} onChange={(e) => set({ subject: e.target.value })} maxLength={200} />
          <AdminInput label="Email heading" value={draft.heading} onChange={(e) => set({ heading: e.target.value })} maxLength={200} />
          <AdminTextarea label="Email message" value={draft.body} onChange={(e) => set({ body: e.target.value })} rows={5}
            hint="Plain text. A blank line starts a new paragraph; **text** is bold. Order lines and details are added below automatically." />
          <AdminInput label="Button label" value={draft.cta} onChange={(e) => set({ cta: e.target.value })} maxLength={60} />
          <AdminTextarea label="SMS" value={draft.sms} onChange={(e) => set({ sms: e.target.value })} rows={2}
            hint={preview ? `${preview.sms.length} characters · ${preview.smsSegments} SMS` : "Keep it short — charged per 160 characters."} />
          <div className="grid gap-3 sm:grid-cols-2">
            <AdminInput label="WhatsApp template (approved name or Content SID)" value={draft.whatsappTemplate} onChange={(e) => set({ whatsappTemplate: e.target.value })} />
            <AdminInput label="Template language" value={draft.whatsappLanguage} onChange={(e) => set({ whatsappLanguage: e.target.value })} />
          </div>
          <AdminInput label="WhatsApp variables, in order" value={draft.whatsappVariables.join(", ")}
            onChange={(e) => set({ whatsappVariables: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} />
          <AdminInput label="In-app title" value={draft.inAppTitle} onChange={(e) => set({ inAppTitle: e.target.value })} />
          <AdminInput label="In-app message" value={draft.inAppBody} onChange={(e) => set({ inAppBody: e.target.value })} />
          <div className="rounded-[3px] border border-admin-border bg-admin-raised p-3 text-[0.6875rem] text-admin-muted">
            <p className="mb-1 font-medium text-admin-ink">Variables you can use</p>
            <p className="font-mono leading-relaxed">{[...draft.variables, draft.ctaVariable].filter(Boolean).map((v) => `{{${v}}}`).join("  ")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <AdminButton variant="primary" loading={busy === "save"} onClick={() => void save()}>Save template</AdminButton>
            {draft.customised ? <AdminButton variant="ghost" loading={busy === "reset"} onClick={() => void reset()}>Use built-in wording</AdminButton> : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <StatusTabs label="Preview" value={view} onChange={(v) => setView(v as typeof view)}
            tabs={[{ value: "email", label: "Email" }, { value: "sms", label: "SMS" }, { value: "whatsapp", label: "WhatsApp" }, { value: "in_app", label: "In-app" }]} />
          {preview?.problems.length ? <p className="rounded-[3px] bg-[#fbeaea] p-2 text-xs text-[#a32424]">{preview.problems.join(" ")}</p> : null}
          {!preview ? <p className="text-xs text-admin-muted">Preparing the preview…</p> : view === "email" ? (
            <div>
              <p className="mb-2 text-xs text-admin-muted">Subject: <span className="text-admin-ink">{preview.subject}</span></p>
              <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[32rem] w-full rounded-[3px] border border-admin-border bg-white" />
            </div>
          ) : view === "sms" ? (
            <p className="whitespace-pre-wrap rounded-[12px] bg-admin-raised p-3 text-sm text-admin-ink">{preview.sms || "No SMS wording."}</p>
          ) : view === "whatsapp" ? (
            <div className="text-xs text-admin-ink">
              <p>Template: <span className="font-mono">{preview.whatsapp.template || "— not set (WhatsApp won't be sent)"}</span></p>
              <p className="mt-1">Variables: {(preview.whatsapp.variables ?? []).map((v, i) => `{{${i + 1}}} = ${v}`).join(" · ") || "none"}</p>
            </div>
          ) : (
            <div className="rounded-[3px] border border-admin-border p-3 text-xs"><p className="font-medium text-admin-ink">{preview.inApp.title}</p><p className="text-admin-muted">{preview.inApp.body}</p></div>
          )}
          <div className="rounded-[3px] border border-admin-border p-3">
            <p className="mb-2 text-xs font-medium text-admin-ink">Send yourself a test (sample values)</p>
            <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
              <AdminSelect label="Channel" value={testChannel} onChange={(e) => setTestChannel(e.target.value as Channel)}
                options={[{ value: "email", label: "Email" }, { value: "sms", label: "SMS" }, { value: "whatsapp", label: "WhatsApp" }]} />
              <AdminInput label={testChannel === "email" ? "Your email" : "Your number (+91…)"} value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              <AdminButton loading={busy === "test"} disabled={testTo.trim().length < 3} onClick={() => void test()}>
                {busy === "test" ? null : <Send className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Send test
              </AdminButton>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
