"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { getSupportConfiguration } from "@/services/supportService";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";

import { CategorySettings } from "./settings/CategorySettings";
import { ArticleSettings, CannedSettings, TemplateSettings } from "./settings/ContentSettings";
import { DepartmentsRolesSettings, TeamsSettings } from "./settings/OrganisationSettings";
import { GeneralSettings, HoursSettings, SlaSettings } from "./settings/PolicySettings";
import { StaffSettings } from "./settings/StaffSettings";
import type { TabProps } from "./settings/shared";
import { NoSupportAccess, useSupportMe } from "./SupportDeskParts";

const TABS: { id: string; label: string; render: (props: TabProps) => React.ReactNode }[] = [
  { id: "routing", label: "Categories & routing", render: (props) => <CategorySettings {...props} /> },
  { id: "staff", label: "Staff", render: (props) => <StaffSettings {...props} /> },
  { id: "teams", label: "Teams", render: (props) => <TeamsSettings {...props} /> },
  { id: "org", label: "Departments & roles", render: (props) => <DepartmentsRolesSettings {...props} /> },
  { id: "sla", label: "SLA & escalation", render: (props) => <SlaSettings {...props} /> },
  { id: "hours", label: "Hours & chat", render: (props) => <HoursSettings {...props} /> },
  { id: "articles", label: "Help articles", render: (props) => <ArticleSettings {...props} /> },
  { id: "canned", label: "Saved replies", render: (props) => <CannedSettings {...props} /> },
  { id: "templates", label: "Email templates", render: (props) => <TemplateSettings {...props} /> },
  { id: "general", label: "General", render: (props) => <GeneralSettings {...props} /> },
];

/**
 * Support setup, for the super admin: who handles what, how fast, and what
 * customers and staff are told. Every setting here is a database row — the
 * API refuses anyone else, whatever this page shows.
 */
export function AdminSupportSettingsView() {
  const me = useSupportMe();
  const canConfigure = Boolean(me.data?.canConfigure);
  const config = useAdminResource(() => getSupportConfiguration(), [], { enabled: canConfigure });
  const [tab, setTab] = useState(TABS[0]!.id);

  const header = (
    <AdminPageHeader
      title="Support setup"
      description="Categories and routing, the people and teams who answer, SLAs and escalation, and every support email."
      breadcrumbs={[
        { label: "Admin", href: "/admin/dashboard" },
        { label: "Support", href: "/admin/support" },
        { label: "Setup" },
      ]}
      actions={
        <AdminButtonLink href="/admin/support" size="sm">
          Open the desk
        </AdminButtonLink>
      }
    />
  );

  if (me.isLoading || (canConfigure && config.isLoading)) {
    return (
      <div>
        {header}
        <div className="flex h-60 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading" />
        </div>
      </div>
    );
  }
  if (!canConfigure) {
    return (
      <div>
        {header}
        <NoSupportAccess configure />
      </div>
    );
  }
  if (config.error || !config.data) {
    return (
      <div>
        {header}
        <AdminCard>
          <div className="py-8 text-center">
            <p className="text-sm text-admin-ink">The support setup didn&rsquo;t load.</p>
            <AdminButton size="sm" className="mt-3" onClick={() => void config.reload()}>
              Try again
            </AdminButton>
          </div>
        </AdminCard>
      </div>
    );
  }

  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]!;
  const unstaffed = config.data.teams.filter((team) => team.active && team.activeAgents === 0).length;

  return (
    <div>
      {header}

      {config.data.agents.length === 0 ? (
        <div className="mb-4 rounded-[3px] border border-[#fab219]/40 bg-[#fdf6e3] px-4 py-3 text-xs text-admin-ink">
          <span className="font-medium">No staff added yet.</span> Requests are routed to teams, but until you add the people in
          them, alerts go to super admins.{" "}
          <button type="button" onClick={() => setTab("staff")} className="font-medium text-copper-700 underline underline-offset-2">
            Add staff
          </button>
        </div>
      ) : unstaffed > 0 ? (
        <div className="mb-4 rounded-[3px] border border-admin-border bg-admin-raised px-4 py-3 text-xs text-admin-muted">
          {unstaffed} active {unstaffed === 1 ? "team has" : "teams have"} nobody in it yet.{" "}
          <button type="button" onClick={() => setTab("teams")} className="font-medium text-copper-700 underline underline-offset-2">
            Review teams
          </button>
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
        <nav aria-label="Setup sections" className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={tab === entry.id ? "page" : undefined}
              onClick={() => setTab(entry.id)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-[3px] px-3 py-2 text-left text-[0.8125rem] transition-colors",
                tab === entry.id ? "bg-admin-ink font-medium text-white" : "text-admin-muted hover:bg-admin-raised hover:text-admin-ink",
              )}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">{active.render({ config: config.data, reload: config.reload })}</div>
      </div>
    </div>
  );
}
