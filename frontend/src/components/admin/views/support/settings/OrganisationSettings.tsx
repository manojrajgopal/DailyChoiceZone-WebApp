"use client";

import { useState } from "react";

import type { SupportDepartment, SupportRole, SupportTeam } from "@/services/supportService";

import { AdminCard } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";

import { ActiveBadge, AddButton, ConfigTable, DeleteButton, EditButton, EditModal, saveRow, words, type TabProps } from "./shared";

const ASSIGNMENT_HELP: Record<string, string> = {
  manual: "Nobody is picked automatically; the team assigns each request.",
  "round-robin": "Each new request goes to the next available person in turn.",
  "least-active": "Each new request goes to whoever has the fewest open.",
};

/* -------------------------------------------------------------------- teams */

type TeamDraft = {
  name: string;
  departmentId: string;
  description: string;
  notifyEmail: string;
  assignment: string;
  customerSelectable: boolean;
  active: boolean;
  sortOrder: number;
};

export function TeamsSettings({ config, reload }: TabProps) {
  const [editing, setEditing] = useState<SupportTeam | "new" | null>(null);
  const [draft, setDraft] = useState<TeamDraft | null>(null);
  const patch = (next: Partial<TeamDraft>) => setDraft((current) => (current ? { ...current, ...next } : current));

  const open = (team: SupportTeam | "new") => {
    setDraft(
      team === "new"
        ? { name: "", departmentId: "", description: "", notifyEmail: "", assignment: "round-robin", customerSelectable: false, active: true, sortOrder: config.teams.length }
        : {
            name: team.name,
            departmentId: team.departmentId ? String(team.departmentId) : "",
            description: team.description,
            notifyEmail: team.notifyEmail,
            assignment: team.assignment,
            customerSelectable: team.customerSelectable,
            active: team.active,
            sortOrder: team.sortOrder,
          },
    );
    setEditing(team);
  };

  return (
    <AdminCard
      title="Teams"
      description="Where requests are routed. Each category sends its requests to a team; the team's people receive them."
      action={<AddButton onClick={() => open("new")}>Add team</AddButton>}
      padded={false}
    >
      <ConfigTable
        minWidth="46rem"
        headers={[
          { label: "Team" },
          { label: "Department" },
          { label: "Assignment" },
          { label: "People", align: "right" },
          { label: "Open", align: "right" },
          { label: "Status" },
          { label: "", align: "right" },
        ]}
      >
        {config.teams.map((team) => (
          <tr key={team.id} className="hover:bg-admin-raised">
            <td className="px-3 py-2.5">
              <p className="font-medium text-admin-ink">{team.name}</p>
              {team.notifyEmail ? <p className="text-admin-muted">Shared inbox: {team.notifyEmail}</p> : null}
            </td>
            <td className="px-3 py-2.5 text-admin-ink">{team.department || "—"}</td>
            <td className="px-3 py-2.5 text-admin-ink">{words(team.assignment)}</td>
            <td className="px-3 py-2.5 text-right tabular-nums">
              {team.activeAgents === 0 ? (
                <StatusBadge tone="warning">Nobody</StatusBadge>
              ) : (
                <span className="text-admin-ink">
                  {team.availableAgents}/{team.activeAgents}
                  <span className="text-admin-muted"> available</span>
                </span>
              )}
            </td>
            <td className="px-3 py-2.5 text-right tabular-nums text-admin-ink">{team.openTickets}</td>
            <td className="px-3 py-2.5">
              <ActiveBadge active={team.active} />
            </td>
            <td className="whitespace-nowrap px-3 py-2.5 text-right">
              <EditButton name={team.name} onClick={() => open(team)} />
              <DeleteButton list="teams" id={team.id} name={team.name} reload={reload} />
            </td>
          </tr>
        ))}
      </ConfigTable>
      {config.teams.some((team) => team.active && team.activeAgents === 0) ? (
        <p className="border-t border-admin-border px-4 py-3 text-[0.6875rem] text-admin-muted">
          A team with nobody in it still receives requests. Until someone is added they go to its shared inbox if it has
          one, otherwise to the super admins — so nothing goes unanswered.
        </p>
      ) : null}

      {draft ? (
        <EditModal
          open={editing !== null}
          onOpenChange={(next) => !next && setEditing(null)}
          title={editing === "new" ? "Add a team" : `Edit ${draft.name}`}
          onSave={() =>
            saveRow(
              "teams",
              { ...draft, departmentId: draft.departmentId ? Number(draft.departmentId) : null },
              editing === "new" || editing === null ? null : editing.id,
              reload,
              "Team",
            )
          }
        >
          <FormGrid columns={2}>
            <AdminInput label="Name" required value={draft.name} maxLength={80} onChange={(e) => patch({ name: e.target.value })} />
            <AdminSelect
              label="Department"
              value={draft.departmentId}
              onChange={(e) => patch({ departmentId: e.target.value })}
              placeholder="No department"
              options={config.departments.map((department) => ({ value: String(department.id), label: department.name }))}
            />
          </FormGrid>
          <AdminInput label="Description" value={draft.description} maxLength={255} onChange={(e) => patch({ description: e.target.value })} />
          <AdminSelect
            label="How requests are assigned"
            value={draft.assignment}
            onChange={(e) => patch({ assignment: e.target.value })}
            options={config.options.assignment.map((value) => ({ value, label: words(value) }))}
            hint={ASSIGNMENT_HELP[draft.assignment]}
          />
          <AdminInput
            label="Shared inbox (optional)"
            type="email"
            value={draft.notifyEmail}
            maxLength={255}
            onChange={(e) => patch({ notifyEmail: e.target.value })}
            hint="Also copied on new requests for this team, in addition to its people."
          />
          <AdminToggle
            label="Customers can choose this team"
            description="Offered where a category lets the customer pick who handles it."
            checked={draft.customerSelectable}
            onChange={(customerSelectable) => patch({ customerSelectable })}
          />
          <AdminToggle label="Active" checked={draft.active} onChange={(active) => patch({ active })} description="Off: requests routed here go to the default team." />
        </EditModal>
      ) : null}
    </AdminCard>
  );
}

/* ------------------------------------------------- departments and roles */

type SimpleRow = SupportDepartment | SupportRole;

function SimpleList({
  kind,
  rows,
  reload,
}: {
  kind: "departments" | "roles";
  rows: SimpleRow[];
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<SimpleRow | "new" | null>(null);
  const [draft, setDraft] = useState({ name: "", description: "", active: true, sortOrder: 0 });
  const singular = kind === "departments" ? "Department" : "Role";

  return (
    <AdminCard
      title={kind === "departments" ? "Departments" : "Roles"}
      description={
        kind === "departments" ? "The groups teams belong to — Engineering, Finance…" : "What each person does — Developer, Finance, Membership Manager…"
      }
      action={
        <AddButton
          onClick={() => {
            setDraft({ name: "", description: "", active: true, sortOrder: rows.length });
            setEditing("new");
          }}
        >
          Add {singular.toLowerCase()}
        </AddButton>
      }
      padded={false}
    >
      <ConfigTable minWidth="26rem" headers={[{ label: singular }, { label: kind === "departments" ? "Teams" : "People", align: "right" }, { label: "Status" }, { label: "", align: "right" }]}>
        {rows.map((row) => (
          <tr key={row.id} className="hover:bg-admin-raised">
            <td className="px-3 py-2.5">
              <p className="font-medium text-admin-ink">{row.name}</p>
              {row.description ? <p className="text-admin-muted">{row.description}</p> : null}
            </td>
            <td className="px-3 py-2.5 text-right tabular-nums text-admin-ink">{"teams" in row ? row.teams : row.agents}</td>
            <td className="px-3 py-2.5">
              <ActiveBadge active={row.active} />
            </td>
            <td className="whitespace-nowrap px-3 py-2.5 text-right">
              <EditButton
                name={row.name}
                onClick={() => {
                  setDraft({ name: row.name, description: row.description, active: row.active, sortOrder: row.sortOrder });
                  setEditing(row);
                }}
              />
              <DeleteButton list={kind} id={row.id} name={row.name} reload={reload} />
            </td>
          </tr>
        ))}
      </ConfigTable>

      <EditModal
        open={editing !== null}
        onOpenChange={(next) => !next && setEditing(null)}
        title={editing === "new" ? `Add a ${singular.toLowerCase()}` : `Edit ${draft.name}`}
        onSave={() => saveRow(kind, draft, editing === "new" || editing === null ? null : editing.id, reload, singular)}
      >
        <AdminInput label="Name" required value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <AdminInput label="Description" value={draft.description} maxLength={255} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <AdminInput
          label="Order"
          type="number"
          value={String(draft.sortOrder)}
          onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })}
        />
        <AdminToggle label="Active" checked={draft.active} onChange={(active) => setDraft({ ...draft, active })} />
      </EditModal>
    </AdminCard>
  );
}

export function DepartmentsRolesSettings({ config, reload }: TabProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SimpleList kind="departments" rows={config.departments} reload={reload} />
      <SimpleList kind="roles" rows={config.roles} reload={reload} />
    </div>
  );
}
