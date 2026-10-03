/**
 * The builder's working copy of segment rules, and the conversions to and
 * from the API's shape (docs/customer-segmentation.md §4 "Rules").
 *
 * Every row carries a `uid` so React can key it while rows are added and
 * removed; it never reaches the API. Validation here is the basic, friendly
 * first pass — the server is authoritative and its 422 message is shown too.
 */
import type {
  OperatorValueKind,
  RuleValue,
  SegmentCondition,
  SegmentField,
  SegmentFieldRegistry,
  SegmentMatch,
  SegmentRule,
} from "@/types/segments";

export interface DraftCondition {
  kind: "condition";
  uid: string;
  field: string;
  operator: string;
  value: RuleValue;
}

export interface DraftGroup {
  kind: "group";
  uid: string;
  match: SegmentMatch;
  rules: DraftCondition[];
}

export type DraftRule = DraftCondition | DraftGroup;

let counter = 0;
export const nextUid = () => `r${(counter += 1)}`;

export function fieldOf(registry: SegmentFieldRegistry | null, key: string): SegmentField | undefined {
  return registry?.fields.find((field) => field.key === key);
}

export function operatorKind(registry: SegmentFieldRegistry | null, key: string): OperatorValueKind {
  return registry?.operators.find((operator) => operator.key === key)?.value ?? "single";
}

/** A sensible empty value for a field and operator: the admin fills it in. */
export function emptyValue(field: SegmentField | undefined, kind: OperatorValueKind): RuleValue {
  if (kind === "none") return null;
  if (kind === "range") return [null, null];
  if (kind === "list") return [];
  if (kind === "days") return null;
  if (field?.type === "boolean") return true;
  return null;
}

export function newCondition(registry: SegmentFieldRegistry | null, fieldKey?: string): DraftCondition {
  const field = fieldKey ? fieldOf(registry, fieldKey) : registry?.fields[0];
  const operator = field?.operators[0] ?? "";
  return {
    kind: "condition",
    uid: nextUid(),
    field: field?.key ?? "",
    operator,
    value: emptyValue(field, operatorKind(registry, operator)),
  };
}

export function newGroup(registry: SegmentFieldRegistry | null): DraftGroup {
  return { kind: "group", uid: nextUid(), match: "any", rules: [newCondition(registry)] };
}

export function toDraft(rules: SegmentRule[]): DraftRule[] {
  return rules.map((rule) =>
    "rules" in rule && Array.isArray(rule.rules)
      ? {
          kind: "group" as const,
          uid: nextUid(),
          match: rule.match,
          rules: rule.rules.map((condition) => ({ kind: "condition" as const, uid: nextUid(), ...condition })),
        }
      : { kind: "condition" as const, uid: nextUid(), ...(rule as SegmentCondition) },
  );
}

/** Numbers typed into the form travel as numbers; dates and text as strings. */
function clean(condition: DraftCondition): SegmentCondition {
  return { field: condition.field, operator: condition.operator, value: condition.value };
}

export function toApi(rules: DraftRule[]): SegmentRule[] {
  return rules.map((rule) =>
    rule.kind === "group" ? { match: rule.match, rules: rule.rules.map(clean) } : clean(rule),
  );
}

export function conditionCount(rules: DraftRule[]): number {
  return rules.reduce((total, rule) => total + (rule.kind === "group" ? rule.rules.length : 1), 0);
}

const blank = (value: unknown) => value === null || value === undefined || value === "" || (typeof value === "number" && Number.isNaN(value));

/** What's wrong with one condition, in plain words, or "" when it's complete. */
export function conditionProblem(condition: DraftCondition, registry: SegmentFieldRegistry | null): string {
  const field = fieldOf(registry, condition.field);
  if (!field) return "Choose what to check.";
  if (!field.operators.includes(condition.operator)) return "Choose how to compare it.";
  const kind = operatorKind(registry, condition.operator);
  const value = condition.value;
  const numeric = field.type === "number" || field.type === "money";
  const inBounds = (entry: unknown) =>
    typeof entry !== "number" ||
    ((field.min === null || field.min === undefined || entry >= field.min) &&
      (field.max === null || field.max === undefined || entry <= field.max));

  if (kind === "none") return "";
  if (kind === "days") {
    if (blank(value)) return "Enter a number of days.";
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return "Use a whole number of days from 1 to 3650.";
    return "";
  }
  if (kind === "range") {
    const [low, high] = Array.isArray(value) ? value : [];
    if (blank(low) || blank(high)) return numeric ? "Enter both the lower and the upper value." : "Choose both dates.";
    if (numeric && Number(low) > Number(high)) return "Put the lower value first.";
    if (!numeric && String(low) > String(high)) return "Put the earlier date first.";
    if (numeric && (!inBounds(low) || !inBounds(high))) return `Use values from ${field.min ?? 0} to ${field.max}.`;
    return "";
  }
  if (kind === "list") {
    if (!Array.isArray(value) || value.length === 0) return "Add at least one value.";
    const limit = registry?.limits.maxListItems ?? 100;
    if (value.length > limit) return `Use at most ${limit} values.`;
    return "";
  }
  if (blank(value)) return field.type === "date" ? "Choose a date." : "Enter a value.";
  if (numeric && !inBounds(value)) return `Use a value from ${field.min ?? 0} to ${field.max}.`;
  if (field.type === "string" && String(value).trim().length > 120) return "Keep it under 120 characters.";
  return "";
}

/** Problems by row uid (a group's own problem is under its uid), plus the whole-form ones. */
export function validateRules(
  rules: DraftRule[],
  registry: SegmentFieldRegistry | null,
): { rows: Record<string, string>; form: string[] } {
  const rows: Record<string, string> = {};
  const form: string[] = [];
  for (const rule of rules) {
    if (rule.kind === "group") {
      if (!rule.rules.length) rows[rule.uid] = "A group needs at least one condition.";
      for (const condition of rule.rules) {
        const problem = conditionProblem(condition, registry);
        if (problem) rows[condition.uid] = problem;
      }
    } else {
      const problem = conditionProblem(rule, registry);
      if (problem) rows[rule.uid] = problem;
    }
  }
  const limit = registry?.limits.maxConditions ?? 30;
  if (conditionCount(rules) > limit) form.push(`Use at most ${limit} conditions in all.`);
  return { rows, form };
}

/** The uid of the row the server's `details.path` points at. */
export function uidAt(rules: DraftRule[], path: number[] | null): string | null {
  if (!path?.length) return null;
  const top = rules[path[0]!];
  if (!top) return null;
  if (top.kind === "group" && path.length > 1) return top.rules[path[1]!]?.uid ?? top.uid;
  return top.uid;
}
