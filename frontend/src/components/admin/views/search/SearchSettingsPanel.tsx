"use client";

import { useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { TagListInput } from "@/components/admin/ui/AdminForm";
import { LoadFailed, PageSkeleton } from "@/components/admin/views/suppliers/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { getSearchSettings, rebuildSearchIndex, saveSearchSettings } from "@/services/admin/searchAdminService";
import { toast } from "@/store/toastStore";
import type { PopularMode, SearchSettings } from "@/types/searchAdmin";

import { NoAccess, count, friendlyError, isForbidden } from "./shared";

const MAX_POPULAR = 20;
const MAX_GROUPS = 200;

export function SearchSettingsPanel() {
  const settings = useAdminResource(() => getSearchSettings(), []);
  const [version, setVersion] = useState(0);

  if (isForbidden(settings.error)) return <NoAccess permission="search" />;
  if (settings.error && !settings.data) {
    return <LoadFailed message="The search settings didn't load." onRetry={() => void settings.reload()} />;
  }
  if (!settings.data) return <PageSkeleton label="Loading search settings" />;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <SettingsForm
        // A fresh form for what the server now holds after a save.
        key={version}
        settings={settings.data}
        onSaved={async () => {
          await settings.reload();
          setVersion((current) => current + 1);
        }}
      />
      <RebuildCard settings={settings.data} onRebuilt={() => void settings.reload()} />
    </div>
  );
}

/** Synonym groups as editable text: one group per row, words separated by commas. */
function toRows(groups: string[][]): string[] {
  return groups.map((group) => group.join(", "));
}

function toGroups(rows: string[]): string[][] {
  return rows
    .map((row) => row.split(/[,=]/).map((word) => word.trim().toLowerCase()).filter(Boolean))
    .filter((group) => group.length > 0);
}

function SettingsForm({ settings, onSaved }: { settings: SearchSettings; onSaved: () => Promise<void> }) {
  const [mode, setMode] = useState<PopularMode>(settings.popularMode);
  const [popular, setPopular] = useState<string[]>(settings.popularSearches);
  const [rows, setRows] = useState<string[]>(() => toRows(settings.synonyms));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const validate = (): string => {
    if (popular.length > MAX_POPULAR) return `At most ${MAX_POPULAR} popular searches.`;
    if (popular.some((term) => term.length > 60)) return "A popular search is at most 60 characters.";
    const groups = toGroups(rows);
    if (groups.length > MAX_GROUPS) return `At most ${MAX_GROUPS} synonym groups.`;
    for (const group of groups) {
      if (group.length < 2) return `“${group[0]}” needs at least one other word to be a synonym of.`;
      if (group.length > 10) return "At most 10 words in a synonym group.";
      const long = group.find((word) => /\s/.test(word) || word.length > 40);
      if (long) return `“${long.slice(0, 40)}”: synonyms are single words of up to 40 characters.`;
    }
    return "";
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const problemText = validate();
    setError(problemText);
    if (problemText) return;
    setSaving(true);
    try {
      await saveSearchSettings({ popularMode: mode, popularSearches: popular, synonyms: toGroups(rows) });
      toast.success("Search settings saved");
      await onSaved();
    } catch (cause) {
      setError(friendlyError(cause, "The search settings weren't saved. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} noValidate className="flex flex-col gap-4">
      <AdminCard title="Popular searches" description="Suggested under the search box before a shopper types.">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Where popular searches come from</legend>
          {(
            [
              { value: "curated", label: "Curated", description: "The list below, in this order." },
              { value: "auto", label: "Automatic", description: "The most searched terms of the last 30 days that found something." },
            ] as const
          ).map((option) => (
            <label key={option.value} className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                name="popular-mode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => setMode(option.value)}
                className="mt-0.5 h-3.5 w-3.5 accent-copper-600"
              />
              <span>
                <span className="block text-[0.8125rem] text-admin-ink">{option.label}</span>
                <span className="block text-[0.6875rem] text-admin-muted">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className={cn("mt-4", mode === "auto" && "opacity-70")}>
          <TagListInput
            label="Curated popular searches"
            hint={`Up to ${MAX_POPULAR}. ${mode === "auto" ? "Kept for when you switch back to curated." : "Shown in this order."}`}
            values={popular}
            onChange={setPopular}
            placeholder="e.g. cotton kurta"
          />
        </div>

        {mode === "auto" ? (
          <div className="mt-4">
            <p className="text-xs font-medium text-admin-ink">Showing now</p>
            {settings.autoPopular.length > 0 ? (
              <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Automatic popular searches">
                {settings.autoPopular.map((term) => (
                  <li key={term} className="rounded-[3px] bg-admin-raised px-2 py-1 text-[0.6875rem] text-admin-ink ring-1 ring-inset ring-admin-border">
                    {term}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-admin-muted">
                Not enough searches yet; the curated list is shown until there are.
              </p>
            )}
          </div>
        ) : null}
      </AdminCard>

      <AdminCard
        title="Synonyms"
        description="Words that mean the same thing to shoppers. A search for any word in a group also finds the others."
      >
        {rows.length === 0 ? (
          <p className="mb-3 text-xs text-admin-muted">No synonym groups yet.</p>
        ) : (
          <ol className="mb-3 flex flex-col gap-2">
            {rows.map((row, index) => (
              <li key={index} className="flex items-center gap-2">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">Synonym group {index + 1}</span>
                  <input
                    value={row}
                    placeholder="e.g. tee, tshirt, t-shirt"
                    onChange={(event) => setRows(rows.map((entry, at) => (at === index ? event.target.value : entry)))}
                    className="h-9 w-full rounded-[3px] border border-admin-border bg-admin-surface px-2.5 text-[0.8125rem] text-admin-ink placeholder:text-admin-faint hover:border-admin-border-strong focus:border-copper-500"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setRows(rows.filter((_, at) => at !== index))}
                  aria-label={`Remove synonym group ${index + 1}`}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424]"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
        )}
        <AdminButton size="sm" onClick={() => setRows([...rows, ""])} disabled={rows.length >= MAX_GROUPS}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Add synonym group
        </AdminButton>
        <p className="mt-2 text-[0.6875rem] text-admin-muted">Separate the words with commas. Single words only.</p>
      </AdminCard>

      {error ? (
        <p role="alert" className="rounded-[3px] border border-[#f1c4c4] bg-[#fbeaea] px-3 py-2 text-xs text-[#a12b2b]">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <AdminButton type="submit" variant="primary" loading={saving}>
          Save search settings
        </AdminButton>
      </div>
    </form>
  );
}

function RebuildCard({ settings, onRebuilt }: { settings: SearchSettings; onRebuilt: () => void }) {
  const [running, setRunning] = useState(false);

  const rebuild = async () => {
    setRunning(true);
    try {
      const result = await rebuildSearchIndex();
      toast.success(`Search index rebuilt: ${count(result.products)} products, ${count(result.terms)} terms.`);
      onRebuilt();
    } catch (error) {
      toast.error(friendlyError(error, "The search index wasn't rebuilt. Please try again."));
    } finally {
      setRunning(false);
    }
  };

  return (
    <AdminCard title="Search index" description="Rebuilt every night. Rebuild now after a large import.">
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-[0.6875rem] text-admin-muted">Dictionary</dt>
          <dd className="mt-0.5 font-medium tabular-nums text-admin-ink">{count(settings.dictionarySize)} words</dd>
        </div>
        <div>
          <dt className="text-[0.6875rem] text-admin-muted">Last rebuilt</dt>
          <dd className="mt-0.5 text-admin-ink">{settings.lastRebuildAt ? formatDateTime(settings.lastRebuildAt) : "Never"}</dd>
        </div>
      </dl>
      <AdminButton className="mt-4" onClick={() => void rebuild()} loading={running}>
        {running ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
        Rebuild now
      </AdminButton>
    </AdminCard>
  );
}
