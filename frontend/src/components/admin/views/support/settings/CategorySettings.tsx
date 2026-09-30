"use client";

import { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";

import type { SupportCategory } from "@/services/supportService";

import { AdminCard } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { CATEGORY_ICON_NAMES, CategoryIcon } from "@/components/support/SupportParts";
import { cn } from "@/lib/utils/cn";

import { AddButton, DeleteButton, EditButton, EditModal, saveRow, words, type TabProps } from "./shared";

type Draft = {
  parentId: number | null;
  level: number;
  name: string;
  description: string;
  icon: string;
  contactType: string;
  form: string;
  teamId: string;
  priority: string;
  slaHours: number;
  customerChoice: string;
  choiceTeamIds: number[];
  active: boolean;
  sortOrder: number;
};

const LEVEL_NAMES = ["", "Category", "Option", "Issue"];

/**
 * The Category → Option → Issue tree the contact page walks, and where each
 * branch is routed. Routing is inherited: a node with no team of its own uses
 * its parent's, then the store default — so a whole branch is re-routed by
 * changing one row. Changes apply to the next request raised.
 */
export function CategorySettings({ config, reload }: TabProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ id: number | null; draft: Draft } | null>(null);
  const teams = new Map(config.teams.map((team) => [team.id, team]));

  const toggle = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openNew = (parent: SupportCategory | null) => {
    setEditing({
      id: null,
      draft: {
        parentId: parent?.id ?? null,
        level: parent ? parent.level + 1 : 1,
        name: "",
        description: "",
        icon: parent ? "" : "help",
        contactType: parent ? "" : "support",
        form: parent ? "" : "general",
        teamId: "",
        priority: parent ? "" : "medium",
        slaHours: 0,
        customerChoice: "",
        choiceTeamIds: [],
        active: true,
        sortOrder: parent ? parent.children.length : config.categories.length,
      },
    });
    if (parent) setExpanded((current) => new Set(current).add(parent.id));
  };

  const openEdit = (node: SupportCategory) =>
    setEditing({
      id: node.id,
      draft: {
        parentId: node.parentId,
        level: node.level,
        name: node.name,
        description: node.description,
        icon: node.icon,
        contactType: node.contactType,
        form: node.form,
        teamId: node.teamId ? String(node.teamId) : "",
        priority: node.priority,
        slaHours: node.slaHours,
        customerChoice: node.customerChoice,
        choiceTeamIds: node.choiceTeamIds,
        active: node.active,
        sortOrder: node.sortOrder,
      },
    });

  const patch = (next: Partial<Draft>) => setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...next } } : current));

  const renderNode = (node: SupportCategory, depth: number): React.ReactNode => {
    const open = expanded.has(node.id);
    const team = node.resolved.teamId ? teams.get(node.resolved.teamId) : null;
    return (
      <li key={node.id}>
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-admin-border py-2 pr-3 hover:bg-admin-raised",
            !node.active && "opacity-60",
          )}
          style={{ paddingLeft: `${0.75 + depth * 1.5}rem` }}
        >
          <button
            type="button"
            onClick={() => toggle(node.id)}
            disabled={node.children.length === 0}
            aria-expanded={node.children.length ? open : undefined}
            aria-label={node.children.length ? `${open ? "Collapse" : "Expand"} ${node.name}` : undefined}
            className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-admin-muted hover:bg-admin-border disabled:invisible"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
          </button>
          {node.level === 1 ? <CategoryIcon name={node.icon} className="h-4 w-4 text-copper-700" /> : null}
          <span className="min-w-[10rem] flex-1">
            <span className="text-[0.8125rem] font-medium text-admin-ink">{node.name}</span>
            {node.children.length ? <span className="ml-1.5 text-[0.6875rem] text-admin-faint">{node.children.length}</span> : null}
          </span>

          {/* Effective routing; faded where it is inherited rather than set here. */}
          <span className={cn("w-40 truncate text-xs", node.teamId ? "text-admin-ink" : "text-admin-faint")} title={node.teamId ? "Set here" : "Inherited"}>
            → {team ? team.name : "Default team"}
            {team && !team.active ? " (off)" : ""}
          </span>
          <span className={cn("w-32 whitespace-nowrap text-xs", node.form ? "text-admin-ink" : "text-admin-faint")}>{words(node.resolved.form)} form</span>
          <span className={cn("w-16 text-xs", node.priority ? "text-admin-ink" : "text-admin-faint")}>{words(node.resolved.priority)}</span>
          <span className="flex w-40 flex-wrap gap-1">
            {!node.active ? <StatusBadge tone="neutral">Off</StatusBadge> : null}
            {node.customerChoice === "team" || node.customerChoice === "agent" ? (
              <StatusBadge tone="info">Customer picks {node.customerChoice === "agent" ? "person" : "team"}</StatusBadge>
            ) : null}
            {node.slaHours ? <StatusBadge tone="neutral">{node.slaHours}h SLA</StatusBadge> : null}
          </span>
          <span className="ml-auto flex items-center whitespace-nowrap">
            {node.level < 3 ? (
              <button
                type="button"
                onClick={() => openNew(node)}
                className="rounded-[3px] p-1.5 text-admin-muted hover:bg-admin-raised hover:text-admin-ink"
                aria-label={`Add ${LEVEL_NAMES[node.level + 1]?.toLowerCase()} under ${node.name}`}
                title={`Add ${LEVEL_NAMES[node.level + 1]?.toLowerCase()}`}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            <EditButton name={node.name} onClick={() => openEdit(node)} />
            <DeleteButton list="categories" id={node.id} name={node.name} reload={reload} />
          </span>
        </div>
        {open && node.children.length ? <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul> : null}
      </li>
    );
  };

  const draft = editing?.draft;
  const inherit = (label: string) => ({ value: "", label: `Inherit (${label})` });

  return (
    <AdminCard
      title="Categories & routing"
      description="What customers choose on the contact page, and which team each choice reaches. Faded values are inherited from the level above."
      action={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              setExpanded((current) => (current.size ? new Set() : new Set(config.categories.flatMap((node) => [node.id, ...node.children.map((c) => c.id)]))))
            }
            className="text-xs text-admin-muted underline underline-offset-2 hover:text-admin-ink"
          >
            {expanded.size ? "Collapse all" : "Expand all"}
          </button>
          <AddButton onClick={() => openNew(null)}>Add category</AddButton>
        </div>
      }
      padded={false}
    >
      <div className="relative overflow-x-auto">
        <div className="min-w-[54rem]">
          <div className="flex gap-3 border-b border-admin-border bg-admin-raised py-2 pl-12 pr-3 text-[0.6875rem] font-medium text-admin-muted">
            <span className="min-w-[10rem] flex-1">Name</span>
            <span className="w-40">Routed to</span>
            <span className="w-32">Form</span>
            <span className="w-16">Priority</span>
            <span className="w-40" />
            <span className="w-24" />
          </div>
          <ul>{config.categories.map((node) => renderNode(node, 0))}</ul>
        </div>
      </div>

      {editing && draft ? (
        <EditModal
          open
          onOpenChange={(next) => !next && setEditing(null)}
          title={editing.id ? `Edit ${draft.name}` : `Add a ${LEVEL_NAMES[draft.level]?.toLowerCase()}`}
          description={
            draft.level === 1
              ? "A top-level category states its routing in full; options and issues under it inherit anything they leave blank."
              : "Leave a setting on Inherit to follow the level above."
          }
          wide
          onSave={() =>
            saveRow(
              "categories",
              { ...draft, teamId: draft.teamId ? Number(draft.teamId) : null },
              editing.id,
              reload,
              LEVEL_NAMES[draft.level] ?? "Category",
            )
          }
        >
          <FormGrid columns={2}>
            <AdminInput label="Name" required value={draft.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} />
            {draft.level === 1 ? (
              <AdminSelect
                label="Icon"
                value={draft.icon}
                onChange={(e) => patch({ icon: e.target.value })}
                options={CATEGORY_ICON_NAMES.map((name) => ({ value: name, label: words(name) }))}
              />
            ) : (
              <AdminInput label="Order" type="number" value={String(draft.sortOrder)} onChange={(e) => patch({ sortOrder: Number(e.target.value) || 0 })} />
            )}
          </FormGrid>
          <AdminInput
            label="Description"
            value={draft.description}
            maxLength={255}
            onChange={(e) => patch({ description: e.target.value })}
            hint="Shown under the name on the contact page."
          />

          <FormGrid columns={2}>
            <AdminSelect
              label="Routed to team"
              value={draft.teamId}
              onChange={(e) => patch({ teamId: e.target.value })}
              options={[
                draft.level === 1 ? { value: "", label: "Store default team" } : inherit("from above"),
                ...config.teams.map((team) => ({ value: String(team.id), label: `${team.name}${team.active ? "" : " (off)"}` })),
              ]}
            />
            <AdminSelect
              label="Priority"
              value={draft.priority}
              onChange={(e) => patch({ priority: e.target.value })}
              options={[
                ...(draft.level === 1 ? [] : [inherit("from above")]),
                ...config.options.priorities.map((value) => ({ value, label: words(value) })),
              ]}
            />
            <AdminSelect
              label="Form"
              value={draft.form}
              onChange={(e) => patch({ form: e.target.value })}
              options={[...(draft.level === 1 ? [] : [inherit("from above")]), ...config.options.forms.map((value) => ({ value, label: `${words(value)} form` }))]}
              hint="Which questions the contact page asks."
            />
            <AdminSelect
              label="Request type"
              value={draft.contactType}
              onChange={(e) => patch({ contactType: e.target.value })}
              options={[...(draft.level === 1 ? [] : [inherit("from above")]), ...config.options.contactTypes.map((value) => ({ value, label: words(value) }))]}
              hint="Feature requests get their own stages."
            />
            <AdminInput
              label="Resolution target (hours)"
              type="number"
              min={0}
              value={String(draft.slaHours)}
              onChange={(e) => patch({ slaHours: Math.max(0, Number(e.target.value) || 0) })}
              hint="0 uses the priority's target."
            />
            <AdminSelect
              label="Customer chooses who helps"
              value={draft.customerChoice}
              onChange={(e) => patch({ customerChoice: e.target.value })}
              options={[
                ...(draft.level === 1 ? [{ value: "", label: "No" }] : [inherit("from above"), { value: "none", label: "No" }]),
                { value: "team", label: "Yes — a team" },
                { value: "agent", label: "Yes — a named person" },
              ]}
            />
          </FormGrid>

          {draft.customerChoice === "team" || draft.customerChoice === "agent" ? (
            <fieldset className="rounded-[3px] border border-admin-border p-3">
              <legend className="px-1 text-xs font-medium text-admin-ink">Teams offered</legend>
              <p className="mb-2 text-[0.6875rem] text-admin-muted">
                {draft.customerChoice === "agent"
                  ? "Only people marked “Customers can choose them” in these teams are listed — by name and role, never by email."
                  : "The customer picks one of these teams."}
              </p>
              <div className="grid gap-1 sm:grid-cols-2">
                {config.teams.map((team) => (
                  <AdminCheckbox
                    key={team.id}
                    label={team.name}
                    checked={draft.choiceTeamIds.includes(team.id)}
                    onChange={(event) =>
                      patch({
                        choiceTeamIds: event.target.checked
                          ? [...draft.choiceTeamIds, team.id]
                          : draft.choiceTeamIds.filter((id) => id !== team.id),
                      })
                    }
                  />
                ))}
              </div>
            </fieldset>
          ) : null}

          <AdminToggle
            label="Shown on the contact page"
            description="Off hides it and everything under it. Past requests keep their category."
            checked={draft.active}
            onChange={(active) => patch({ active })}
          />
        </EditModal>
      ) : null}
    </AdminCard>
  );
}
