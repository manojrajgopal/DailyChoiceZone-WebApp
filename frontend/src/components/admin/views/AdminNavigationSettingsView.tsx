"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { NavColumn, NavItem } from "@/types";
import type { AdminNavGroup, AdminNavItem } from "@/types/admin";

import { AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { FormSection } from "@/components/admin/ui/AdminForm";
import { ICON_NAMES } from "@/components/admin/layout/AdminIcons";
import { BADGE_NAMES } from "@/components/admin/layout/AdminSidebar";
import { RecordListEditor } from "@/components/admin/ui/RecordListEditor";
import {
  SettingsLayout,
  SettingsSaveBar,
  changed,
  useSettingsSection,
  type SettingsSection,
} from "@/components/admin/ui/SettingsLayout";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
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
 * reorganising the shop usually touches both. Within each, the top level is
 * one section and every department (or sidebar group) gets its own, so a
 * long menu is edited one drop-down at a time.
 */

const MENUS = [
  { id: "storefront", label: "Storefront menu", description: "The header on every storefront page." },
  { id: "portal", label: "Portal sidebar", description: "The menu down the left of this portal." },
] as const;

export function AdminNavigationSettingsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const menu = params.get("menu") === "portal" ? "portal" : "storefront";

  return (
    <div>
      <AdminPageHeader
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Navigation" }]}
        title="Navigation"
        description="The storefront's header menu and this portal's sidebar."
      />

      <div role="tablist" aria-label="Menus" className="mb-5 flex gap-5 border-b border-admin-border">
        {MENUS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={menu === entry.id}
            title={entry.description}
            onClick={() => router.replace(entry.id === "portal" ? `${pathname}?menu=portal` : pathname, { scroll: false })}
            className={cn(
              "-mb-px border-b-2 pb-2.5 text-sm font-medium transition-colors",
              menu === entry.id
                ? "border-copper-600 text-admin-ink"
                : "border-transparent text-admin-muted hover:text-admin-ink",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* Both stay mounted, so switching menus keeps unsaved edits in the other. */}
      <div hidden={menu !== "storefront"}>
        <StorefrontMenuEditor visible={menu === "storefront"} />
      </div>
      <div hidden={menu !== "portal"}>
        <PortalMenuEditor visible={menu === "portal"} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- storefront */

function StorefrontMenuEditor({ visible }: { visible: boolean }) {
  const { data, isLoading, reload } = useAdminResource(() => getStorefrontMenu(), []);

  const [draft, setDraft] = useState<NavItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const ids = ["departments", ...(draft ?? []).map((_, index) => `menu-${index + 1}`)];
  const [section, setSection] = useSettingsSection(ids, "department");

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (isLoading || !draft) return <Spinner label="Loading the storefront menu" />;
  const saved = data ?? draft;

  const onSave = async () => {
    const unnamed = draft.find((item) => !item.label.trim() || !item.href.trim());
    if (unnamed) {
      setSection("departments");
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

  const outline = (items: NavItem[]) => items.map(({ id, label, href }) => ({ id, label, href }));

  const sections: SettingsSection[] = [
    {
      id: "departments",
      label: "All departments",
      group: "Header",
      count: draft.length,
      dirty: changed(outline(draft), outline(saved)),
      content: (
        <FormSection
          title="Departments"
          description="The top level of the header, left to right. Reorder, rename or add one here; open a department in the menu to edit its drop-down."
        >
          <RecordListEditor<{ id: string; label: string; href: string }>
            rows={outline(draft)}
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
            emptyMessage="No menu items yet. The header menu stays hidden until you add one."
            blank={() => ({ id: `nav-${Date.now()}`, label: "", href: "" })}
            fields={[
              { key: "label", label: "Label" },
              { key: "href", label: "Path", hint: "Make sure this page exists, for example /shop/women." },
              { key: "id", label: "Identifier", span: "full", hint: "Must be different from the others." },
            ]}
          />
        </FormSection>
      ),
    },
    ...draft.map((item, index) => ({
      id: `menu-${index + 1}`,
      label: item.label || `Department ${index + 1}`,
      group: "Drop-down menus",
      count: (item.columns ?? []).length,
      dirty: changed(item.columns, saved[index]?.columns),
      content: (
        <FormSection
          title={`${item.label || `Department ${index + 1}`} — drop-down menu`}
          description={`Columns of links shown when “${item.label || "this department"}” is opened on a wide screen. Leave it empty for a plain link to ${item.href || "its page"}.`}
        >
          <MegaMenuEditor
            columns={item.columns ?? []}
            onChange={(columns) =>
              setDraft(
                draft.map((entry, i) =>
                  i === index ? { ...entry, columns: columns.length > 0 ? columns : undefined } : entry,
                ),
              )
            }
          />
        </FormSection>
      ),
    })),
  ];

  return (
    <>
      <SettingsLayout label="Storefront menu sections" sections={sections} active={section} onChange={setSection} />
      {visible ? (
        <SettingsSaveBar
          dirtySections={sections.filter((entry) => entry.dirty).map((entry) => entry.label)}
          saving={saving}
          onSave={() => void onSave()}
          onDiscard={() => setDraft(data)}
          saveLabel="Save storefront menu"
        />
      ) : null}
    </>
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

function PortalMenuEditor({ visible }: { visible: boolean }) {
  const { data, isLoading, reload } = useAdminResource(() => getPortalMenu(), []);

  const [draft, setDraft] = useState<AdminNavGroup[] | null>(null);
  const [saving, setSaving] = useState(false);
  const ids = ["groups", ...(draft ?? []).map((_, index) => `group-${index + 1}`)];
  const [section, setSection] = useSettingsSection(ids, "group");

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (isLoading || !draft) return <Spinner label="Loading the portal sidebar" />;
  const saved = data ?? draft;

  const onSave = async () => {
    const emptyAt = draft.findIndex((group) => (group.items ?? []).length === 0);
    if (emptyAt !== -1) {
      setSection(`group-${emptyAt + 1}`);
      toast.error(`“${draft[emptyAt]?.heading || "A group"}” has no links. Remove it or add one.`);
      return;
    }

    setSaving(true);
    const result = await savePortalMenu(draft);
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success("Sidebar saved. Refresh the page to see your changes.");
    await reload();
  };

  const outline = (groups: AdminNavGroup[]) => groups.map(({ id, heading }) => ({ id, heading }));

  const sections: SettingsSection[] = [
    {
      id: "groups",
      label: "All groups",
      group: "Sidebar",
      count: draft.length,
      dirty: changed(outline(draft), outline(saved)),
      content: (
        <FormSection
          title="Groups"
          description="The links the sidebar offers. The sidebar arranges the store's own pages into fixed groups and folders; labels, icons and badges set here still apply, and a link you add stays in the group you put it in."
        >
          <RecordListEditor<{ id: string; heading: string }>
            rows={outline(draft)}
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
              { key: "id", label: "Identifier", hint: "Must be different from the others." },
            ]}
          />
        </FormSection>
      ),
    },
    ...draft.map((group, index) => ({
      id: `group-${index + 1}`,
      label: group.heading || `Group ${index + 1}`,
      group: "Links",
      count: (group.items ?? []).length,
      dirty: changed(group.items, saved[index]?.items),
      content: (
        <FormSection
          title={`Links under “${group.heading || `group ${index + 1}`}”`}
          description="A badge shows a live count beside the link."
        >
          <RecordListEditor<AdminNavItem>
            rows={group.items ?? []}
            onChange={(items) => setDraft(draft.map((entry, i) => (i === index ? { ...entry, items } : entry)))}
            title={(row) => row.label || "New link"}
            addLabel="Add a link"
            blank={() => ({ id: `item-${Date.now()}`, label: "", href: "", icon: "products" })}
            fields={[
              { key: "label", label: "Label" },
              { key: "href", label: "Path", hint: "Must be a page in the admin portal." },
              { key: "icon", label: "Icon", kind: "select", options: SIDEBAR_ICONS },
              { key: "badge", label: "Badge", kind: "select", options: BADGES },
              { key: "id", label: "Identifier", span: "full", hint: "Must be different from the others." },
            ]}
          />
        </FormSection>
      ),
    })),
  ];

  return (
    <>
      <SettingsLayout label="Portal sidebar sections" sections={sections} active={section} onChange={setSection} />
      {visible ? (
        <SettingsSaveBar
          dirtySections={sections.filter((entry) => entry.dirty).map((entry) => entry.label)}
          saving={saving}
          onSave={() => void onSave()}
          onDiscard={() => setDraft(data)}
          saveLabel="Save portal sidebar"
        />
      ) : null}
    </>
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
