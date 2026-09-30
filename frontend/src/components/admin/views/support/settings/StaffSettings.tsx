"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import type { SupportAgent } from "@/services/supportService";

import { AdminCard } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";

import { ActiveBadge, AddButton, ConfigTable, DeleteButton, EditButton, EditModal, saveRow, type TabProps } from "./shared";

type Draft = {
  name: string;
  email: string;
  phone: string;
  photoUrl: string;
  roleId: string;
  teamId: string;
  specialization: string;
  adminUserId: string;
  active: boolean;
  available: boolean;
  isLead: boolean;
  showToCustomers: boolean;
  notifyEmail: boolean;
  notifyPortal: boolean;
};

const EMPTY: Draft = {
  name: "",
  email: "",
  phone: "",
  photoUrl: "",
  roleId: "",
  teamId: "",
  specialization: "",
  adminUserId: "",
  active: true,
  available: true,
  isLead: false,
  showToCustomers: false,
  notifyEmail: true,
  notifyPortal: true,
};

function toDraft(agent: SupportAgent): Draft {
  return {
    name: agent.name,
    email: agent.email,
    phone: agent.phone,
    photoUrl: agent.photoUrl,
    roleId: agent.roleId ? String(agent.roleId) : "",
    teamId: agent.teamId ? String(agent.teamId) : "",
    specialization: agent.specialization,
    adminUserId: agent.adminUserId ?? "",
    active: agent.active,
    available: agent.available,
    isLead: agent.isLead,
    showToCustomers: agent.showToCustomers,
    notifyEmail: agent.notifyEmail,
    notifyPortal: agent.notifyPortal,
  };
}

/**
 * The people who handle requests. This is where every staff address lives —
 * nothing in the code names anyone. Routing reaches people through their
 * team; customers only ever see a name, a role and a specialisation.
 */
export function StaffSettings({ config, reload }: TabProps) {
  const [editing, setEditing] = useState<SupportAgent | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [term, setTerm] = useState("");
  const [team, setTeam] = useState("");

  const open = (agent: SupportAgent | "new") => {
    setDraft(agent === "new" ? EMPTY : toDraft(agent));
    setEditing(agent);
  };
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  const rows = useMemo(() => {
    const text = term.trim().toLowerCase();
    return config.agents.filter(
      (agent) =>
        (!team || String(agent.teamId) === team) &&
        (!text || [agent.name, agent.email, agent.role, agent.team, agent.specialization].some((value) => value.toLowerCase().includes(text))),
    );
  }, [config.agents, term, team]);

  const departmentOf = (teamId: number | null) => config.teams.find((entry) => entry.id === teamId)?.department ?? "";
  const linked = new Set(config.agents.map((agent) => agent.adminUserId).filter(Boolean));

  return (
    <AdminCard
      title="Staff"
      description="Everyone who handles support requests. Emails go to the addresses here — never to anything written in code."
      action={<AddButton onClick={() => open("new")}>Add person</AddButton>}
      padded={false}
    >
      <div className="flex flex-wrap gap-2 border-b border-admin-border p-3">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search staff"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search name, email, role or specialisation"
            className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-surface pl-8 pr-2 text-xs text-admin-ink placeholder:text-admin-faint"
          />
        </div>
        <select
          aria-label="Filter by team"
          value={team}
          onChange={(event) => setTeam(event.target.value)}
          className="h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink"
        >
          <option value="">All teams</option>
          {config.teams.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </div>

      <ConfigTable
        minWidth="52rem"
        headers={[
          { label: "Person" },
          { label: "Role" },
          { label: "Team · department" },
          { label: "Portal" },
          { label: "Status" },
          { label: "Open", align: "right" },
          { label: "", align: "right" },
        ]}
        empty={
          rows.length === 0
            ? config.agents.length === 0
              ? "No staff yet. Add the people who answer requests — they receive their team's emails from the moment they're added."
              : "Nobody matches."
            : undefined
        }
      >
        {rows.map((agent) => (
          <tr key={agent.id} className="hover:bg-admin-raised">
            <td className="px-3 py-2.5">
              <p className="font-medium text-admin-ink">
                {agent.name}
                {agent.isLead ? <span className="ml-1.5 text-[0.625rem] font-normal text-copper-700">Lead</span> : null}
              </p>
              <p className="text-admin-muted">{agent.email}</p>
              {agent.specialization ? <p className="text-admin-faint">{agent.specialization}</p> : null}
            </td>
            <td className="px-3 py-2.5 text-admin-ink">{agent.role || "—"}</td>
            <td className="px-3 py-2.5">
              <p className="text-admin-ink">{agent.team || "No team"}</p>
              <p className="text-admin-muted">{departmentOf(agent.teamId)}</p>
            </td>
            <td className="px-3 py-2.5 text-admin-muted">{agent.adminUser ? agent.adminUser.name : "Email only"}</td>
            <td className="px-3 py-2.5">
              <div className="flex flex-wrap gap-1">
                <ActiveBadge active={agent.active} />
                {agent.active ? (
                  <StatusBadge tone={agent.available ? "info" : "neutral"}>{agent.available ? "Taking requests" : "Away"}</StatusBadge>
                ) : null}
                {agent.showToCustomers ? <StatusBadge tone="neutral">Shown to customers</StatusBadge> : null}
              </div>
            </td>
            <td className="px-3 py-2.5 text-right tabular-nums text-admin-ink">{agent.openTickets}</td>
            <td className="whitespace-nowrap px-3 py-2.5 text-right">
              <EditButton name={agent.name} onClick={() => open(agent)} />
              <DeleteButton list="agents" id={agent.id} name={agent.name} reload={reload} />
            </td>
          </tr>
        ))}
      </ConfigTable>

      <EditModal
        open={editing !== null}
        onOpenChange={(next) => !next && setEditing(null)}
        title={editing === "new" ? "Add a person" : `Edit ${draft.name || "person"}`}
        description="Customers never see this email address. They may see the name, role and specialisation where a category lets them choose who helps."
        wide
        onSave={() =>
          saveRow(
            "agents",
            {
              ...draft,
              roleId: draft.roleId ? Number(draft.roleId) : null,
              teamId: draft.teamId ? Number(draft.teamId) : null,
              adminUserId: draft.adminUserId || null,
            },
            editing === "new" || editing === null ? null : editing.id,
            reload,
            "Person",
          )
        }
      >
        <FormGrid columns={2}>
          <AdminInput label="Name" required value={draft.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} />
          <AdminInput
            label="Work email"
            type="email"
            required
            value={draft.email}
            maxLength={255}
            onChange={(e) => patch({ email: e.target.value })}
            hint="Where their request emails go."
          />
          <AdminSelect
            label="Team"
            value={draft.teamId}
            onChange={(e) => patch({ teamId: e.target.value })}
            placeholder="No team"
            options={config.teams.map((entry) => ({
              value: String(entry.id),
              label: `${entry.name}${entry.department ? ` · ${entry.department}` : ""}${entry.active ? "" : " (off)"}`,
            }))}
            hint="Decides which requests reach them."
          />
          <AdminSelect
            label="Role"
            value={draft.roleId}
            onChange={(e) => patch({ roleId: e.target.value })}
            placeholder="No role"
            options={config.roles.filter((role) => role.active || String(role.id) === draft.roleId).map((role) => ({ value: String(role.id), label: role.name }))}
          />
          <AdminInput
            label="Specialisation"
            value={draft.specialization}
            maxLength={160}
            onChange={(e) => patch({ specialization: e.target.value })}
            placeholder="e.g. Frontend, UPI payments"
          />
          <AdminInput label="Mobile" value={draft.phone} maxLength={14} onChange={(e) => patch({ phone: e.target.value })} hint="Optional" />
          <AdminSelect
            label="Portal account"
            value={draft.adminUserId}
            onChange={(e) => patch({ adminUserId: e.target.value })}
            placeholder="None — emails only"
            options={config.portalAccounts
              .filter((account) => !linked.has(account.id) || account.id === draft.adminUserId)
              .map((account) => ({ value: account.id, label: `${account.name} · ${account.email} (${account.role})` }))}
            hint="Linked, they can answer from the portal and see their team's tickets."
          />
          <AdminInput
            label="Photo (web address)"
            value={draft.photoUrl}
            maxLength={500}
            onChange={(e) => patch({ photoUrl: e.target.value })}
            placeholder="https://…"
          />
        </FormGrid>
        <div className="grid gap-3 border-t border-admin-border pt-4 sm:grid-cols-2">
          <AdminToggle label="Active" description="Off: no new requests or emails. Their history stays." checked={draft.active} onChange={(active) => patch({ active })} />
          <AdminToggle label="Taking requests" description="Off for leave or a full queue." checked={draft.available} onChange={(available) => patch({ available })} />
          <AdminToggle label="Team lead" description="Hears about escalations and urgent requests." checked={draft.isLead} onChange={(isLead) => patch({ isLead })} />
          <AdminToggle
            label="Customers can choose them"
            description="Listed by name where a category offers a choice."
            checked={draft.showToCustomers}
            onChange={(showToCustomers) => patch({ showToCustomers })}
          />
          <AdminToggle label="Email alerts" checked={draft.notifyEmail} onChange={(notifyEmail) => patch({ notifyEmail })} />
          <AdminToggle label="Portal alerts" checked={draft.notifyPortal} onChange={(notifyPortal) => patch({ notifyPortal })} />
        </div>
      </EditModal>
    </AdminCard>
  );
}
