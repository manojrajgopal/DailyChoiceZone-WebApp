"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { FooterColumn, SiteConfig, SocialLink, TrustPoint } from "@/types";

import { AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import {
  AdminInput,
  AdminTextarea,
  FormGrid,
  FormSection,
} from "@/components/admin/ui/AdminForm";
import { RecordListEditor } from "@/components/admin/ui/RecordListEditor";
import {
  SettingsLayout,
  SettingsSaveBar,
  changed,
  useSettingsSection,
  type SettingsSection,
} from "@/components/admin/ui/SettingsLayout";
import { SOCIAL_ICON_NAMES } from "@/components/layout/Footer";
import { TRUST_ICON_NAMES } from "@/components/layout/TrustStrip";
import { useAdminResource } from "@/hooks/useAdminResource";
import { getSiteDocument, saveSiteDocument } from "@/services/admin/documentAdminService";
import { toast } from "@/store/toastStore";

/**
 * The site document: what the storefront's chrome is built from.
 *
 * The brand line, the support details, the social links, the reassurance strip
 * under the homepage and every column of the footer. All of it used to be a
 * JSON file in the frontend bundle, which meant retitling a footer column was
 * a deployment.
 *
 * The commercial numbers are **not** here even though the document carries
 * them: they are served from store settings, so the threshold a customer is
 * quoted is the one the cart prices against. Editing them twice in two places
 * is how two numbers come to disagree.
 */

/**
 * The icons each list can name.
 *
 * Derived from the components that draw them, so a dropdown cannot offer a
 * name that saves fine and then renders nothing.
 */
const TRUST_ICONS = TRUST_ICON_NAMES.map((value) => ({ value, label: value }));
const SOCIAL_ICONS = SOCIAL_ICON_NAMES.map((value) => ({ value, label: value }));

const SECTION_IDS = ["brand", "support", "trust", "social", "footer"];
const BRAND_KEYS = ["name", "tagline", "url", "locale", "description"] as const;

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;
}

export function AdminSiteSettingsView() {
  const { data, isLoading, reload } = useAdminResource(() => getSiteDocument(), []);

  const [draft, setDraft] = useState<SiteConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useSettingsSection(SECTION_IDS);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (isLoading || !draft) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading site settings" />
      </div>
    );
  }

  const onSave = async () => {
    if (draft.name.trim().length < 2) {
      setSection("brand");
      toast.error("Enter a store name — it is the first thing on every page.");
      return;
    }

    setSaving(true);
    const result = await saveSiteDocument(draft);
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success("Site settings saved");
    await reload();
  };

  const saved = data ?? draft;
  const sections: SettingsSection[] = [
    {
      id: "brand",
      label: "Brand",
      group: "Identity",
      dirty: changed(pick(draft, BRAND_KEYS), pick(saved, BRAND_KEYS)),
      content: (
        <FormSection title="Brand" description="How the store introduces itself.">
          <FormGrid>
            <AdminInput
              label="Store name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              required
            />
            <AdminInput
              label="Tagline"
              value={draft.tagline}
              onChange={(event) => setDraft({ ...draft, tagline: event.target.value })}
            />
            <AdminInput
              label="Public URL"
              type="url"
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              hint="Your store's web address, used by search engines."
            />
            <AdminInput
              label="Locale"
              value={draft.locale}
              onChange={(event) => setDraft({ ...draft, locale: event.target.value })}
              hint="Formats dates and numbers, e.g. en-IN."
            />
          </FormGrid>

          <AdminTextarea
            label="Description"
            rows={3}
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            hint="The search-result summary for the home page."
          />
        </FormSection>
      ),
    },
    {
      id: "support",
      label: "Customer support",
      group: "Identity",
      dirty: changed(draft.support, saved.support),
      content: (
        <FormSection title="Customer support" description="Where a customer is told to reach you — shown in the footer, on the contact page and in emails.">
          <FormGrid>
            <AdminInput
              label="Email"
              type="email"
              value={draft.support?.email ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, support: { ...draft.support, email: event.target.value } })
              }
            />
            <AdminInput
              label="Phone"
              value={draft.support?.phone ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, support: { ...draft.support, phone: event.target.value } })
              }
            />
            <AdminInput
              label="Hours"
              value={draft.support?.hours ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, support: { ...draft.support, hours: event.target.value } })
              }
              hint="Shown beside the number, e.g. Mon–Sat, 9am – 7pm."
            />
          </FormGrid>
        </FormSection>
      ),
    },
    {
      id: "trust",
      label: "Trust strip",
      group: "Storefront",
      count: (draft.trustPoints ?? []).length,
      dirty: changed(draft.trustPoints, saved.trustPoints),
      content: (
        <FormSection
          title="Trust strip"
          description="The reassurance row under the homepage rails."
     
        >
          <RecordListEditor<TrustPoint>
            rows={draft.trustPoints ?? []}
            onChange={(trustPoints) => setDraft({ ...draft, trustPoints })}
            title={(row) => row.title || "New point"}
            addLabel="Add a trust point"
            emptyMessage="No trust points. The strip is hidden until there is at least one."
            blank={() => ({ icon: "truck", title: "", text: "" })}
            fields={[
              { key: "title", label: "Title" },
              { key: "icon", label: "Icon", kind: "select", options: TRUST_ICONS },
              { key: "text", label: "Text", kind: "textarea" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "social",
      label: "Social links",
      group: "Storefront",
      count: (draft.social ?? []).length,
      dirty: changed(draft.social, saved.social),
      content: (
        <FormSection title="Social links" description="Shown in the footer.">
          <RecordListEditor<SocialLink>
            rows={draft.social ?? []}
            onChange={(social) => setDraft({ ...draft, social })}
            title={(row) => row.label || "New link"}
            addLabel="Add a social link"
            blank={() => ({ label: "", href: "", icon: "instagram" })}
            fields={[
              { key: "label", label: "Label" },
              { key: "icon", label: "Icon", kind: "select", options: SOCIAL_ICONS },
              { key: "href", label: "Address", span: "full" },
            ]}
          />
        </FormSection>
      ),
    },
    {
      id: "footer",
      label: "Footer",
      group: "Storefront",
      count: (draft.footer ?? []).length,
      dirty: changed(draft.footer, saved.footer),
      content: (
        <FormSection title="Footer" description="Each column, and the links in it.">
          <FooterEditor
            columns={draft.footer ?? []}
            onChange={(footer) => setDraft({ ...draft, footer })}
          />
        </FormSection>
      ),
    },
  ];

  return (
    <div>
      <AdminPageHeader
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Site" }]}
        title="Site"
        description="The brand line, support details, reassurance strip and footer the storefront renders."
      />

      <SettingsLayout label="Site settings sections" sections={sections} active={section} onChange={setSection} />

      <SettingsSaveBar
        dirtySections={sections.filter((entry) => entry.dirty).map((entry) => entry.label)}
        saving={saving}
        onSave={() => void onSave()}
        onDiscard={() => setDraft(data)}
        saveLabel="Save site settings"
      />
    </div>
  );
}

/**
 * Footer columns, each with its own list of links.
 *
 * Nested one level, which is why it is not a plain `RecordListEditor` — the
 * editor handles a list of records, and this is a list of records that each
 * contain a list.
 */
function FooterEditor({
  columns,
  onChange,
}: {
  columns: FooterColumn[];
  onChange: (columns: FooterColumn[]) => void;
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
        addLabel="Add a footer column"
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
