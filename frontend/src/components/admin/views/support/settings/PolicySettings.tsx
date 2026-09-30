"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import {
  reason,
  saveSupportSettings,
  type EscalationRule,
  type SupportSettings,
  type TicketPriority,
} from "@/services/supportService";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { toast } from "@/store/toastStore";

import { words, type TabProps } from "./shared";

const PRIORITIES: TicketPriority[] = ["low", "medium", "high", "urgent"];
const DAYS: [string, string][] = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];

/** A section of the settings document, edited as a draft and saved on its own. */
function useSection<K extends keyof SupportSettings>(settings: SupportSettings, keys: K[], reload: () => Promise<void>) {
  const pick = () => Object.fromEntries(keys.map((key) => [key, structuredClone(settings[key])])) as Pick<SupportSettings, K>;
  const [draft, setDraft] = useState(pick);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSupportSettings(draft);
      toast.success("Support settings saved.");
      await reload();
    } catch (cause) {
      setError(reason(cause, "The settings couldn't be saved."));
    } finally {
      setSaving(false);
    }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(pick());
  return { draft, setDraft, save, saving, error, dirty, reset: () => setDraft(pick()) };
}

function SaveBar({ onSave, saving, error, dirty, onReset }: { onSave: () => void; saving: boolean; error: string | null; dirty: boolean; onReset: () => void }) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-admin-border pt-4">
      {error ? (
        <p role="alert" className="mr-auto text-xs text-[#a32424]">
          {error}
        </p>
      ) : dirty ? (
        <p className="mr-auto text-xs text-admin-muted">Unsaved changes</p>
      ) : null}
      <AdminButton onClick={onReset} disabled={!dirty || saving}>
        Discard
      </AdminButton>
      <AdminButton variant="primary" onClick={onSave} loading={saving} disabled={!dirty}>
        Save changes
      </AdminButton>
    </div>
  );
}

/* ------------------------------------------------------ SLA and escalation */

export function SlaSettings({ config, reload }: TabProps) {
  const section = useSection(config.settings, ["sla", "slaWarningPercent", "escalation"], reload);
  const { draft, setDraft } = section;

  const setRule = (index: number, patch: Partial<EscalationRule>) =>
    setDraft({ ...draft, escalation: draft.escalation.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)) });

  return (
    <div className="flex flex-col gap-4">
      <AdminCard title="Response and resolution targets" description="Hours from when a request is raised. The clock pauses while a ticket waits on the customer.">
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[26rem] text-left text-xs">
            <thead className="text-admin-muted">
              <tr>
                <th className="pb-2 font-medium">Priority</th>
                <th className="pb-2 font-medium">First reply within (h)</th>
                <th className="pb-2 font-medium">Resolve within (h)</th>
              </tr>
            </thead>
            <tbody>
              {PRIORITIES.map((priority) => (
                <tr key={priority}>
                  <td className="py-1.5 pr-3 text-[0.8125rem] font-medium text-admin-ink">{words(priority)}</td>
                  {(["response", "resolve"] as const).map((field) => (
                    <td key={field} className="py-1.5 pr-3">
                      <input
                        type="number"
                        min={0.25}
                        step={0.25}
                        aria-label={`${words(priority)} ${field === "response" ? "first reply" : "resolution"} hours`}
                        value={draft.sla[priority][field]}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            sla: { ...draft.sla, [priority]: { ...draft.sla[priority], [field]: Number(event.target.value) } },
                          })
                        }
                        className="h-9 w-28 rounded-[3px] border border-admin-border bg-admin-surface px-2.5 text-[0.8125rem] tabular-nums text-admin-ink focus:border-copper-500"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <AdminInput
          className="mt-4 max-w-xs"
          label="Warn when this much of the time has gone (%)"
          type="number"
          min={10}
          max={95}
          value={String(draft.slaWarningPercent)}
          onChange={(event) => setDraft({ ...draft, slaWarningPercent: Number(event.target.value) })}
          hint="The handling agent is warned once, before the target is missed."
        />
      </AdminCard>

      <AdminCard
        title="Escalation rules"
        description="Checked every minute. Each rule fires once per ticket."
        action={
          <AdminButton
            size="sm"
            onClick={() =>
              setDraft({
                ...draft,
                escalation: [
                  ...draft.escalation,
                  { id: `rule-${Date.now()}`, label: "", when: "no-response", afterMinutes: 60, priorities: [], notify: "team-lead" },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add rule
          </AdminButton>
        }
      >
        {draft.escalation.length === 0 ? <p className="text-xs text-admin-muted">No escalation rules.</p> : null}
        <ul className="flex flex-col gap-3">
          {draft.escalation.map((rule, index) => (
            <li key={rule.id} className="rounded-[3px] border border-admin-border p-3">
              <FormGrid columns={3}>
                <AdminInput label="Name" value={rule.label} maxLength={120} onChange={(e) => setRule(index, { label: e.target.value })} placeholder="e.g. Urgent with no reply" />
                <AdminSelect
                  label="When"
                  value={rule.when}
                  onChange={(e) => setRule(index, { when: e.target.value })}
                  options={[
                    { value: "no-response", label: "No first reply yet" },
                    { value: "sla-breached", label: "Target missed" },
                    { value: "unresolved", label: "Still unresolved" },
                  ]}
                />
                <AdminInput
                  label={rule.when === "sla-breached" ? "Minutes after the target" : "Minutes after raised"}
                  type="number"
                  min={0}
                  value={String(rule.afterMinutes)}
                  onChange={(e) => setRule(index, { afterMinutes: Math.max(0, Number(e.target.value) || 0) })}
                />
                <AdminSelect
                  label="Tell"
                  value={rule.notify}
                  onChange={(e) => setRule(index, { notify: e.target.value })}
                  options={[
                    { value: "team-lead", label: "The team's leads" },
                    { value: "admins", label: "Admins" },
                    { value: "super-admins", label: "Super admins" },
                  ]}
                />
              </FormGrid>
              <div className="mt-3 flex flex-wrap items-center gap-x-4">
                <span className="text-xs text-admin-muted">Applies to:</span>
                {PRIORITIES.map((priority) => (
                  <AdminCheckbox
                    key={priority}
                    label={words(priority)}
                    checked={rule.priorities.includes(priority)}
                    onChange={(event) =>
                      setRule(index, {
                        priorities: event.target.checked ? [...rule.priorities, priority] : rule.priorities.filter((p) => p !== priority),
                      })
                    }
                  />
                ))}
                <span className="text-[0.6875rem] text-admin-faint">(none ticked = every priority)</span>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, escalation: draft.escalation.filter((_, at) => at !== index) })}
                  className="ml-auto inline-flex items-center gap-1 rounded-[3px] px-2 py-1 text-xs text-[#a32424] hover:bg-[#fbeaea]"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
        <SaveBar onSave={() => void section.save()} saving={section.saving} error={section.error} dirty={section.dirty} onReset={section.reset} />
      </AdminCard>
    </div>
  );
}

/* ------------------------------------------------------------ hours & chat */

export function HoursSettings({ config, reload }: TabProps) {
  const section = useSection(config.settings, ["businessHours", "holidays", "chat"], reload);
  const { draft, setDraft } = section;
  const [holiday, setHoliday] = useState({ date: "", name: "" });

  return (
    <AdminCard title="Business hours & live chat" description="When the desk is open. Live chat is offered only while it is (if you choose), and only when someone linked to the portal is taking requests.">
      <AdminInput
        className="max-w-xs"
        label="Time zone"
        value={draft.businessHours.timezone}
        onChange={(e) => setDraft({ ...draft, businessHours: { ...draft.businessHours, timezone: e.target.value } })}
        hint="e.g. Asia/Kolkata"
      />
      <ul className="mt-4 flex flex-col divide-y divide-admin-border rounded-[3px] border border-admin-border">
        {DAYS.map(([key, label]) => {
          const span = draft.businessHours.days[key] ?? null;
          const setDay = (value: { open: string; close: string } | null) =>
            setDraft({ ...draft, businessHours: { ...draft.businessHours, days: { ...draft.businessHours.days, [key]: value } } });
          return (
            <li key={key} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="w-24 text-[0.8125rem] text-admin-ink">{label}</span>
              <AdminToggle label="Open" checked={span !== null} onChange={(on) => setDay(on ? { open: "09:00", close: "18:00" } : null)} />
              {span ? (
                <span className="flex items-center gap-2 text-xs text-admin-muted">
                  <input
                    type="time"
                    aria-label={`${label} opens`}
                    value={span.open}
                    onChange={(e) => setDay({ ...span, open: e.target.value })}
                    className="h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink"
                  />
                  to
                  <input
                    type="time"
                    aria-label={`${label} closes`}
                    value={span.close}
                    onChange={(e) => setDay({ ...span, close: e.target.value })}
                    className="h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink"
                  />
                </span>
              ) : (
                <span className="text-xs text-admin-faint">Closed</span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-5">
        <p className="text-xs font-medium text-admin-ink">Holidays</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {draft.holidays.map((entry) => (
            <li key={entry.date} className="flex items-center gap-2 rounded-[3px] border border-admin-border bg-admin-raised py-1 pl-2.5 pr-1 text-xs text-admin-ink">
              {entry.date}
              {entry.name ? ` · ${entry.name}` : ""}
              <button
                type="button"
                aria-label={`Remove ${entry.date}`}
                onClick={() => setDraft({ ...draft, holidays: draft.holidays.filter((h) => h.date !== entry.date) })}
                className="rounded-[3px] p-1 hover:bg-admin-border"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          ))}
          {draft.holidays.length === 0 ? <li className="text-xs text-admin-faint">None.</li> : null}
        </ul>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <AdminInput label="Date" type="date" value={holiday.date} onChange={(e) => setHoliday({ ...holiday, date: e.target.value })} />
          <AdminInput label="Name" value={holiday.name} maxLength={80} onChange={(e) => setHoliday({ ...holiday, name: e.target.value })} placeholder="e.g. Diwali" />
          <AdminButton
            size="md"
            disabled={!holiday.date || draft.holidays.some((h) => h.date === holiday.date)}
            onClick={() => {
              setDraft({ ...draft, holidays: [...draft.holidays, holiday].sort((a, b) => a.date.localeCompare(b.date)) });
              setHoliday({ date: "", name: "" });
            }}
          >
            Add holiday
          </AdminButton>
        </div>
      </div>

      <div className="mt-5 grid gap-3 border-t border-admin-border pt-4 sm:grid-cols-2">
        <AdminToggle label="Offer live chat" checked={draft.chat.enabled} onChange={(enabled) => setDraft({ ...draft, chat: { ...draft.chat, enabled } })} />
        <AdminToggle
          label="Only during business hours"
          checked={draft.chat.onlyInBusinessHours}
          onChange={(onlyInBusinessHours) => setDraft({ ...draft, chat: { ...draft.chat, onlyInBusinessHours } })}
        />
      </div>
      <SaveBar onSave={() => void section.save()} saving={section.saving} error={section.error} dirty={section.dirty} onReset={section.reset} />
    </AdminCard>
  );
}

/* ------------------------------------------------------------------ general */

export function GeneralSettings({ config, reload }: TabProps) {
  const section = useSection(
    config.settings,
    ["ticketPrefix", "defaultPriority", "defaultTeamId", "reopenDays", "autoCloseResolvedDays", "duplicateWindowDays", "attachments"],
    reload,
  );
  const { draft, setDraft } = section;
  const number = (value: string) => Number(value) || 0;

  return (
    <AdminCard title="General" description="Numbering, where unrouted requests go, and how long customers have to come back.">
      <FormGrid columns={3}>
        <AdminInput
          label="Request number prefix"
          value={draft.ticketPrefix}
          maxLength={6}
          onChange={(e) => setDraft({ ...draft, ticketPrefix: e.target.value.toUpperCase() })}
          hint={`Numbers look like ${draft.ticketPrefix || "DCZ"}-${new Date().getFullYear()}-000123.`}
        />
        <AdminSelect
          label="Default team"
          value={draft.defaultTeamId ? String(draft.defaultTeamId) : ""}
          onChange={(e) => setDraft({ ...draft, defaultTeamId: e.target.value ? Number(e.target.value) : null })}
          placeholder="None"
          options={config.teams.map((team) => ({ value: String(team.id), label: team.name }))}
          hint="For categories with no team, and teams switched off."
        />
        <AdminSelect
          label="Default priority"
          value={draft.defaultPriority}
          onChange={(e) => setDraft({ ...draft, defaultPriority: e.target.value as TicketPriority })}
          options={PRIORITIES.map((value) => ({ value, label: words(value) }))}
        />
        <AdminInput
          label="Customers can reopen for (days)"
          type="number"
          min={0}
          max={90}
          value={String(draft.reopenDays)}
          onChange={(e) => setDraft({ ...draft, reopenDays: number(e.target.value) })}
        />
        <AdminInput
          label="Close resolved requests after (days)"
          type="number"
          min={0}
          max={90}
          value={String(draft.autoCloseResolvedDays)}
          onChange={(e) => setDraft({ ...draft, autoCloseResolvedDays: number(e.target.value) })}
          hint="0 never closes them automatically."
        />
        <AdminInput
          label="Look for duplicates within (days)"
          type="number"
          min={0}
          max={365}
          value={String(draft.duplicateWindowDays)}
          onChange={(e) => setDraft({ ...draft, duplicateWindowDays: number(e.target.value) })}
          hint="Customers are shown an open request on the same topic."
        />
      </FormGrid>

      <p className="mt-6 text-xs font-medium text-admin-ink">Attachments</p>
      {!config.attachmentsEnabled ? (
        <p className="mt-1 text-[0.6875rem] text-[#8a5d00]">File storage isn&rsquo;t configured, so attachments are switched off on the contact page.</p>
      ) : null}
      <FormGrid columns={3} className="mt-2">
        <AdminInput
          label="Files per message"
          type="number"
          min={1}
          max={10}
          value={String(draft.attachments.maxFiles)}
          onChange={(e) => setDraft({ ...draft, attachments: { ...draft.attachments, maxFiles: number(e.target.value) } })}
        />
        <AdminInput
          label="Largest file (MB)"
          type="number"
          min={1}
          max={25}
          value={String(draft.attachments.maxSizeMb)}
          onChange={(e) => setDraft({ ...draft, attachments: { ...draft.attachments, maxSizeMb: number(e.target.value) } })}
        />
        <AdminInput
          label="Largest video (MB)"
          type="number"
          min={1}
          max={100}
          value={String(draft.attachments.maxVideoSizeMb)}
          onChange={(e) => setDraft({ ...draft, attachments: { ...draft.attachments, maxVideoSizeMb: number(e.target.value) } })}
        />
      </FormGrid>
      <SaveBar onSave={() => void section.save()} saving={section.saving} error={section.error} dirty={section.dirty} onReset={section.reset} />
    </AdminCard>
  );
}
