"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, FolderPlus, Plus, Trash2, X } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminTextarea, FormGrid } from "@/components/admin/ui/AdminForm";
import { IdMultiSelect } from "@/components/common/IdMultiSelect";
import { IdSelector } from "@/components/common/IdSelector";
import { useAdminResource } from "@/hooks/useAdminResource";
import { idLabel, type LookupEntity } from "@/lib/lookup/entities";
import { cn } from "@/lib/utils/cn";
import { ApiError } from "@/services/api/client";
import { createSegment, getSegment, getSegmentFields, previewSegment, updateSegment } from "@/services/segmentsService";
import { toast } from "@/store/toastStore";
import type {
  OperatorValueKind,
  RuleValue,
  SegmentDetail,
  SegmentField,
  SegmentFieldRegistry,
  SegmentMatch,
  SegmentPreview,
} from "@/types/segments";

import { MemberTable } from "./MemberTable";
import {
  type DraftCondition,
  type DraftGroup,
  type DraftRule,
  conditionCount,
  emptyValue,
  fieldOf,
  newCondition,
  newGroup,
  operatorKind,
  toApi,
  toDraft,
  uidAt,
  validateRules,
} from "./rules";
import {
  ADMIN_CRUMB,
  CONTROL,
  CUSTOMERS_CRUMB,
  LoadFailed,
  MatchToggle,
  PageSkeleton,
  SEGMENTS_CRUMB,
  SegmentsNoAccess,
  friendlyError,
  isForbidden,
  isNotFound,
  rulePath,
  segmentHref,
} from "./shared";

export const PREVIEW_DELAY_MS = 500;

/** `/admin/customers/segments/edit` (new) and `?id=3` (edit): the rule builder with a live preview. */
export function AdminSegmentBuilder() {
  const params = useSearchParams();
  const id = Number(params.get("id")) || null;
  const registry = useAdminResource(() => getSegmentFields(), []);
  const existing = useAdminResource(() => getSegment(id ?? 0), [id], { enabled: id !== null });

  const title = id ? "Edit segment" : "New segment";
  const crumbs = [ADMIN_CRUMB, CUSTOMERS_CRUMB, SEGMENTS_CRUMB, { label: id ? "Edit" : "New" }];

  if (isForbidden(registry.error) || isForbidden(existing.error)) {
    return (
      <div>
        <AdminPageHeader title={title} breadcrumbs={crumbs} />
        <SegmentsNoAccess />
      </div>
    );
  }
  if (id && isNotFound(existing.error)) {
    return (
      <div>
        <AdminPageHeader title={title} breadcrumbs={crumbs} />
        <LoadFailed message="That segment doesn't exist any more." onRetry={() => void existing.reload()} />
      </div>
    );
  }
  if (registry.error || (id && existing.error)) {
    return (
      <div>
        <AdminPageHeader title={title} breadcrumbs={crumbs} />
        <LoadFailed
          onRetry={() => {
            void registry.reload();
            if (id) void existing.reload();
          }}
        />
      </div>
    );
  }
  if (!registry.data || (id && !existing.data)) return <PageSkeleton label="Loading the segment builder" />;

  if (existing.data && !existing.data.actions.edit) {
    return (
      <div>
        <AdminPageHeader title={existing.data.name} breadcrumbs={crumbs} />
        <AdminCard>
          <p className="text-sm text-admin-ink">
            {existing.data.status === "archived"
              ? "This segment is archived. Restore it before changing its rules."
              : "This segment can't be edited."}
          </p>
          <AdminButtonLink href={segmentHref(existing.data.id)} size="sm" className="mt-3">
            Back to the segment
          </AdminButtonLink>
        </AdminCard>
      </div>
    );
  }

  return <SegmentForm key={existing.data?.id ?? "new"} registry={registry.data} segment={existing.data ?? null} />;
}

/* ------------------------------------------------------------------- form */

function SegmentForm({ registry, segment }: { registry: SegmentFieldRegistry; segment: SegmentDetail | null }) {
  const router = useRouter();
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [match, setMatch] = useState<SegmentMatch>(segment?.match ?? "all");
  const [rules, setRules] = useState<DraftRule[]>(() => toDraft(segment?.rules ?? []));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; uid: string | null; nameTaken: boolean } | null>(null);

  const problems = useMemo(() => validateRules(rules, registry), [rules, registry]);
  const rulesValid = Object.keys(problems.rows).length === 0 && problems.form.length === 0;
  const trimmedName = name.trim();
  const nameProblem = !trimmedName
    ? "Give the segment a name."
    : trimmedName.length < 2
      ? "Use at least 2 characters."
      : trimmedName.length > 120
        ? "Keep the name under 120 characters."
        : "";

  const preview = usePreview(match, rules, rulesValid);
  const limit = registry.limits.maxConditions;
  const total = conditionCount(rules);

  const edit = (next: DraftRule[]) => {
    setRules(next);
    setServerError(null);
  };
  const replace = (uid: string, next: DraftRule) => edit(rules.map((rule) => (rule.uid === uid ? next : rule)));
  const remove = (uid: string) => edit(rules.filter((rule) => rule.uid !== uid));

  const save = async () => {
    setSubmitted(true);
    if (nameProblem || !rulesValid) return;
    setSaving(true);
    setServerError(null);
    const payload = { name: trimmedName, description: description.trim(), match, rules: toApi(rules) };
    try {
      const saved = segment ? await updateSegment(segment.id, payload) : await createSegment(payload);
      toast.success(segment ? `${saved.name} saved` : `${saved.name} created`);
      router.push(segmentHref(saved.id));
    } catch (error) {
      setServerError({
        message: friendlyError(error, "The segment wasn't saved. Please try again."),
        uid: uidAt(rules, rulePath(error)),
        nameTaken: error instanceof ApiError && error.code === "SEGMENT_NAME_TAKEN",
      });
      setSaving(false);
    }
  };

  const rowProblem = (uid: string) =>
    serverError?.uid === uid ? serverError.message : submitted ? problems.rows[uid] : undefined;

  return (
    <div>
      <AdminPageHeader
        title={segment ? `Edit ${segment.name}` : "New segment"}
        description="Describe who belongs with rules. The preview shows who matches as you build."
        breadcrumbs={[ADMIN_CRUMB, CUSTOMERS_CRUMB, SEGMENTS_CRUMB, { label: segment ? segment.name : "New" }]}
      />

      {serverError && !serverError.nameTaken ? (
        <p role="alert" className="mb-4 flex gap-2 rounded-[3px] bg-[#fbeaea] p-3 text-xs text-[#a32424]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          {serverError.message}
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <AdminCard title="Details">
            <FormGrid>
              <AdminInput
                label="Name"
                required
                value={name}
                maxLength={120}
                onChange={(event) => {
                  setName(event.target.value);
                  if (serverError?.nameTaken) setServerError(null);
                }}
                error={serverError?.nameTaken ? serverError.message : submitted && nameProblem ? nameProblem : undefined}
                disabled={saving}
              />
              <AdminTextarea
                label="Description"
                rows={2}
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
                hint="For your team: what the segment is for."
                className="sm:col-span-2"
                disabled={saving}
              />
            </FormGrid>
          </AdminCard>

          <AdminCard
            title="Rules"
            description={`${total} of ${limit} conditions. One level of groups; an empty list matches every customer.`}
            action={<MatchToggle label="Match conditions" value={match} onChange={(next) => {
                  setMatch(next);
                  setServerError(null);
                }} disabled={saving} />}
          >
            <p className="mb-3 text-xs text-admin-muted">
              Customers must match <strong className="text-admin-ink">{match === "all" ? "every" : "at least one"}</strong> of these.
            </p>
            {rules.length === 0 ? (
              <p className="rounded-[3px] border border-dashed border-admin-border px-3 py-6 text-center text-xs text-admin-muted">
                No conditions yet: every customer matches. Add a condition to narrow it down.
              </p>
            ) : (
              <ol className="flex flex-col gap-2.5">
                {rules.map((rule) => {
                  if (rule.kind === "group") {
                    const groupLabel = `Group ${rules.filter((r) => r.kind === "group").indexOf(rule) + 1}`;
                    return (
                      <li key={rule.uid}>
                        <GroupBox
                          group={rule}
                          label={groupLabel}
                          registry={registry}
                          disabled={saving}
                          canAdd={total < limit}
                          problem={rowProblem(rule.uid)}
                          rowProblem={rowProblem}
                          onChange={(next) => replace(rule.uid, next)}
                          onRemove={() => remove(rule.uid)}
                        />
                      </li>
                    );
                  }
                  return (
                    <li key={rule.uid}>
                      <ConditionRow
                        condition={rule}
                        label={`Condition ${rules.filter((r) => r.kind !== "group").indexOf(rule) + 1}`}
                        registry={registry}
                        disabled={saving}
                        problem={rowProblem(rule.uid)}
                        onChange={(next) => replace(rule.uid, next)}
                        onRemove={() => remove(rule.uid)}
                      />
                    </li>
                  );
                })}
              </ol>
            )}
            {submitted && problems.form.length ? (
              <p role="alert" className="mt-2 text-[0.6875rem] text-[#c23434]">
                {problems.form.join(" ")}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <AdminButton size="sm" onClick={() => edit([...rules, newCondition(registry)])} disabled={saving || total >= limit}>
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Add condition
              </AdminButton>
              <AdminButton size="sm" variant="ghost" onClick={() => edit([...rules, newGroup(registry)])} disabled={saving || total >= limit}>
                <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Add group
              </AdminButton>
            </div>
          </AdminCard>

          <div className="flex flex-wrap justify-end gap-2">
            <AdminButtonLink href={segment ? segmentHref(segment.id) : "/admin/customers/segments"}>Cancel</AdminButtonLink>
            <AdminButton variant="primary" loading={saving} onClick={() => void save()}>
              {segment ? "Save segment" : "Create segment"}
            </AdminButton>
          </div>
        </div>

        <PreviewPanel preview={preview} rulesValid={rulesValid} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- preview */

type PreviewState =
  | { status: "loading"; data: SegmentPreview | null }
  | { status: "ready"; data: SegmentPreview }
  | { status: "error"; data: SegmentPreview | null; message: string };

/** The count and first page for the rules as they stand, ~500ms after the last change. */
function usePreview(match: SegmentMatch, rules: DraftRule[], valid: boolean): PreviewState {
  const key = JSON.stringify({ match, rules: toApi(rules) });
  const [state, setState] = useState<PreviewState>({ status: "loading", data: null });

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState((current) => ({ status: "loading", data: current.data }));
      const body = JSON.parse(key) as { match: SegmentMatch; rules: ReturnType<typeof toApi> };
      previewSegment(body, { page: 1, pageSize: 10 }, controller.signal)
        .then((data) => setState({ status: "ready", data }))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState((current) => ({
            status: "error",
            data: current.data,
            message: friendlyError(error, "The preview didn't load. Your rules are still here."),
          }));
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, valid]);

  return state;
}

function PreviewPanel({ preview, rulesValid }: { preview: PreviewState; rulesValid: boolean }) {
  const data = preview.data;
  return (
    <aside className="min-w-0 xl:sticky xl:top-24 xl:self-start">
      <AdminCard title="Live preview" description="Who matches right now. Nothing is saved." padded={false}>
        <div className="border-b border-admin-border px-4 py-3" aria-live="polite">
          {!rulesValid ? (
            <p className="text-xs text-admin-muted">Finish the conditions to see who matches.</p>
          ) : preview.status === "error" ? (
            <p role="alert" className="text-xs text-[#a32424]">
              {preview.message}
            </p>
          ) : data ? (
            <p className={cn("text-xs text-admin-muted", preview.status === "loading" && "opacity-60")}>
              <span className="block text-2xl font-semibold tabular-nums text-admin-ink" data-testid="preview-count">
                {data.count.toLocaleString("en-IN")}
              </span>
              {data.count === 1 ? "customer matches" : "customers match"}
            </p>
          ) : (
            <p className="text-xs text-admin-muted">Counting…</p>
          )}
        </div>
        {rulesValid && data && data.count > 0 ? (
          <>
            <MemberTable
              label="Matching customers"
              members={data.items}
              loading={false}
              failed={false}
              onRetry={() => undefined}
              refreshing={preview.status === "loading"}
              emptyTitle="Nobody matches"
              emptyHint="Loosen a condition to include more customers."
            />
            <p className="px-4 py-2 text-[0.6875rem] text-admin-muted">
              {data.count > data.items.length ? `First ${data.items.length} of ${data.count.toLocaleString("en-IN")}. ` : ""}
              {data.masked ? "Contact details are masked for your role." : ""}
            </p>
          </>
        ) : rulesValid && data && data.count === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-admin-muted">Nobody matches yet. Loosen a condition to include more customers.</p>
        ) : null}
      </AdminCard>
    </aside>
  );
}

/* ----------------------------------------------------------------- groups */

function GroupBox({
  group,
  label,
  registry,
  disabled,
  canAdd,
  problem,
  rowProblem,
  onChange,
  onRemove,
}: {
  group: DraftGroup;
  label: string;
  registry: SegmentFieldRegistry;
  disabled: boolean;
  canAdd: boolean;
  problem?: string;
  rowProblem: (uid: string) => string | undefined;
  onChange: (next: DraftGroup) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset className="rounded-[3px] border border-admin-border-strong bg-admin-raised/60 p-3">
      <legend className="sr-only">{label}</legend>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-admin-muted">
          <span className="font-medium text-admin-ink">{label}</span>
          <MatchToggle label={`${label} match`} value={group.match} onChange={(match) => onChange({ ...group, match })} disabled={disabled} />
        </div>
        <AdminButton size="sm" variant="ghost" onClick={onRemove} disabled={disabled} aria-label={`Remove ${label.toLowerCase()}`}>
          <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          Remove group
        </AdminButton>
      </div>
      <ol className="flex flex-col gap-2">
        {group.rules.map((condition, index) => (
          <li key={condition.uid}>
            <ConditionRow
              condition={condition}
              label={`${label} condition ${index + 1}`}
              registry={registry}
              disabled={disabled}
              problem={rowProblem(condition.uid)}
              onChange={(next) => onChange({ ...group, rules: group.rules.map((entry) => (entry.uid === condition.uid ? next : entry)) })}
              onRemove={() => onChange({ ...group, rules: group.rules.filter((entry) => entry.uid !== condition.uid) })}
            />
          </li>
        ))}
      </ol>
      {problem ? (
        <p role="alert" className="mt-2 text-[0.6875rem] text-[#c23434]">
          {problem}
        </p>
      ) : null}
      <AdminButton
        size="sm"
        variant="ghost"
        className="mt-2"
        onClick={() => onChange({ ...group, rules: [...group.rules, newCondition(registry)] })}
        disabled={disabled || !canAdd}
        aria-label={`Add condition to ${label.toLowerCase()}`}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Add condition to group
      </AdminButton>
    </fieldset>
  );
}

/* -------------------------------------------------------------- conditions */

function ConditionRow({
  condition,
  label,
  registry,
  disabled,
  problem,
  onChange,
  onRemove,
}: {
  condition: DraftCondition;
  label: string;
  registry: SegmentFieldRegistry;
  disabled: boolean;
  problem?: string;
  onChange: (next: DraftCondition) => void;
  onRemove: () => void;
}) {
  const field = fieldOf(registry, condition.field);
  const operators = registry.operators.filter((operator) => field?.operators.includes(operator.key));
  const kind = operatorKind(registry, condition.operator);

  const chooseField = (key: string) => {
    const next = fieldOf(registry, key);
    const operator = next?.operators.includes(condition.operator) ? condition.operator : (next?.operators[0] ?? "");
    onChange({ ...condition, field: key, operator, value: emptyValue(next, operatorKind(registry, operator)) });
  };
  const chooseOperator = (key: string) => {
    const nextKind = operatorKind(registry, key);
    onChange({ ...condition, operator: key, value: nextKind === kind ? condition.value : emptyValue(field, nextKind) });
  };

  return (
    <div
      className={cn(
        "rounded-[3px] border bg-admin-surface p-2.5",
        problem ? "border-[#c23434]" : "border-admin-border",
      )}
    >
      <div className="grid gap-2 md:grid-cols-[minmax(0,13rem)_minmax(0,11rem)_minmax(0,1fr)_auto] md:items-start">
        <select
          aria-label={`${label} field`}
          value={condition.field}
          onChange={(event) => chooseField(event.target.value)}
          disabled={disabled}
          className={cn(CONTROL, "cursor-pointer")}
        >
          {!field ? <option value="">Choose a field</option> : null}
          {registry.groups.map((group) => {
            const fields = registry.fields.filter((entry) => entry.group === group.key);
            if (!fields.length) return null;
            return (
              <optgroup key={group.key} label={group.label}>
                {fields.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>

        <select
          aria-label={`${label} operator`}
          value={condition.operator}
          onChange={(event) => chooseOperator(event.target.value)}
          disabled={disabled || !field}
          className={cn(CONTROL, "cursor-pointer")}
        >
          {operators.map((operator) => (
            <option key={operator.key} value={operator.key}>
              {operator.label}
            </option>
          ))}
        </select>

        <div className="min-w-0">
          {field ? (
            <ValueEditor
              key={`${field.key}:${kind}`}
              field={field}
              kind={kind}
              value={condition.value}
              label={label}
              disabled={disabled}
              onChange={(value) => onChange({ ...condition, value })}
            />
          ) : null}
        </div>

        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${label.toLowerCase()}`}
          className="inline-flex h-9 w-9 items-center justify-center justify-self-end rounded-[3px] text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {field?.description ? <p className="mt-1.5 text-[0.6875rem] text-admin-faint">{field.description}</p> : null}
      {problem ? (
        <p role="alert" className="mt-1.5 text-[0.6875rem] text-[#c23434]">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ values */

const toNumber = (text: string): number | null => (text === "" ? null : Number(text));

/**
 * Rule fields whose values are records: chosen by ID from the lookup
 * (docs/id-lookup.md), never typed or picked by name.
 */
const ENTITY_FIELDS: Record<string, LookupEntity> = {
  purchasedProducts: "product",
  purchasedCategories: "category",
  membershipPlan: "membership_plan",
};

/** The input(s) a value needs: by the operator's value kind first, then the field's type. */
function ValueEditor({
  field,
  kind,
  value,
  label,
  disabled,
  onChange,
}: {
  field: SegmentField;
  kind: OperatorValueKind;
  value: RuleValue;
  label: string;
  disabled: boolean;
  onChange: (value: RuleValue) => void;
}) {
  if (kind === "none") return null;

  const entity = ENTITY_FIELDS[field.key];
  if (entity && kind === "list") {
    const ids = Array.isArray(value) ? value.filter((entry): entry is string | number => entry !== null).map(String) : [];
    return (
      <IdMultiSelect
        entity={entity}
        label={`${label} ${idLabel(entity)}`}
        hideLabel
        values={ids}
        onChange={(next) => onChange(next)}
        disabled={disabled}
      />
    );
  }
  if (entity && kind === "single") {
    return (
      <IdSelector
        entity={entity}
        label={`${label} ${idLabel(entity)}`}
        hideLabel
        compact
        value={typeof value === "string" || typeof value === "number" ? String(value) : null}
        onChange={(id) => onChange(id)}
        disabled={disabled}
      />
    );
  }

  if (kind === "days") {
    return (
      <Suffixed suffix="days">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={3650}
          step={1}
          aria-label={`${label} days`}
          value={typeof value === "number" ? value : ""}
          onChange={(event) => onChange(toNumber(event.target.value))}
          disabled={disabled}
          className={cn(CONTROL, "pr-12")}
        />
      </Suffixed>
    );
  }

  if (kind === "range") {
    const pair = Array.isArray(value) ? value : [null, null];
    const set = (index: 0 | 1, entry: string | number | null) => {
      const next = [pair[0] ?? null, pair[1] ?? null];
      next[index] = entry;
      onChange(next);
    };
    return (
      <div className="flex items-center gap-1.5">
        <ScalarInput field={field} value={pair[0] ?? null} label={`${label} from`} disabled={disabled} onChange={(entry) => set(0, entry)} />
        <span className="shrink-0 text-xs text-admin-muted">and</span>
        <ScalarInput field={field} value={pair[1] ?? null} label={`${label} to`} disabled={disabled} onChange={(entry) => set(1, entry)} />
      </div>
    );
  }

  if (kind === "list") {
    const list = Array.isArray(value) ? value.filter((entry): entry is string | number => entry !== null) : [];
    if (field.options.length) {
      return <OptionChecklist field={field} values={list} label={`${label} values`} disabled={disabled} onChange={onChange} />;
    }
    return (
      <CommaListInput
        values={list.map(String)}
        label={`${label} values`}
        placeholder="Values, separated by commas"
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (field.type === "boolean") {
    return (
      <select
        aria-label={`${label} value`}
        value={value === false ? "false" : "true"}
        onChange={(event) => onChange(event.target.value === "true")}
        disabled={disabled}
        className={cn(CONTROL, "cursor-pointer")}
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  if ((field.type === "enum" || field.type === "list") && field.options.length) {
    return (
      <select
        aria-label={`${label} value`}
        value={value === null || value === undefined ? "" : String(value)}
        onChange={(event) => onChange(event.target.value || null)}
        disabled={disabled}
        className={cn(CONTROL, "cursor-pointer")}
      >
        <option value="">Choose…</option>
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <ScalarInput
      field={field}
      value={typeof value === "string" || typeof value === "number" ? value : null}
      label={`${label} value`}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

/** One number, amount, date or text, as the field's type wants it. */
function ScalarInput({
  field,
  value,
  label,
  disabled,
  onChange,
}: {
  field: SegmentField;
  value: string | number | null;
  label: string;
  disabled: boolean;
  onChange: (value: string | number | null) => void;
}) {
  if (field.type === "date") {
    return (
      <input
        type="date"
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value || null)}
        disabled={disabled}
        className={CONTROL}
      />
    );
  }
  if (field.type === "number" || field.type === "money") {
    const money = field.type === "money";
    const input = (
      <input
        type="number"
        inputMode={money ? "decimal" : "numeric"}
        step={money ? 0.01 : 1}
        min={field.min ?? undefined}
        max={field.max ?? undefined}
        aria-label={label}
        value={typeof value === "number" ? value : ""}
        onChange={(event) => onChange(toNumber(event.target.value))}
        disabled={disabled}
        className={cn(CONTROL, money && "pl-6")}
      />
    );
    if (!money) return input;
    return (
      <div className="relative min-w-0 flex-1">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[0.8125rem] text-admin-muted">
          {field.unit || "₹"}
        </span>
        {input}
      </div>
    );
  }
  return (
    <input
      type="text"
      aria-label={label}
      maxLength={120}
      value={value === null ? "" : String(value)}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      disabled={disabled}
      className={CONTROL}
    />
  );
}

function Suffixed({ suffix, children }: { suffix: string; children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-admin-muted">{suffix}</span>
    </div>
  );
}

/** Pick several of a field's options. */
function OptionChecklist({
  field,
  values,
  label,
  disabled,
  onChange,
}: {
  field: SegmentField;
  values: (string | number)[];
  label: string;
  disabled: boolean;
  onChange: (value: RuleValue) => void;
}) {
  const chosen = values.map(String);
  return (
    <div
      role="group"
      aria-label={label}
      className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-[3px] border border-admin-border bg-admin-surface p-1.5"
    >
      {field.options.map((option) => {
        const on = chosen.includes(String(option.value));
        return (
          <label
            key={option.value}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-[3px] px-2 py-1 text-xs ring-1 ring-inset",
              on ? "bg-copper-50 text-admin-ink ring-copper-300" : "text-admin-muted ring-admin-border hover:text-admin-ink",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <input
              type="checkbox"
              className="h-3 w-3 accent-copper-600"
              checked={on}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...values, option.value]
                    : values.filter((entry) => String(entry) !== String(option.value)),
                )
              }
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

/** Free-form values typed as "a, b, c", shown back as tags. */
function CommaListInput({
  values,
  label,
  placeholder,
  disabled,
  onChange,
}: {
  values: string[];
  label: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: RuleValue) => void;
}) {
  const [text, setText] = useState(values.join(", "));
  const parse = (raw: string) => [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
  const parsed = parse(text);
  return (
    <div>
      <input
        type="text"
        aria-label={label}
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          onChange(parse(event.target.value));
        }}
        disabled={disabled}
        className={CONTROL}
      />
      {parsed.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-1" aria-label={`${label} chosen`}>
          {parsed.map((entry) => (
            <li key={entry} className="rounded-[3px] bg-admin-raised px-1.5 py-0.5 text-[0.6875rem] text-admin-ink ring-1 ring-inset ring-admin-border">
              {entry}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
