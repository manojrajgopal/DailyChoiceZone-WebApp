"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { NavColumn, NavItem } from "@/types";
import type { AdminNavGroup, AdminNavItem } from "@/types/admin";

import { AdminButton, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { FormSection } from "@/components/admin/ui/AdminForm";
import { ICON_NAMES } from "@/components/admin/layout/AdminIcons";
import { BADGE_NAMES } from "@/components/admin/layout/AdminSidebar";
import { RecordListEditor } from "@/components/admin/ui/RecordListEditor";
import { Tabs } from "@/components/ui/Tabs";
import { useAdminResource } from "@/hooks/useAdminResource";
import {
  getPortalMenu,
  getStorefrontMenu,
  savePortalMenu,
  saveStorefrontMenu,
} from "@/services/admin/documentAdminService";
import { toast } from "@/store/toastStore";

/**
 * The two menus.
 *
 * The storefront header and this portal's own sidebar, both stored as
 * documents and both editable here. They used to be JSON files in the frontend
 * bundle, on the argument that a menu entry names a route that has to exist —
 * which was true, and made reordering the shop's departments a deployment.
 *
 * That argument leaves one real obligation: **a link here can point nowhere.**
 * Nothing validates that `/category/hats` exists, because the server has no
 * list of the frontend's routes. The hints say so, and a bad link is a 404
 * rather than a broken build.
 *
 * Two tabs rather than two pages: they are the same job, and somebody
 * reorganising the shop usually touches both.
 */

export function AdminNavigationSettingsView() {
  return (
    <div>
      <AdminPageHeader
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Navigation" }]}
        title="Navigation"
        description="The storefront's header menu and this portal's sidebar."
      />

      <Tabs
        tabs={[
          { id: "storefront", label: "Storefront menu", content: <StorefrontMenuEditor /> },
          { id: "portal", label: "Portal sidebar", content: <PortalMenuEditor /> },
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------- storefront */

function StorefrontMenuEditor() {
  const { data, isLoading, reload } = useAdminResource(() => getStorefrontMenu(), []);

  const [draft, setDraft] = useState<NavItem[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (isLoading || !draft) return <Spinner label="Loading the storefront menu" />;

  const onSave = async () => {
    const unnamed = draft.find((item) => !item.label.trim() || !item.href.trim());
    if (unnamed) {
      toast.error("Every menu item needs a label and a path.");
      return;
    }

    setSaving(true);
    const result = await saveStorefrontMenu(draft);
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success("Storefront menu saved");
    await reload();
  };

  return (
    <div className="pb-20">
      <FormSection
        title="Departments"
        description="The top level of the header, left to right. Each can open a mega menu."
      >
        <RecordListEditor<{ id: string; label: string; href: string }>
          rows={draft.map(({ id, label, href }) => ({ id, label, href }))}
          onChange={(rows) =>
            setDraft(
              rows.map((row, index) => ({
                ...row,
                // The columns and promo card belong to the item, not the row
                // being edited — carried across so editing a label does not
                // silently drop a mega menu.
                columns: draft[index]?.columns,
                promo: draft[index]?.promo,
              })),
            )
          }
          title={(row) => row.label || "New department"}
          addLabel="Add a department"
          emptyMessage="No menu items. The header renders without a nav bar."
          blank={() => ({ id: `nav-${Date.now()}`, label: "", href: "" })}
          fields={[
            { key: "label", label: "Label" },
            { key: "href", label: "Path", hint: "Not checked — a path that does not exist is a 404." },
            { key: "id", label: "Identifier", span: "full", hint: "Must be unique." },
          ]}
        />
      </FormSection>

      {draft.map((item, index) => (
        <FormSection
          key={item.id || index}
          title={`“${item.label || `item ${index + 1}`}” mega menu`}
          description="Columns of links, shown when the department is opened on a wide screen. Leave empty for a plain link."
        >
          <MegaMenuEditor
            columns={item.columns ?? []}
            onChange={(columns) =>
              setDraft(
                draft.map((entry, i) =>
                  i === index
                    ? { ...entry, columns: columns.length > 0 ? columns : undefined }
                    : entry,
                ),
              )
            }
          />
        </FormSection>
      ))}

      <SaveBar
        saving={saving}
        onDiscard={() => setDraft(data)}
        onSave={() => void onSave()}
        label="Save storefront menu"
      />
    </div>
  );
}

function MegaMenuEditor({
  columns,
  onChange,
}: {
  columns: NavColumn[];
  onChange: (columns: NavColumn[]) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <RecordListEditor<{ heading: string }>
        rows={columns.map(({ heading }) => ({ heading }))}
        onChange={(rows) =>
          onChange(
            rows.map((row, index) => ({
              heading: row.heading,
              links: columns[index]?.links ?? [],
            })),
          )
        }
        title={(row) => row.heading || "New column"}
        addLabel="Add a column"
        emptyMessage="No columns — this department is a plain link."
        blank={() => ({ heading: "" })}
        fields={[{ key: "heading", label: "Column heading", span: "full" }]}
      />

      {columns.map((column, index) => (
        <div key={index} className="rounded-[3px] border border-admin-border bg-admin-plane p-3.5">
          <p className="mb-2.5 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
            Links in “{column.heading || `column ${index + 1}`}”
          </p>
          <RecordListEditor<{ label: string; href: string }>
            rows={column.links ?? []}
            onChange={(links) =>
              onChange(columns.map((entry, i) => (i === index ? { ...entry, links } : entry)))
            }
            title={(row) => row.label || "New link"}
            addLabel="Add a link"
            blank={() => ({ label: "", href: "" })}
            fields={[
              { key: "label", label: "Label" },
              { key: "href", label: "Path" },
            ]}
          />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ portal */

/**
 * The icons the sidebar can actually draw.
 *
 * Derived from the component map rather than typed out again, so the dropdown
 * cannot offer a name that renders as the fallback glyph.
 */
const SIDEBAR_ICONS = ICON_NAMES.map((value) => ({ value, label: value }));

/** The counts a link can show, from the sidebar's own set. */
const BADGES = [
  { value: "", label: "No badge" },
  ...BADGE_NAMES.map((value) => ({ value, label: value })),
];

function PortalMenuEditor() {
  const { data, isLoading, reload } = useAdminResource(() => getPortalMenu(), []);

  const [draft, setDraft] = useState<AdminNavGroup[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (isLoading || !draft) return <Spinner label="Loading the portal sidebar" />;

  const onSave = async () => {
    const empty = draft.find((group) => (group.items ?? []).length === 0);
    if (empty) {
      toast.error(`“${empty.heading || "A group"}” has no links. Remove it or add one.`);
      return;
    }

    setSaving(true);
    const result = await savePortalMenu(draft);
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success("Portal sidebar saved — reload to see it");
    await reload();
  };

  return (
    <div className="pb-20">
      <FormSection
        title="Groups"
        description="The headings down the sidebar, in order."
      >
        <RecordListEditor<{ id: string; heading: string }>
          rows={draft.map(({ id, heading }) => ({ id, heading }))}
          onChange={(rows) =>
            setDraft(
              rows.map((row, index) => ({
                ...row,
                items: draft[index]?.items ?? [],
              })),
            )
          }
          title={(row) => row.heading || "New group"}
          addLabel="Add a group"
          blank={() => ({ id: `group-${Date.now()}`, heading: "" })}
          fields={[
            { key: "heading", label: "Heading" },
            { key: "id", label: "Identifier", hint: "Must be unique." },
          ]}
        />
      </FormSection>

      {draft.map((group, index) => (
        <FormSection
          key={group.id || index}
          title={`Links under “${group.heading || `group ${index + 1}`}”`}
          description="A badge shows a live count beside the link."
        >
          <RecordListEditor<AdminNavItem>
            rows={group.items ?? []}
            onChange={(items) =>
              setDraft(draft.map((entry, i) => (i === index ? { ...entry, items } : entry)))
            }
            title={(row) => row.label || "New link"}
            addLabel="Add a link"
            blank={() => ({ id: `item-${Date.now()}`, label: "", href: "", icon: "products" })}
            fields={[
              { key: "label", label: "Label" },
              { key: "href", label: "Path", hint: "Must be a page this portal has." },
              { key: "icon", label: "Icon", kind: "select", options: SIDEBAR_ICONS },
              { key: "badge", label: "Badge", kind: "select", options: BADGES },
              { key: "id", label: "Identifier", span: "full", hint: "Must be unique." },
            ]}
          />
        </FormSection>
      ))}

      <SaveBar
        saving={saving}
        onDiscard={() => setDraft(data)}
        onSave={() => void onSave()}
        label="Save portal sidebar"
      />
    </div>
  );
}

/* ----------------------------------------------------------------- shared */

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label={label} />
    </div>
  );
}

function SaveBar({
  saving,
  onDiscard,
  onSave,
  label,
}: {
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
  label: string;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-admin-border bg-admin-surface/95 px-4 py-3 backdrop-blur-sm lg:left-60">
      <div className="flex items-center justify-end gap-2">
        <AdminButton variant="ghost" onClick={onDiscard}>
          Discard changes
        </AdminButton>
        <AdminButton variant="primary" loading={saving} onClick={onSave}>
          {label}
        </AdminButton>
      </div>
    </div>
  );
}
