"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput } from "@/components/admin/ui/AdminForm";
import { TD, TH, Tile } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { getSegmentationSettings, saveSegmentationSettings } from "@/services/segmentsService";
import { toast } from "@/store/toastStore";
import type { MetricsStatus, RfmLabelRule, SegmentationSettings } from "@/types/segments";

import {
  ADMIN_CRUMB,
  CONTROL,
  CUSTOMERS_CRUMB,
  LoadFailed,
  PageSkeleton,
  SEGMENTS_CRUMB,
  SegmentsNoAccess,
  friendlyError,
  isForbidden,
} from "./shared";

type BandKey = "recencyDays" | "frequencyOrders" | "monetaryRupees";

const BANDS: { key: BandKey; title: string; unit: string; prefix?: string; hint: string; scores: string[] }[] = [
  {
    key: "recencyDays",
    title: "Recency (days since the last order)",
    unit: "days",
    hint: "At most the first number of days scores 5, the second 4, and so on; anything older scores 1.",
    scores: ["5", "4", "3", "2"],
  },
  {
    key: "frequencyOrders",
    title: "Frequency (orders kept)",
    unit: "orders",
    hint: "At least the last number scores 5, the third 4, and so on; fewer than the first scores 1.",
    scores: ["2", "3", "4", "5"],
  },
  {
    key: "monetaryRupees",
    title: "Monetary (net spend)",
    unit: "₹",
    prefix: "₹",
    hint: "At least the last amount scores 5, the third 4, and so on; less than the first scores 1.",
    scores: ["2", "3", "4", "5"],
  },
];

const SCORES = [1, 2, 3, 4, 5];

/** `/admin/customers/segments/settings`: the RFM bands, the label map, and how fresh the metrics are. */
export function AdminSegmentSettingsView() {
  const settings = useAdminResource(() => getSegmentationSettings(), []);
  const crumbs = [ADMIN_CRUMB, CUSTOMERS_CRUMB, SEGMENTS_CRUMB, { label: "RFM settings" }];

  if (isForbidden(settings.error)) {
    return (
      <div>
        <AdminPageHeader title="RFM settings" breadcrumbs={crumbs} />
        <SegmentsNoAccess />
      </div>
    );
  }
  if (settings.error && !settings.data) {
    return (
      <div>
        <AdminPageHeader title="RFM settings" breadcrumbs={crumbs} />
        <LoadFailed onRetry={() => void settings.reload()} />
      </div>
    );
  }
  if (!settings.data) return <PageSkeleton label="Loading RFM settings" />;

  return <SettingsForm key={JSON.stringify(settings.data.settings)} initial={settings.data.settings} status={settings.data.status} />;
}

/** Plain-language problems with the settings, by field; the server checks again on save. */
export function settingsProblems(settings: SegmentationSettings): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const band of BANDS) {
    const values = settings[band.key];
    if (values.length !== 4 || values.some((value) => typeof value !== "number" || Number.isNaN(value))) {
      problems[band.key] = "Enter all four numbers.";
    } else if (values.some((value) => value <= 0)) {
      problems[band.key] = "Use numbers above zero.";
    } else if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
      problems[band.key] = "Each number must be bigger than the one before it.";
    }
  }
  const hours = settings.refreshHours;
  if (!Number.isInteger(hours) || hours < 1 || hours > 48) problems.refreshHours = "Use a whole number of hours from 1 to 48.";
  settings.labels.forEach((rule, index) => {
    const text = rule.label.trim();
    if (!text) problems[`labels.${index}`] = "Give the label a name.";
    else if (text.length > 40) problems[`labels.${index}`] = "Keep the label under 40 characters.";
    else if ([rule.r, rule.f, rule.m].some(([low, high]) => low > high)) problems[`labels.${index}`] = "Each minimum must be at most its maximum.";
  });
  return problems;
}

function SettingsForm({ initial, status }: { initial: SegmentationSettings; status: MetricsStatus }) {
  const [form, setForm] = useState<SegmentationSettings>(() => structuredClone(initial));
  const [current, setCurrent] = useState<MetricsStatus>(status);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");

  const problems = settingsProblems(form);
  const show = (key: string) => (submitted ? problems[key] : undefined);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const setBand = (key: BandKey, index: number, text: string) => {
    const next = [...form[key]];
    next[index] = text === "" ? Number.NaN : Number(text);
    setForm({ ...form, [key]: next });
    setServerError("");
  };
  const setLabel = (index: number, patch: Partial<RfmLabelRule>) => {
    setForm({ ...form, labels: form.labels.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)) });
    setServerError("");
  };

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(problems).length) return;
    setSaving(true);
    setServerError("");
    try {
      const saved = await saveSegmentationSettings({ ...form, labels: form.labels.map((rule) => ({ ...rule, label: rule.label.trim() })) });
      setForm(structuredClone(saved.settings));
      setCurrent(saved.status);
      setSubmitted(false);
      toast.success("RFM settings saved. Customers are re-scored and active segments recalculated.");
    } catch (error) {
      setServerError(friendlyError(error, "The settings weren't saved. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="RFM settings"
        description="How recency, frequency and spend turn into 1–5 scores, and which scores earn which label."
        breadcrumbs={[ADMIN_CRUMB, CUSTOMERS_CRUMB, SEGMENTS_CRUMB, { label: "RFM settings" }]}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Metrics status">
        <Tile label="Customers" value={current.customers.toLocaleString("en-IN")} />
        <Tile label="Metrics rows" value={current.metrics.toLocaleString("en-IN")} />
        <Tile label="Waiting to refresh" value={current.dirty.toLocaleString("en-IN")} tone={current.dirty ? "warn" : undefined} />
        <Tile label="Oldest refresh" value={current.oldestRefreshAt ? formatDateTime(current.oldestRefreshAt) : "Never"} />
        <Tile label="Newest refresh" value={current.newestRefreshAt ? formatDateTime(current.newestRefreshAt) : "Never"} />
      </div>

      {serverError ? (
        <p role="alert" className="mb-4 flex gap-2 rounded-[3px] bg-[#fbeaea] p-3 text-xs text-[#a32424]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          {serverError}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        <AdminCard title="Score bands" description="Four increasing thresholds per score.">
          <div className="grid gap-5 lg:grid-cols-3">
            {BANDS.map((band) => (
              <fieldset key={band.key} className="min-w-0">
                <legend className="mb-2 text-xs font-medium text-admin-ink">{band.title}</legend>
                <div className="grid grid-cols-4 gap-2">
                  {form[band.key].map((value, index) => (
                    <AdminInput
                      key={index}
                      label={`Score ${band.scores[index]}`}
                      aria-label={`${band.title} threshold ${index + 1}`}
                      type="number"
                      min={0}
                      step={band.key === "monetaryRupees" ? 0.01 : 1}
                      prefix={band.prefix}
                      value={Number.isNaN(value) ? "" : value}
                      onChange={(event) => setBand(band.key, index, event.target.value)}
                      disabled={saving}
                    />
                  ))}
                </div>
                {show(band.key) ? (
                  <p role="alert" className="mt-1.5 text-[0.6875rem] text-[#c23434]">
                    {show(band.key)}
                  </p>
                ) : (
                  <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-admin-muted">{band.hint}</p>
                )}
              </fieldset>
            ))}
          </div>
          <div className="mt-5 max-w-[14rem]">
            <AdminInput
              label="Refresh everyone every (hours)"
              type="number"
              min={1}
              max={48}
              step={1}
              value={Number.isNaN(form.refreshHours) ? "" : form.refreshHours}
              onChange={(event) => {
                setForm({ ...form, refreshHours: event.target.value === "" ? Number.NaN : Number(event.target.value) });
                setServerError("");
              }}
              error={show("refreshHours")}
              hint="Changed customers refresh within minutes; this is the full refresh."
              disabled={saving}
            />
          </div>
        </AdminCard>

        <AdminCard
          title="Labels"
          description="The first row whose three ranges all contain a customer's scores gives their label."
          padded={false}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-xs">
              <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                <tr>
                  <th className={TH}>Key</th>
                  <th className={TH}>Label</th>
                  <th className={TH}>Recency</th>
                  <th className={TH}>Frequency</th>
                  <th className={TH}>Monetary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-admin-border">
                {form.labels.map((rule, index) => (
                  <tr key={rule.key} className="align-top">
                    <td className={cn(TD, "font-mono text-admin-muted")}>{rule.key}</td>
                    <td className={TD}>
                      <input
                        aria-label={`Label for ${rule.key}`}
                        value={rule.label}
                        maxLength={40}
                        onChange={(event) => setLabel(index, { label: event.target.value })}
                        disabled={saving}
                        className={CONTROL}
                      />
                      {show(`labels.${index}`) ? (
                        <p role="alert" className="mt-1 text-[0.6875rem] text-[#c23434]">
                          {show(`labels.${index}`)}
                        </p>
                      ) : null}
                    </td>
                    {(["r", "f", "m"] as const).map((dimension) => (
                      <td key={dimension} className={TD}>
                        <RangePicker
                          label={`${rule.key} ${dimension.toUpperCase()}`}
                          value={rule[dimension]}
                          disabled={saving}
                          onChange={(range) => setLabel(index, { [dimension]: range })}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>

        <div className="flex flex-wrap justify-end gap-2">
          <AdminButtonLink href="/admin/customers/segments">Back to segments</AdminButtonLink>
          <AdminButton variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
            Save settings
          </AdminButton>
        </div>
      </div>
    </div>
  );
}

function RangePicker({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: [number, number];
  disabled: boolean;
  onChange: (value: [number, number]) => void;
}) {
  const select = (which: 0 | 1, text: string) => {
    const next: [number, number] = [value[0], value[1]];
    next[which] = Number(text);
    onChange(next);
  };
  return (
    <span className="flex items-center gap-1">
      <select aria-label={`${label} min`} value={value[0]} onChange={(event) => select(0, event.target.value)} disabled={disabled} className={cn(CONTROL, "w-14 cursor-pointer px-1.5")}>
        {SCORES.map((score) => (
          <option key={score} value={score}>
            {score}
          </option>
        ))}
      </select>
      <span className="text-admin-faint" aria-hidden="true">
        –
      </span>
      <select aria-label={`${label} max`} value={value[1]} onChange={(event) => select(1, event.target.value)} disabled={disabled} className={cn(CONTROL, "w-14 cursor-pointer px-1.5")}>
        {SCORES.map((score) => (
          <option key={score} value={score}>
            {score}
          </option>
        ))}
      </select>
    </span>
  );
}
