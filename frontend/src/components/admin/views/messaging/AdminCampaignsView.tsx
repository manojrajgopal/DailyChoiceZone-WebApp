"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FocusEvent, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, Plus, RefreshCw, Send } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminTextarea, FormGrid } from "@/components/admin/ui/AdminForm";
import { LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { ProductPicker, fromLocalInput, rupees, toLocalInput } from "@/components/admin/views/growth/shared";
import { Badge, TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import {
  CHANNEL_LABELS,
  type Audience,
  type Campaign,
  type CampaignContent,
  type CampaignInput,
  type CampaignOptions,
  type CampaignStatus,
  type Channel,
  type ChannelFigures,
  type Estimate,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  estimateAudience,
  getCampaign,
  getCampaignOptions,
  launchCampaign,
  listCampaigns,
  listRecipients,
  previewCampaign,
  testCampaign,
  updateCampaign,
} from "@/services/admin/messagingAdminService";
import { toast } from "@/store/toastStore";

const STATUS: Record<CampaignStatus, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  draft: { label: "Draft", tone: "grey" },
  scheduled: { label: "Scheduled", tone: "amber" },
  sending: { label: "Sending", tone: "amber" },
  sent: { label: "Sent", tone: "green" },
  cancelled: { label: "Cancelled", tone: "grey" },
  failed: { label: "Failed", tone: "red" },
};
const SEGMENT_LABELS: Record<string, string> = {
  all: "Every customer", members: "Members", non_members: "Not members", new: "New customers",
  repeat: "Repeat customers", lapsed: "Haven't ordered lately",
};
const KEYS = ["status", "q"] as const;

/** Marketing → Campaigns: every campaign, and how each did. */
export function AdminCampaignsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize } = useUrlFilters(KEYS);
  const list = useAdminResource(() => listCampaigns({ status: filters.status, q: filters.q, page, pageSize }), [filters, page, pageSize]);
  const data = list.data;
  return (
    <div>
      <AdminPageHeader
        title="Campaigns"
        description="Email, SMS, WhatsApp and in-app campaigns to customers who've agreed to hear from you."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Marketing" }, { label: "Campaigns" }]}
        actions={
          <div className="flex gap-2">
            <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
              {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
            </AdminButton>
            <AdminButtonLink size="sm" variant="ghost" href="/admin/notifications?tab=templates">Templates</AdminButtonLink>
            <AdminButtonLink size="sm" variant="primary" href="/admin/marketing/campaigns/detail">
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> New campaign
            </AdminButtonLink>
          </div>
        }
      />
      <StatusTabs label="Which campaigns" value={filters.status} onChange={(status) => setFilters({ status })}
        tabs={[{ value: "", label: "All" }, ...(Object.keys(STATUS) as CampaignStatus[]).map((s) => ({ value: s, label: STATUS[s].label, count: data?.counts[s] }))]} />
      <div className="mb-3"><LogSearch label="Find a campaign" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Campaign name" /></div>
      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[52rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr><th className={TH}>Campaign</th><th className={TH}>Status</th><th className={TH}>Channels</th><th className={TH}>Sends</th>
                <th className={cn(TH, "text-right")}>Recipients</th><th className={cn(TH, "text-right")}>Sent</th></tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={6} loading={list.isLoading && !data} failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)} onRetry={() => void list.reload()}
                title="No campaigns yet" hint="Create one to reach customers who've opted in to marketing." />
              {data?.items.map((c) => (
                <tr key={c.id} className="hover:bg-admin-raised">
                  <td className={TD}><Link href={`/admin/marketing/campaigns/detail?id=${c.id}`} className="font-medium text-admin-ink hover:text-copper-700">{c.name}</Link>
                    <span className="block text-admin-muted">{c.kindLabel}</span></td>
                  <td className={TD}><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></td>
                  <td className={TD}>{c.channels.map((ch) => CHANNEL_LABELS[ch]).join(", ")}</td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{c.scheduledAt ? formatDateTime(c.scheduledAt) : "—"}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{c.recipientsTotal || "—"}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{c.sent ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
      {data ? <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
        totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} /> : null}
    </div>
  );
}

const EMPTY_CONTENT: CampaignContent = {
  email: { subject: "", preview: "", heading: "", html: "", ctaLabel: "Shop now", ctaUrl: "/shop" },
  sms: { text: "" },
  whatsapp: { template: "", language: "en", variables: ["customer_name"] },
  in_app: { title: "", body: "", url: "/shop" },
};

function blank(): CampaignInput {
  return { name: "", description: "", kind: "promotional", channels: ["email"], audience: { segment: "all" },
    content: structuredClone(EMPTY_CONTENT), couponCode: "", startsAt: null, endsAt: null };
}

function fromCampaign(c: Campaign): CampaignInput {
  return { name: c.name, description: c.description, kind: c.kind, channels: c.channels, audience: c.audience ?? { segment: "all" },
    content: { ...structuredClone(EMPTY_CONTENT), ...(c.content ?? {}) }, couponCode: c.couponCode, startsAt: c.startsAt, endsAt: c.endsAt };
}

const STEPS = ["Details", "Audience", "Content", "Schedule", "Review"] as const;
const SMS_LIMIT = 480;

type FieldErrors = Record<string, string>;

function unknownVariables(text: string, known: string[]): string[] {
  if (!known.length) return [];
  return [...new Set([...text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((m) => m[1] ?? "").filter((v) => v && !known.includes(v)))];
}

const isNumber = (value: unknown): value is number => typeof value === "number" && !Number.isNaN(value);

/** What's missing or wrong on one step, by field: the same rules the server applies when saving and launching. */
function validateStep(step: number, form: CampaignInput, opts: CampaignOptions | null, schedule: "now" | "later", sendAt: string): FieldErrors {
  const errors: FieldErrors = {};
  const known = opts?.variables ?? [];
  const variables = (key: string, label: string, text: string) => {
    const unknown = unknownVariables(text, known);
    if (unknown.length && !errors[key]) {
      errors[key] = `${label} uses ${unknown.map((u) => `{{${u}}}`).join(", ")}, which isn't available.`;
    }
  };
  if (step === 0) {
    const name = form.name.trim();
    if (!name) errors.name = "Give the campaign a name.";
    else if (name.length < 3) errors.name = "The name needs at least 3 characters.";
    if (!form.channels.length) errors.channels = "Choose at least one channel.";
    else {
      const off = form.channels.filter((c) => opts?.channels[c] && !opts.channels[c].configured);
      if (off.length) {
        errors.channels = `${off.map((c) => CHANNEL_LABELS[c]).join(", ")} isn't set up yet. Untick it, or set it up in Notifications first.`;
      }
    }
    if (form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) errors.endsAt = "This must be after the start.";
  }
  if (step === 1) {
    const a = form.audience;
    if (isNumber(a.minSpent) && isNumber(a.maxSpent) && a.maxSpent < a.minSpent) errors.maxSpent = "This can't be less than the minimum spend.";
    if (isNumber(a.minOrders) && isNumber(a.maxOrders) && a.maxOrders < a.minOrders) errors.maxOrders = "This can't be less than the minimum orders.";
    if (a.orderedFrom && a.orderedTo && a.orderedTo < a.orderedFrom) errors.orderedTo = "This can't be before the \"Ordered from\" date.";
  }
  if (step === 2) {
    const { email, sms, whatsapp, in_app } = form.content;
    if (form.channels.includes("email")) {
      if (!email.subject.trim()) errors.emailSubject = "The email needs a subject.";
      if (!email.html.trim()) errors.emailHtml = "The email needs a message.";
      if (email.ctaLabel.trim() && !email.ctaUrl.trim()) errors.emailCtaUrl = "Add a link for the button, or clear its label.";
      variables("emailSubject", "The subject", email.subject);
      variables("emailPreview", "The preview text", email.preview);
      variables("emailHeading", "The heading", email.heading);
      variables("emailHtml", "The message", email.html);
    }
    if (form.channels.includes("sms")) {
      if (!sms.text.trim()) errors.smsText = "The SMS needs a message.";
      else if (sms.text.length > SMS_LIMIT) errors.smsText = `Keep the SMS under ${SMS_LIMIT} characters (it's ${sms.text.length}).`;
      variables("smsText", "The SMS", sms.text);
    }
    if (form.channels.includes("whatsapp")) {
      if (!whatsapp.template.trim()) errors.whatsappTemplate = "WhatsApp needs the name of a template WhatsApp has approved.";
      const bad = known.length ? whatsapp.variables.filter((v) => !known.includes(v)) : [];
      if (bad.length) errors.whatsappVariables = `Use only: ${known.join(", ")}.`;
    }
    if (form.channels.includes("in_app")) {
      if (!in_app.title.trim()) errors.inAppTitle = "The in-app message needs a title.";
      if (!in_app.body.trim()) errors.inAppBody = "The in-app message needs a message.";
      variables("inAppTitle", "The title", in_app.title);
      variables("inAppBody", "The message", in_app.body);
    }
  }
  if (step === 3 && schedule === "later") {
    if (!sendAt) errors.sendAt = "Choose when it goes out.";
    else if (new Date(sendAt).getTime() < Date.now()) errors.sendAt = "This time has passed. Choose a time in the future.";
  }
  return errors;
}

/** Create, edit, test and launch a campaign; once launched, its results. */
export function AdminCampaignDetailView() {
  const params = useSearchParams();
  const router = useRouter();
  const id = Number(params.get("id")) || null;
  const campaign = useAdminResource(() => getCampaign(id ?? 0), [id], { enabled: id !== null });
  const options = useAdminResource(() => getCampaignOptions(), []);
  // "Send campaign to this segment" opens a new campaign with ?segmentId=N (customer segmentation).
  const [form, setForm] = useState<CampaignInput>(() => {
    const draft = blank();
    const segmentId = Number(params.get("segmentId")) || null;
    if (!id && segmentId) draft.audience = { ...draft.audience, segmentId };
    return draft;
  });
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [schedule, setSchedule] = useState<"now" | "later">("now");
  const [sendAt, setSendAt] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Fields the admin has been in: their messages show; the rest wait in the summary.
  const [touched, setTouched] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (campaign.data) setForm(fromCampaign(campaign.data));
  }, [campaign.data]);

  const audienceKey = JSON.stringify([form.audience, form.channels]);
  useEffect(() => {
    const timer = setTimeout(() => {
      estimateAudience(form.audience, form.channels).then(setEstimate).catch(() => setEstimate(null));
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceKey]);

  const current = campaign.data;
  if (id && campaign.isLoading && !current) return <p className="text-sm text-admin-muted">Loading…</p>;
  if (id && campaign.error && !current) return <p className="text-sm text-admin-ink">{problem(campaign.error, "This campaign didn't load.")}</p>;
  if (current && current.status !== "draft") return <CampaignResults campaign={current} onChanged={() => void campaign.reload()} />;

  const setContent = <K extends keyof CampaignContent>(channel: K, patch: Partial<CampaignContent[K]>) =>
    setForm({ ...form, content: { ...form.content, [channel]: { ...form.content[channel], ...patch } } });
  const setAudience = (patch: Partial<Audience>) => setForm({ ...form, audience: { ...form.audience, ...patch } });
  const toggleChannel = (channel: Channel, on: boolean) =>
    setForm({ ...form, channels: on ? [...new Set([...form.channels, channel])] : form.channels.filter((c) => c !== channel) });

  const save = async (): Promise<Campaign | null> => {
    setBusy("save");
    try {
      const payload = { ...form, startsAt: form.startsAt, endsAt: form.endsAt };
      const saved = id ? await updateCampaign(id, payload) : await createCampaign(payload);
      toast.success("Saved as a draft.");
      if (!id) router.replace(`/admin/marketing/campaigns/detail?id=${saved.id}`);
      else await campaign.reload();
      return saved;
    } catch (error) {
      toast.error(problem(error, "The campaign wasn't saved."));
      return null;
    } finally {
      setBusy("");
    }
  };

  const sendTest = async () => {
    if (!id) return;
    setBusy("test");
    try {
      if (!(await save())) return;
      const result = await testCampaign(id, testEmail, testPhone);
      toast.success(`Test sent: ${result.sent.map((s) => `${s.channel} → ${s.to}`).join(", ")}`);
      await campaign.reload();
    } catch (error) {
      toast.error(problem(error, "The test wasn't sent."));
    } finally {
      setBusy("");
    }
  };

  const launch = async () => {
    if (!id || !estimate) return;
    setBusy("launch");
    try {
      const result = await launchCampaign(id, estimate.messages, schedule === "later" && sendAt ? fromLocalInput(sendAt) : null);
      toast.success(result.status === "scheduled" ? "Campaign scheduled." : "Campaign is sending.");
      setConfirming(false);
      await campaign.reload();
    } catch (error) {
      toast.error(problem(error, "The campaign wasn't launched."));
      setConfirming(false);
      estimateAudience(form.audience, form.channels).then(setEstimate).catch(() => undefined);
    } finally {
      setBusy("");
    }
  };

  const opts = options.data;
  const savedSegments = opts?.savedSegments ?? [];
  const segmentName = form.audience.segmentId
    ? (savedSegments.find((s) => s.id === form.audience.segmentId)?.name ?? `Segment #${form.audience.segmentId}`)
    : "";
  const readiness = current?.readiness ?? [];
  const starter = opts?.starters[form.kind];

  const stepErrors = STEPS.map((_, index) => validateStep(index, form, opts ?? null, schedule, sendAt));
  const stepOk = (index: number) => Object.keys(stepErrors[index] ?? {}).length === 0;
  const reachable = (index: number) => STEPS.slice(0, index).every((_, i) => stepOk(i));
  const errors = stepErrors[step] ?? {};
  const fieldError = (key: string) => (touched.has(key) ? errors[key] : undefined);
  const markTouched = (event: FocusEvent<HTMLElement>) => {
    const name = (event.target as HTMLInputElement).name;
    if (name && !touched.has(name)) setTouched(new Set(touched).add(name));
  };

  const channelNames = form.channels.map((c) => CHANNEL_LABELS[c]).join(" or ");
  const nobodyOptedIn = estimate && estimate.matching > 0 && estimate.messages === 0
    ? `None of the ${estimate.matching} matching customers has agreed to marketing on ${channelNames}, so there's nobody to send it to. Customers opt in themselves (the offers box when they sign up, or Account → Settings → Notifications); once some have, you can launch.`
    : "";

  // Everything between this draft and a launch, in plain words.
  const dirty = current ? JSON.stringify(form) !== JSON.stringify(fromCampaign(current)) : true;
  const contentInvalid = [0, 1, 2].some((i) => !stepOk(i));
  const launchBlockers: string[] = [];
  if (!id) launchBlockers.push("Save the draft first.");
  else if (dirty) launchBlockers.push("You have unsaved changes. Save the draft: the test and the launch use the saved version.");
  STEPS.slice(0, 4).forEach((label, i) => Object.values(stepErrors[i] ?? {}).forEach((message) => launchBlockers.push(`${label}: ${message}`)));
  readiness.filter((r) => !contentInvalid || /test/i.test(r)).forEach((r) => { if (!launchBlockers.includes(r)) launchBlockers.push(r); });
  if (estimate && estimate.messages === 0) {
    launchBlockers.push(nobodyOptedIn || "No customers match this audience. Widen the filters in step 2 (Audience).");
  }

  const external = form.channels.some((c) => c !== "in_app");
  const testErrors: FieldErrors = {};
  if (form.channels.includes("email") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail.trim())) testErrors.testEmail = "Enter your email address to receive the test.";
  if ((form.channels.includes("sms") || form.channels.includes("whatsapp")) && !testPhone.trim()) testErrors.testPhone = "Enter your mobile number to receive the SMS / WhatsApp test.";

  return (
    <div>
      <AdminPageHeader title={current ? current.name : "New campaign"}
        description="Build it step by step. Nothing reaches customers until you've tested it and confirmed the launch."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Campaigns", href: "/admin/marketing/campaigns" }, { label: current?.name ?? "New" }]}
        actions={current ? <Badge tone="grey">Draft</Badge> : null} />

      <ol className="mb-5 flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label}>
            <button type="button" onClick={() => setStep(index)} aria-current={step === index ? "step" : undefined}
              disabled={index > step && !reachable(index)}
              title={index > step && !reachable(index) ? "Finish the earlier steps first" : undefined}
              className={cn("inline-flex items-center gap-1.5 rounded-[3px] px-3 py-1.5 text-xs ring-1 ring-inset disabled:cursor-not-allowed disabled:opacity-50",
                step === index ? "bg-admin-ink text-white ring-admin-ink" : "bg-admin-surface text-admin-muted ring-admin-border hover:text-admin-ink")}>
              {index + 1}. {label}
              {index < STEPS.length - 1 && !stepOk(index) ? <span className="h-1.5 w-1.5 rounded-full bg-[#c23434]" aria-label="needs attention" /> : null}
            </button>
          </li>
        ))}
      </ol>

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div onBlurCapture={markTouched}>
          {step === 0 ? (
            <AdminCard title="Campaign details">
              <FormGrid>
                <AdminInput label="Name (internal)" name="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={160} required error={fieldError("name")} />
                <AdminSelect label="Type" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}
                  options={opts?.kinds ?? [{ value: form.kind, label: form.kind }]} />
                <AdminInput label="Coupon code (optional, for revenue)" value={form.couponCode} onChange={(e) => setForm({ ...form, couponCode: e.target.value.toUpperCase() })} />
                <AdminInput label="Runs from (optional)" type="datetime-local" value={toLocalInput(form.startsAt)} onChange={(e) => setForm({ ...form, startsAt: e.target.value ? fromLocalInput(e.target.value) : null })} />
                <AdminInput label="Runs until (optional)" name="endsAt" error={errors.endsAt} type="datetime-local" value={toLocalInput(form.endsAt)} onChange={(e) => setForm({ ...form, endsAt: e.target.value ? fromLocalInput(e.target.value) : null })} />
              </FormGrid>
              <div className="mt-3"><AdminTextarea label="Internal description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} maxLength={500} /></div>
              <fieldset className="mt-4">
                <legend className="mb-2 text-xs font-medium text-admin-ink">Channels <span className="text-[#c23434]">*</span></legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(CHANNEL_LABELS) as Channel[]).map((channel) => {
                    const state = opts?.channels[channel];
                    return (
                      <AdminCheckbox key={channel} label={CHANNEL_LABELS[channel]} checked={form.channels.includes(channel)}
                        description={state && !state.configured ? `Not available: ${state.reason}` : undefined}
                        onChange={(e) => toggleChannel(channel, (e.target as HTMLInputElement).checked)} />
                    );
                  })}
                </div>
                {errors.channels ? <p role="alert" className="mt-2 text-[0.6875rem] text-[#c23434]">{errors.channels}</p> : null}
              </fieldset>
            </AdminCard>
          ) : null}

          {step === 1 ? (
            <AdminCard title="Who it goes to" description="Only customers who've agreed to marketing on a channel are sent on it. The counts update as you change the filters.">
              {nobodyOptedIn ? (
                <p role="status" className="mb-3 flex gap-2 rounded-[3px] bg-[#fdf3e3] p-3 text-xs text-[#8a5a12]">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" /> {nobodyOptedIn}
                </p>
              ) : null}
              <FormGrid>
                <AdminSelect label="Customers" value={form.audience.segment} onChange={(e) => setAudience({ segment: e.target.value as Audience["segment"] })}
                  options={(opts?.segments ?? Object.keys(SEGMENT_LABELS)).map((s) => ({ value: s, label: SEGMENT_LABELS[s] ?? s }))} />
                <AdminSelect label="Saved segment" value={form.audience.segmentId ? String(form.audience.segmentId) : ""}
                  onChange={(e) => setAudience({ segmentId: e.target.value ? Number(e.target.value) : null })}
                  hint="Only this segment's members; the filters here still apply on top."
                  options={[{ value: "", label: "No segment" }, ...savedSegments.map((s) => ({ value: String(s.id), label: `${s.name} (${s.memberCount.toLocaleString("en-IN")})` })),
                    ...(form.audience.segmentId && !savedSegments.some((s) => s.id === form.audience.segmentId) ? [{ value: String(form.audience.segmentId), label: `Segment #${form.audience.segmentId}` }] : [])]} />
                <AdminInput label="Joined in the last (days)" type="number" min={1} value={form.audience.joinedWithinDays ?? ""} onChange={(e) => setAudience({ joinedWithinDays: e.target.value ? Number(e.target.value) : null })} />
                <AdminInput label="Ordered from" type="date" value={form.audience.orderedFrom ?? ""} onChange={(e) => setAudience({ orderedFrom: e.target.value || null })} />
                <AdminInput label="Ordered until" name="orderedTo" error={errors.orderedTo} type="date" value={form.audience.orderedTo ?? ""} onChange={(e) => setAudience({ orderedTo: e.target.value || null })} />
                <AdminInput label="Not ordered for (days)" type="number" min={1} value={form.audience.notOrderedDays ?? ""} onChange={(e) => setAudience({ notOrderedDays: e.target.value ? Number(e.target.value) : null })} />
                <AdminInput label="Spent at least (₹)" type="number" min={0} value={form.audience.minSpent ?? ""} onChange={(e) => setAudience({ minSpent: e.target.value ? Number(e.target.value) : null })} />
                <AdminInput label="Spent at most (₹)" name="maxSpent" error={errors.maxSpent} type="number" min={0} value={form.audience.maxSpent ?? ""} onChange={(e) => setAudience({ maxSpent: e.target.value ? Number(e.target.value) : null })} />
                <AdminInput label="At least this many orders" type="number" min={0} value={form.audience.minOrders ?? ""} onChange={(e) => setAudience({ minOrders: e.target.value ? Number(e.target.value) : null })} />
                <AdminInput label="At most this many orders" name="maxOrders" error={errors.maxOrders} type="number" min={0} value={form.audience.maxOrders ?? ""} onChange={(e) => setAudience({ maxOrders: e.target.value ? Number(e.target.value) : null })} />
              </FormGrid>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-admin-ink">Bought from these categories</p>
                  {(opts?.categories ?? []).map((c) => (
                    <AdminCheckbox key={c.id} label={c.name} checked={(form.audience.categoryIds ?? []).includes(c.id)}
                      onChange={(e) => setAudience({ categoryIds: (e.target as HTMLInputElement).checked ? [...(form.audience.categoryIds ?? []), c.id] : (form.audience.categoryIds ?? []).filter((x) => x !== c.id) })} />
                  ))}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-admin-ink">Membership plan</p>
                  {(opts?.plans ?? []).length === 0 ? <p className="text-xs text-admin-muted">No plans.</p> : (opts?.plans ?? []).map((p) => (
                    <AdminCheckbox key={p.id} label={p.name} checked={(form.audience.membershipPlanIds ?? []).includes(p.id)}
                      onChange={(e) => setAudience({ membershipPlanIds: (e.target as HTMLInputElement).checked ? [...(form.audience.membershipPlanIds ?? []), p.id] : (form.audience.membershipPlanIds ?? []).filter((x) => x !== p.id) })} />
                  ))}
                  <div className="mt-2"><AdminCheckbox label="Has an abandoned bag" checked={Boolean(form.audience.abandonedCart)} onChange={(e) => setAudience({ abandonedCart: (e.target as HTMLInputElement).checked })} /></div>
                </div>
              </div>
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-admin-ink">Bought these products {form.audience.productIds?.length ? `(${form.audience.productIds.length})` : ""}</p>
                {(form.audience.productIds ?? []).length ? (
                  <p className="mb-2 flex flex-wrap gap-1 text-xs">{(form.audience.productIds ?? []).map((pid) => (
                    <button key={pid} type="button" className="rounded-[3px] bg-admin-raised px-2 py-0.5 hover:line-through"
                      onClick={() => setAudience({ productIds: (form.audience.productIds ?? []).filter((x) => x !== pid) })}>{pid} ×</button>
                  ))}</p>
                ) : null}
                <ProductPicker chosen={form.audience.productIds ?? []} onPick={(p) => setAudience({ productIds: [...(form.audience.productIds ?? []), p.id] })} label="Filter by product" />
              </div>
            </AdminCard>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-4">
              {starter ? (
                <p className="text-xs text-admin-muted">Starting point for this type: <button type="button" className="text-copper-700 underline"
                  onClick={() => setForm({ ...form, content: { ...form.content, email: { ...form.content.email, heading: form.content.email.heading || starter.heading,
                    subject: form.content.email.subject || starter.heading, html: form.content.email.html || `<p>Hello {{customer_name}},</p><p>${starter.message}</p>` },
                    in_app: { ...form.content.in_app, title: form.content.in_app.title || starter.heading, body: form.content.in_app.body || starter.message } } })}>use it</button></p>
              ) : null}
              <p className="text-[0.6875rem] text-admin-muted">Variables: <span className="font-mono">{(opts?.variables ?? []).map((v) => `{{${v}}}`).join("  ")}</span></p>
              {form.channels.includes("email") ? (
                <AdminCard title="Email">
                  <FormGrid>
                    <AdminInput label="Subject" name="emailSubject" required error={fieldError("emailSubject")} value={form.content.email.subject} onChange={(e) => setContent("email", { subject: e.target.value })} maxLength={200} />
                    <AdminInput label="Preview text (shown after the subject)" name="emailPreview" error={fieldError("emailPreview")} value={form.content.email.preview} onChange={(e) => setContent("email", { preview: e.target.value })} maxLength={200} />
                    <AdminInput label="Heading" name="emailHeading" error={fieldError("emailHeading")} value={form.content.email.heading} onChange={(e) => setContent("email", { heading: e.target.value })} maxLength={200} />
                    <AdminInput label="Button label" value={form.content.email.ctaLabel} onChange={(e) => setContent("email", { ctaLabel: e.target.value })} />
                    <AdminInput label="Button link" name="emailCtaUrl" error={fieldError("emailCtaUrl")} value={form.content.email.ctaUrl} onChange={(e) => setContent("email", { ctaUrl: e.target.value })} />
                  </FormGrid>
                  <div className="mt-3"><AdminTextarea label="Message (HTML: p, strong, em, a, ul, li, h2, h3, img)" name="emailHtml" required error={fieldError("emailHtml")} value={form.content.email.html} onChange={(e) => setContent("email", { html: e.target.value })} rows={8}
                    hint="Scripts and styles are removed. The store's branded design, an unsubscribe link and your contact details are added around it." /></div>
                </AdminCard>
              ) : null}
              {form.channels.includes("sms") ? (
                <AdminCard title="SMS"><AdminTextarea label="Message" name="smsText" required error={fieldError("smsText")} value={form.content.sms.text} onChange={(e) => setContent("sms", { text: e.target.value })} rows={3}
                  hint={`${form.content.sms.text.length} characters. "Reply STOP to opt out." is added.`} /></AdminCard>
              ) : null}
              {form.channels.includes("whatsapp") ? (
                <AdminCard title="WhatsApp" description="Marketing messages must use a template WhatsApp has approved.">
                  <FormGrid>
                    <AdminInput label="Approved template (name or Content SID)" name="whatsappTemplate" required error={fieldError("whatsappTemplate")} value={form.content.whatsapp.template} onChange={(e) => setContent("whatsapp", { template: e.target.value })} />
                    <AdminInput label="Language" value={form.content.whatsapp.language} onChange={(e) => setContent("whatsapp", { language: e.target.value })} />
                    <AdminInput label="Variables, in order" name="whatsappVariables" error={errors.whatsappVariables} value={form.content.whatsapp.variables.join(", ")} onChange={(e) => setContent("whatsapp", { variables: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} />
                  </FormGrid>
                </AdminCard>
              ) : null}
              {form.channels.includes("in_app") ? (
                <AdminCard title="In-app (the bell)">
                  <FormGrid>
                    <AdminInput label="Title" name="inAppTitle" required error={fieldError("inAppTitle")} value={form.content.in_app.title} onChange={(e) => setContent("in_app", { title: e.target.value })} />
                    <AdminInput label="Link (a page on the shop)" value={form.content.in_app.url} onChange={(e) => setContent("in_app", { url: e.target.value })} />
                  </FormGrid>
                  <div className="mt-3"><AdminTextarea label="Message" name="inAppBody" required error={fieldError("inAppBody")} value={form.content.in_app.body} onChange={(e) => setContent("in_app", { body: e.target.value })} rows={2} /></div>
                </AdminCard>
              ) : null}
              {id ? <CampaignPreview id={id} /> : <p className="text-xs text-admin-muted">Save the draft to see a preview.</p>}
            </div>
          ) : null}

          {step === 3 ? (
            <AdminCard title="When it goes out">
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2"><input type="radio" checked={schedule === "now"} onChange={() => setSchedule("now")} /> As soon as I launch it</label>
                <label className="flex items-center gap-2"><input type="radio" checked={schedule === "later"} onChange={() => setSchedule("later")} /> At a set time</label>
                {schedule === "later" ? <div className="max-w-xs"><AdminInput label="Send at (your time)" name="sendAt" required error={fieldError("sendAt")} type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} /></div> : null}
                <p className="text-xs text-admin-muted">Until you launch it, it stays a draft that nobody receives.</p>
              </div>
            </AdminCard>
          ) : null}

          {step === 4 ? (
            <AdminCard title="Review and launch">
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <div><dt className="text-admin-muted">Audience</dt><dd className="text-admin-ink">{SEGMENT_LABELS[form.audience.segment]}{segmentName ? ` · segment: ${segmentName}` : ""}{estimate ? ` · ${estimate.matching} customers match` : ""}</dd></div>
                <div><dt className="text-admin-muted">Channels</dt><dd className="text-admin-ink">{form.channels.map((c) => `${CHANNEL_LABELS[c]}: ${estimate?.channels[c] ?? "…"}`).join(" · ")}</dd></div>
                <div><dt className="text-admin-muted">Messages</dt><dd className="text-lg font-semibold text-admin-ink tabular-nums">{estimate?.messages ?? "…"}</dd></div>
                <div><dt className="text-admin-muted">Sends</dt><dd className="text-admin-ink">{schedule === "later" && sendAt ? new Date(sendAt).toLocaleString("en-IN") : "As soon as it's launched"}</dd></div>
                <div><dt className="text-admin-muted">Email subject</dt><dd className="text-admin-ink">{form.content.email.subject || "—"}</dd></div>
                <div><dt className="text-admin-muted">Tested</dt><dd className="text-admin-ink">{current?.testedAt ? formatDateTime(current.testedAt) : "Not yet"}</dd></div>
              </dl>
              {launchBlockers.length ? (
                <div role="status" className="mt-3 rounded-[3px] bg-[#fdf3e3] p-3 text-xs text-[#8a5a12]">
                  <p className="flex items-center gap-1.5 font-medium"><AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Why it can&rsquo;t launch yet</p>
                  <ul className="mt-1.5 list-disc pl-5">{launchBlockers.map((r) => <li key={r}>{r}</li>)}</ul>
                </div>
              ) : estimate ? (
                <p role="status" className="mt-3 flex items-center gap-1.5 rounded-[3px] bg-[#e9f5ec] p-3 text-xs text-[#2f7a3e]">
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Ready to launch.
                </p>
              ) : null}
              <div className="mt-4 rounded-[3px] border border-admin-border p-3">
                <p className="mb-2 text-xs font-medium text-admin-ink">Send yourself a test first{external ? " (required)" : ""}</p>
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
                  <AdminInput label="Your email" name="testEmail" required={form.channels.includes("email")} error={touched.has("testEmail") ? testErrors.testEmail : undefined} value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
                  <AdminInput label="Your number (for SMS / WhatsApp)" name="testPhone" required={form.channels.includes("sms") || form.channels.includes("whatsapp")} error={touched.has("testPhone") ? testErrors.testPhone : undefined} value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
                  <AdminButton className="sm:mt-5" loading={busy === "test"} disabled={!id || contentInvalid || Object.keys(testErrors).length > 0} onClick={() => void sendTest()}>
                    {busy === "test" ? null : <Send className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Send test
                  </AdminButton>
                </div>
                {!id ? <p className="mt-2 text-[0.6875rem] text-admin-muted">Save the draft first to send a test.</p>
                  : contentInvalid ? <p className="mt-2 text-[0.6875rem] text-admin-muted">Fix the steps marked in red first, then send the test.</p>
                  : Object.keys(testErrors).length ? <p className="mt-2 text-[0.6875rem] text-admin-muted">{Object.values(testErrors).join(" ")}</p> : null}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <AdminButton variant="primary" disabled={launchBlockers.length > 0 || !estimate?.messages} onClick={() => setConfirming(true)}>
                  {schedule === "later" ? "Schedule campaign" : "Launch campaign"}
                </AdminButton>
              </div>
            </AdminCard>
          ) : null}

          {step < STEPS.length - 1 && !stepOk(step) ? (
            <div role="status" className="mt-4 rounded-[3px] border border-[#f0d9b5] bg-[#fdf3e3] p-3 text-xs text-[#8a5a12]">
              <p className="flex items-center gap-1.5 font-medium"><AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> To continue to {STEPS[step + 1]}:</p>
              <ul className="mt-1.5 list-disc pl-5">{Object.values(errors).map((message) => <li key={message}>{message}</li>)}</ul>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap justify-between gap-2">
            <div className="flex gap-2">
              <AdminButton disabled={step === 0} onClick={() => setStep(step - 1)}>Back</AdminButton>
              {step < STEPS.length - 1 ? (
                <AdminButton disabled={!stepOk(step)} title={stepOk(step) ? undefined : "Fix the items listed above to continue"} onClick={() => setStep(step + 1)}>Next</AdminButton>
              ) : null}
            </div>
            <div className="flex gap-2">
              {id ? <AdminButton variant="ghost" onClick={() => setConfirmDelete(true)}>Delete draft</AdminButton> : null}
              <AdminButton variant="primary" loading={busy === "save"} onClick={() => void save()}>Save draft</AdminButton>
            </div>
          </div>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <AdminCard title="Audience">
            {!estimate ? <p className="text-xs text-admin-muted">Counting…</p> : (
              <div className="text-xs">
                <p className="text-2xl font-semibold text-admin-ink tabular-nums">{estimate.messages}</p>
                <p className="text-admin-muted">messages to send</p>
                <ul className="mt-3 flex flex-col gap-1">
                  <li className="flex justify-between"><span className="text-admin-muted">Customers matching</span><span className="tabular-nums">{estimate.matching}</span></li>
                  {form.channels.map((c) => (
                    <li key={c} className="flex justify-between"><span className="text-admin-muted">{CHANNEL_LABELS[c]} (opted in)</span><span className="tabular-nums">{estimate.channels[c] ?? 0}</span></li>
                  ))}
                </ul>
                <p className="mt-3 text-[0.6875rem] text-admin-muted">Customers who haven&rsquo;t agreed to marketing on a channel, or can&rsquo;t be reached on it, are left out automatically.</p>
                {nobodyOptedIn ? <p className="mt-2 text-[0.6875rem] font-medium text-[#8a5a12]">Nobody here has opted in yet, so there&rsquo;s no one to send to.</p> : null}
              </div>
            )}
          </AdminCard>
        </aside>
      </div>

      <ConfirmDialog open={confirming} onOpenChange={setConfirming} destructive={false} loading={busy === "launch"}
        title={schedule === "later" ? "Schedule this campaign?" : "Send this campaign now?"} confirmLabel={schedule === "later" ? "Schedule" : `Send ${estimate?.messages ?? ""} messages`}
        message={<span>This sends <strong>{estimate?.messages}</strong> messages ({form.channels.map((c) => `${CHANNEL_LABELS[c]} ${estimate?.channels[c] ?? 0}`).join(", ")}) to customers who opted in. It can&rsquo;t be unsent once it goes.</span>}
        onConfirm={() => void launch()} />
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this draft?" message="It hasn't been sent, so nothing else is affected."
        onConfirm={async () => { if (!id) return; try { await deleteCampaign(id); router.replace("/admin/marketing/campaigns"); } catch (e) { toast.error(problem(e, "It wasn't deleted.")); } }} />
    </div>
  );
}

function CampaignPreview({ id }: { id: number }) {
  const preview = useAdminResource(() => previewCampaign(id), [id]);
  const [channel, setChannel] = useState<Channel>("email");
  const data = preview.data;
  const channels = useMemo(() => (data ? (Object.keys(data) as Channel[]) : []), [data]);
  if (!data) return null;
  const shown = channels.includes(channel) ? channel : channels[0];
  const item = shown ? (data[shown] as Record<string, unknown>) : null;
  return (
    <AdminCard title="Preview (saved draft, sample customer)" action={<AdminButton size="sm" variant="ghost" onClick={() => void preview.reload()}>Refresh</AdminButton>}>
      <StatusTabs label="Channel" value={shown ?? ""} onChange={(v) => setChannel(v as Channel)} tabs={channels.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
      {!item ? null : item.problem ? <p className="text-xs text-[#a32424]">{String(item.problem)}</p> : shown === "email" ? (
        <div><p className="mb-2 text-xs text-admin-muted">Subject: <span className="text-admin-ink">{String(item.subject ?? "")}</span></p>
          <iframe title="Campaign email preview" sandbox="" srcDoc={String(item.html ?? "")} className="h-[30rem] w-full rounded-[3px] border border-admin-border bg-white" /></div>
      ) : (
        <pre className="whitespace-pre-wrap rounded-[3px] bg-admin-raised p-3 text-xs text-admin-ink">{JSON.stringify(item, null, 2)}</pre>
      )}
    </AdminCard>
  );
}

function rate(value: number | null) {
  return value === null ? "Not available" : `${value}%`;
}

function count(value: number | null) {
  return value === null ? "Not available for this channel" : String(value);
}

function CampaignResults({ campaign, onChanged }: { campaign: Campaign; onChanged: () => void }) {
  const router = useRouter();
  const [channel, setChannel] = useState("");
  const [page, setPage] = useState(1);
  const recipients = useAdminResource(() => listRecipients(campaign.id, { channel, page }), [campaign.id, channel, page]);
  const [cancelling, setCancelling] = useState(false);
  const analytics = campaign.analytics;
  const live = campaign.status === "sending" || campaign.status === "scheduled";

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(onChanged, 8000);
    return () => clearInterval(timer);
  }, [live, onChanged]);

  return (
    <div>
      <AdminPageHeader title={campaign.name} description={`${campaign.kindLabel} · ${campaign.channels.map((c) => CHANNEL_LABELS[c]).join(", ")}${campaign.scheduledAt ? ` · ${formatDateTime(campaign.scheduledAt)}` : ""}`}
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Campaigns", href: "/admin/marketing/campaigns" }, { label: campaign.name }]}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={STATUS[campaign.status].tone}>{STATUS[campaign.status].label}</Badge>
            {live ? <AdminButton size="sm" variant="danger" onClick={() => setCancelling(true)}>Cancel</AdminButton> : null}
            <AdminButton size="sm" onClick={async () => { const copy = await duplicateCampaign(campaign.id); router.push(`/admin/marketing/campaigns/detail?id=${copy.id}`); }}>
              <Copy className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Duplicate
            </AdminButton>
          </div>
        } />
      {campaign.lastError ? <p className="mb-4 rounded-[3px] bg-[#fbeaea] p-3 text-xs text-[#a32424]">{campaign.lastError}</p> : null}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Recipients" value={String(campaign.recipientsTotal)} />
        <Tile label="Orders from it" value={analytics ? String(analytics.revenue.orders) : "—"} hint="Within 7 days of a click, or with its coupon" />
        <Tile label="Revenue" value={analytics ? rupees(analytics.revenue.revenue) : "—"} />
        <Tile label="Launched" value={campaign.launchedAt ? formatDateTime(campaign.launchedAt) : "—"} />
      </div>
      {analytics?.notes.map((n) => <p key={n} className="mb-3 text-xs text-admin-muted">{n}</p>)}
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        {analytics ? (Object.entries(analytics.channels) as [Channel, ChannelFigures][]).map(([ch, f]) => (
          <AdminCard key={ch} title={CHANNEL_LABELS[ch]}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {([["Targeted", String(f.targeted)], ["Queued", String(f.queued)], ["Sent", String(f.sent)], ["Delivered", count(f.delivered)],
                ["Failed", String(f.failed)], ["Retrying", String(f.retrying)], ["Not sent", String(f.skipped)], ["Opened", count(f.opened)],
                ["Clicked", count(f.clicked)], ["Unsubscribed", count(f.unsubscribed)], ["Bounced", count(f.bounced)], ["Replied", count(f.replied)],
                ["Delivery rate", rate(f.rates.delivery)], ["Failure rate", rate(f.rates.failure)], ["Open rate", rate(f.rates.open)],
                ["Click rate", rate(f.rates.click)], ["Unsubscribe rate", rate(f.rates.unsubscribe)]] as [string, string][]).map(([label, value]) => (
                <div key={label} className="contents"><dt className="text-admin-muted">{label}</dt><dd className={cn("tabular-nums text-admin-ink", value.startsWith("Not") && "text-admin-faint")}>{value}</dd></div>
              ))}
            </dl>
          </AdminCard>
        )) : <p className="text-xs text-admin-muted">Results appear once it&rsquo;s sending.</p>}
      </div>
      <AdminCard title="Recipients" padded={false}>
        <div className="px-4 pt-3"><StatusTabs label="Channel" value={channel} onChange={(v) => { setChannel(v); setPage(1); }}
          tabs={[{ value: "", label: "All" }, ...campaign.channels.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))]} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-xs">
            <thead className="border-y border-admin-border bg-admin-raised text-admin-muted"><tr><th className={TH}>Customer</th><th className={TH}>Channel</th><th className={TH}>Status</th><th className={TH}>Opened</th><th className={TH}>Clicked</th><th className={TH}>Reason</th></tr></thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={6} loading={recipients.isLoading && !recipients.data} failed={Boolean(recipients.error && !recipients.data)}
                empty={Boolean(recipients.data && recipients.data.items.length === 0)} onRetry={() => void recipients.reload()} title="No recipients yet" hint="They're added as it sends." />
              {recipients.data?.items.map((r) => (
                <tr key={r.id}><td className={TD}>{r.customer.name}<span className="block text-admin-muted">{r.recipient}</span></td><td className={TD}>{CHANNEL_LABELS[r.channel]}</td>
                  <td className={TD}>{r.status}</td><td className={cn(TD, "text-admin-muted")}>{r.openedAt ? formatDateTime(r.openedAt) : "—"}</td>
                  <td className={cn(TD, "text-admin-muted")}>{r.clickedAt ? formatDateTime(r.clickedAt) : "—"}</td><td className={cn(TD, "text-[#a32424]")}>{r.error}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
      {recipients.data && recipients.data.pagination.total_pages > 1 ? (
        <div className="mt-2 flex justify-between"><AdminButton size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</AdminButton>
          <AdminButton size="sm" disabled={page >= recipients.data.pagination.total_pages} onClick={() => setPage(page + 1)}>Next</AdminButton></div>
      ) : null}
      <ConfirmDialog open={cancelling} onOpenChange={setCancelling} title="Cancel this campaign?" confirmLabel="Cancel campaign"
        message="Messages not yet sent won't go. Messages already sent can't be recalled."
        onConfirm={async () => { try { await cancelCampaign(campaign.id); toast.success("Campaign cancelled."); setCancelling(false); onChanged(); } catch (e) { toast.error(problem(e, "It wasn't cancelled.")); } }} />
    </div>
  );
}
