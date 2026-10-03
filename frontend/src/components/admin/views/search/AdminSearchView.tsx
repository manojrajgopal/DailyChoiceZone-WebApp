"use client";

import { AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";

import { SearchAnalyticsPanel } from "./SearchAnalyticsPanel";
import { SearchSettingsPanel } from "./SearchSettingsPanel";
import { ADMIN_CRUMB } from "./shared";

const KEYS = ["tab", "range"] as const;

/** Marketing → Search: what shoppers search for, and how search behaves. */
export function AdminSearchView() {
  const { filters, setFilters } = useUrlFilters(KEYS);
  const tab = filters.tab === "settings" ? "settings" : "analytics";

  return (
    <div>
      <AdminPageHeader
        title="Search"
        description="What shoppers search for, which searches find nothing, and the popular searches and synonyms the store uses."
        breadcrumbs={[ADMIN_CRUMB, { label: "Search" }]}
      />

      <StatusTabs
        label="Search sections"
        value={tab}
        onChange={(next) => setFilters({ tab: next === "analytics" ? "" : next, range: filters.range })}
        tabs={[
          { value: "analytics", label: "Analytics" },
          { value: "settings", label: "Settings" },
        ]}
      />

      {tab === "analytics" ? (
        <SearchAnalyticsPanel range={filters.range} onRange={(range) => setFilters({ range: range === "30d" ? "" : range })} />
      ) : (
        <SearchSettingsPanel />
      )}
    </div>
  );
}
